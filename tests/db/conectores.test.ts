import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { CtxFerramenta } from "@/lib/assistente/ferramentas";
import { ContextoAssistente, type Rpc } from "@/lib/assistente/tipos";
import { atenderMcp, type Autenticado, type DepsHttpMcp } from "@/lib/mcp/http";
import { recursoMcp } from "@/lib/oauth/config";
import { desafioPkce, hashSegredo, novoSegredo } from "@/lib/oauth/cripto";
import { emitirToken, registrarCliente, revogarToken } from "@/lib/oauth/endpoints";
import { criarBanco, criarUsuario, rpcComoServico } from "./banco";

const ANA = "00000000-0000-4000-8000-0000000000a1"; // dona
const BIA = "00000000-0000-4000-8000-0000000000a2"; // Lia + processos + prazos + tarefas
const ZE = "00000000-0000-4000-8000-0000000000a3"; // dono de outro escritório
const BASE = "https://app.law.test";
const RECURSO = recursoMcp(BASE);
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_CB = "https://chatgpt.com/connector_platform_oauth_redirect";

let db: PGlite;
let esc: string;
let proc: string, procSigilo: string;
let H: string;

const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const servico = () => rpcComoServico(db);
const LISTAS = new Set(["p_escopos", "p_modulos", "p_rascunhos", "p_sem_permissao"]);

/** Igual ao app: papel authenticated + JWT do usuário. canal = "mcp" simula o JWT que o servidor MCP emite. */
function rpcDe(uid: string, canal: "mcp" | null = null): Rpc {
  return async (funcao, args) => {
    const nomes = Object.keys(args);
    const valores = nomes.map((n) => {
      const v = args[n];
      if (v === undefined) return null;
      if (LISTAS.has(n)) return v;
      return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    });
    const sql = `select public.${funcao}(${nomes.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`;
    try {
      const r = await db.transaction(async (tx) => {
        await tx.exec("set local role authenticated");
        await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", ...(canal ? { law_canal: canal } : {}) })]);
        return tx.query<{ r: unknown }>(sql, valores);
      });
      return { data: r.rows[0].r, error: null };
    } catch (e) {
      const x = e as { message: string; code?: string; detail?: string };
      return { data: null, error: { message: x.message, code: x.code, details: x.detail ?? null } };
    }
  };
}
async function chamar<T>(uid: string, funcao: string, args: Record<string, unknown>, canal: "mcp" | null = null): Promise<T> {
  const r = await rpcDe(uid, canal)(funcao, args);
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}
const consultar = async <T,>(uid: string, sql: string, p: unknown[] = []) => db.transaction(async (tx) => {
  await tx.exec("set local role authenticated");
  await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
  return (await tx.query<T>(sql, p)).rows;
});

/** Dependências do servidor MCP iguais às de produção, trocando só o Supabase pelo Postgres embutido. */
function depsMcp(): DepsHttpMcp {
  return {
    base: BASE,
    origens: [],
    autenticar: (hash) => servico()<Autenticado>("mcp_autenticar", { p_acesso_hash: hash, p_limite_minuto: 60, p_limite_dia: 2000 }),
    sessao: (a, base) => ({
      escopos: a.escopos, base,
      ctx: async (): Promise<CtxFerramenta> => {
        const rpc = rpcDe(a.usuario_id, "mcp");
        const c = await rpc("assistente_contexto", { p_escritorio: a.escritorio_id });
        if (c.error) throw new Error(c.error.message);
        return { rpc, escritorioId: a.escritorio_id, conversaId: a.conversa_id, contexto: ContextoAssistente.parse(c.data), carregarCalendario: async () => [] };
      },
      registrar: async (f, escrita, ok, codigo) => { await servico()("mcp_registrar_chamada", { p_concessao: a.concessao_id, p_ferramenta: f, p_escrita: escrita, p_ok: ok, p_codigo: codigo }); },
    }),
  };
}

const deps = () => ({ base: BASE, rpc: servico() });
const formulario = (d: Record<string, string>) => new Request(`${BASE}/api/oauth/token`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(d).toString(),
});

async function registrar(redirect: string, nome: string) {
  const r = await registrarCliente(new Request(`${BASE}/api/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: nome, redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
  }), deps());
  return { status: r.status, corpo: (await r.json()) as { client_id: string; scope: string; error?: string } };
}

/** O que a tela de consentimento faz quando o usuário clica em Permitir. */
async function autorizar(uid: string, cliente: string, redirect: string, escopos: string[]) {
  const verifier = novoSegredo(48);
  const code = novoSegredo();
  await chamar(uid, "oauth_autorizar", {
    p_cliente: cliente, p_escritorio: esc, p_escopos: escopos, p_redirect_uri: redirect, p_code_challenge: desafioPkce(verifier),
    p_code_hash: hashSegredo(code), p_recurso: RECURSO,
  });
  return { code, verifier };
}

async function trocar(cliente: string, redirect: string, code: string, verifier: string) {
  const r = await emitirToken(formulario({ grant_type: "authorization_code", client_id: cliente, code, redirect_uri: redirect, code_verifier: verifier, resource: RECURSO }), deps());
  return { status: r.status, corpo: (await r.json()) as { access_token: string; refresh_token: string; scope: string; error?: string } };
}

async function conectar(uid: string, cliente: string, redirect: string, escopos: string[]) {
  const a = await autorizar(uid, cliente, redirect, escopos);
  const t = await trocar(cliente, redirect, a.code, a.verifier);
  expect(t.status).toBe(200);
  return t.corpo;
}

let idRpc = 0;
async function mcp(token: string | null, method: string, params?: Record<string, unknown>) {
  const r = await atenderMcp(new Request(RECURSO, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++idRpc, method, ...(params ? { params } : {}) }),
  }), depsMcp());
  return { status: r.status, corpo: r.status === 200 ? ((await r.json()) as { result?: Record<string, unknown>; error?: { code: number } }) : null };
}
const textoDaFerramenta = (r: { corpo: { result?: Record<string, unknown> } | null }) =>
  JSON.parse(((r.corpo!.result!.content as { text: string }[])[0]).text) as Record<string, unknown>;

let claude: string, chatgpt: string;

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, e] of [[ANA, "ana@t.com"], [BIA, "bia@t.com"], [ZE, "ze@t.com"]]) await criarUsuario(db, id, e);
  esc = await chamar<string>(ANA, "criar_escritorio", { p_nome: "Prado Advocacia", p_cnpj: null, p_plano: "equipe" });
  await chamar(ZE, "criar_escritorio", { p_nome: "Outro", p_cnpj: null, p_plano: "equipe" });
  const t = await chamar<string>(ANA, "criar_convite", { p_escritorio: esc, p_email: "bia@t.com", p_modulos: ["assistente", "processos", "prazos", "tarefas"] });
  await chamar(BIA, "aceitar_convite", { p_token: t });
  await db.query("update public.membro set nome = split_part(email, '@', 1) where escritorio_id = $1", [esc]);
  H = (await um<{ d: string }>("select public.hoje_brasilia()::text as d")).d;
  const novoProc = async (cnj: string, sigilo: boolean) => (await um<{ id: string }>(
    "insert into public.processo (escritorio_id, numero_cnj, tribunal, titulo, segredo_justica, status, confirmado_em) values ($1, $2, 'TJBA', $3, $4, 'confirmado', now()) returning id",
    [esc, cnj, sigilo ? "Guarda do menor" : "Cobrança contra Banco", sigilo])).id;
  proc = await novoProc("00012345620268050001", false);
  procSigilo = await novoProc("00099999920268050001", true);
  const bia = (await um<{ id: string }>("select id from public.membro where usuario_id = $1", [BIA])).id;
  for (const [p, desc] of [[proc, "Contestação"], [procSigilo, "Manifestação sigilosa"]]) {
    await db.query(`insert into public.prazo (escritorio_id, processo_id, descricao, dias, tipo_contagem, responsavel_id, data_disponibilizacao, data_publicacao, inicio_contagem, data_final, raciocinio)
      values ($1, $2, $3, 15, 'util', $4, $5::date - 20, $5::date - 19, $5::date - 18, $5::date, '{}'::jsonb)`, [esc, p, desc, bia, H]);
  }
  claude = (await registrar(CLAUDE_CB, "Claude")).corpo.client_id;
  chatgpt = (await registrar(CHATGPT_CB, "ChatGPT")).corpo.client_id;
});

describe("Registro dinâmico e teto de escopos por cliente", () => {
  it("Claude nasce com leitura + escrita; ChatGPT só leitura; endereço inseguro é recusado", async () => {
    expect((await registrar("https://claude.ai/api/mcp/auth_callback", "Claude 2")).corpo.scope).toBe("law.read law.write");
    expect((await registrar(CHATGPT_CB, "ChatGPT 2")).corpo.scope).toBe("law.read");
    expect((await registrar("https://outro.example/cb", "Outro")).corpo.scope).toBe("law.read");
    const ruim = await registrar("http://evil.example/cb", "Ruim");
    expect(ruim.status).toBe(400);
    expect(ruim.corpo.error).toBe("invalid_redirect_uri");
    // Configurável por cliente: o operador do LAW pode mudar o teto de um cliente específico.
    await db.query("update public.oauth_cliente set escopos_permitidos = '{law.read}' where nome = 'Claude 2'");
    expect((await um<{ e: string[] }>("select escopos_permitidos as e from public.oauth_cliente where nome = 'Claude 2'")).e).toEqual(["law.read"]);
  });

  it("ChatGPT: mesmo pedindo escrita, recebe só leitura e não consegue gravar", async () => {
    const tk = await conectar(BIA, chatgpt, CHATGPT_CB, ["law.read", "law.write"]);
    expect(tk.scope).toBe("law.read");
    const lista = await mcp(tk.access_token, "tools/list");
    const nomes = (lista.corpo!.result!.tools as { name: string }[]).map((t) => t.name);
    expect(nomes).toContain("buscar_prazos");
    expect(nomes.some((n) => n.startsWith("criar_") || n === "gerar_minuta")).toBe(false);
    const antes = Number((await um<{ n: string }>("select count(*)::text as n from public.tarefa")).n);
    const r = await mcp(tk.access_token, "tools/call", { name: "criar_tarefa", arguments: { titulo: "Não deveria" } });
    expect(r.corpo!.result!.isError).toBe(true);
    expect(Number((await um<{ n: string }>("select count(*)::text as n from public.tarefa")).n)).toBe(antes);
  });
});

describe("OAuth 2.1: PKCE, código de uso único e refresh com rotação", () => {
  it("verifier errado falha; código reaproveitado falha e derruba o token emitido com ele", async () => {
    const a = await autorizar(BIA, claude, CLAUDE_CB, ["law.read"]);
    expect((await trocar(claude, CLAUDE_CB, a.code, novoSegredo(48))).corpo.error).toBe("invalid_grant");
    const b = await autorizar(BIA, claude, CLAUDE_CB, ["law.read"]);
    const ok = await trocar(claude, CLAUDE_CB, b.code, b.verifier);
    expect(ok.status).toBe(200);
    expect((await mcp(ok.corpo.access_token, "ping")).status).toBe(200);
    expect((await trocar(claude, CLAUDE_CB, b.code, b.verifier)).corpo.error).toBe("invalid_grant");
    expect((await mcp(ok.corpo.access_token, "ping")).status).toBe(401);
  });

  it("outro cliente ou outro endereço de retorno não troca o código", async () => {
    const a = await autorizar(BIA, claude, CLAUDE_CB, ["law.read"]);
    expect((await trocar(chatgpt, CLAUDE_CB, a.code, a.verifier)).corpo.error).toBe("invalid_grant");
    const b = await autorizar(BIA, claude, CLAUDE_CB, ["law.read"]);
    expect((await trocar(claude, "https://claude.ai/outro", b.code, b.verifier)).corpo.error).toBe("invalid_grant");
    await expect(chamar(BIA, "oauth_autorizar", { p_cliente: claude, p_escritorio: esc, p_escopos: ["law.read"], p_redirect_uri: "https://evil.example/cb",
      p_code_challenge: desafioPkce(novoSegredo(48)), p_code_hash: hashSegredo(novoSegredo()), p_recurso: RECURSO })).rejects.toThrow(/redirect_uri_invalida/);
  });

  it("refresh gira; refresh antigo reaproveitado revoga a concessão inteira", async () => {
    const tk = await conectar(BIA, claude, CLAUDE_CB, ["law.read"]);
    const r1 = await emitirToken(formulario({ grant_type: "refresh_token", client_id: claude, refresh_token: tk.refresh_token }), deps());
    const novo = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(r1.status).toBe(200);
    expect(novo.refresh_token).not.toBe(tk.refresh_token);
    expect((await mcp(novo.access_token, "ping")).status).toBe(200);
    const r2 = await emitirToken(formulario({ grant_type: "refresh_token", client_id: claude, refresh_token: tk.refresh_token }), deps());
    expect(r2.status).toBe(400);
    expect((await mcp(novo.access_token, "ping")).status).toBe(401);
    const [g] = await consultar<{ motivo_revogacao: string }>(BIA, "select motivo_revogacao from public.oauth_concessao where cliente_id = $1 and revogada_em is not null order by revogada_em desc limit 1", [claude]);
    expect(g.motivo_revogacao).toBe("refresh_reutilizado");
  });

  it("revogação RFC 7009 pelo cliente corta o token", async () => {
    const tk = await conectar(BIA, claude, CLAUDE_CB, ["law.read"]);
    const r = await revogarToken(formulario({ token: tk.access_token, client_id: claude }), deps());
    expect(r.status).toBe(200);
    expect((await mcp(tk.access_token, "ping")).status).toBe(401);
  });

  it("o banco guarda só o hash dos tokens", async () => {
    const tk = await conectar(BIA, claude, CLAUDE_CB, ["law.read"]);
    expect((await db.query("select 1 from public.oauth_token where hash = $1", [tk.access_token])).rows).toEqual([]);
    expect((await db.query("select 1 from public.oauth_token where hash = $1", [hashSegredo(tk.access_token)])).rows).toHaveLength(1);
  });
});

describe("Critério de pronto: Claude lista os prazos da semana e cria tarefa após aprovação; revogar corta na hora", () => {
  it("fluxo completo", async () => {
    const tk = await conectar(BIA, claude, CLAUDE_CB, ["law.read", "law.write"]);
    expect(tk.scope).toBe("law.read law.write");

    const ini = await mcp(tk.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } });
    expect(ini.corpo!.result!.protocolVersion).toBe("2025-06-18");
    const lista = await mcp(tk.access_token, "tools/list");
    const ferramentas = lista.corpo!.result!.tools as { name: string; annotations: { destructiveHint: boolean; readOnlyHint: boolean } }[];
    expect(ferramentas.find((f) => f.name === "criar_tarefa")!.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(ferramentas.find((f) => f.name === "buscar_prazos")!.annotations).toMatchObject({ readOnlyHint: true });

    // 1) Prazos da semana. O do processo em segredo de justiça NÃO sai (padrão do escritório).
    const prazos = await mcp(tk.access_token, "tools/call", { name: "buscar_prazos", arguments: { periodo: "semana" } });
    expect(prazos.corpo!.result!.isError).toBeUndefined();
    const itens = textoDaFerramenta(prazos).itens as { descricao: string; link: string; data_final: string }[];
    expect(itens.map((i) => i.descricao)).toEqual(["Contestação"]);
    expect(itens[0].link).toBe(`${BASE}/app/processos/${proc}`);
    expect(itens[0].data_final).toBe(H);

    // 2) Criar tarefa (o Claude já pediu a aprovação do usuário, porque a ferramenta é destrutiva).
    const antes = Number((await um<{ n: string }>("select count(*)::text as n from public.tarefa where escritorio_id = $1", [esc])).n);
    const criada = await mcp(tk.access_token, "tools/call", { name: "criar_tarefa", arguments: { titulo: "Protocolar contestação", data: H, processo: "0001234-56.2026.8.05.0001" } });
    expect(criada.corpo!.result!.isError).toBeUndefined();
    const res = textoDaFerramenta(criada) as { gravado: boolean; id: string; link: string };
    expect(res.gravado).toBe(true);
    expect(res.link).toBe(`${BASE}/app/tarefas/${res.id}`);
    expect(Number((await um<{ n: string }>("select count(*)::text as n from public.tarefa where escritorio_id = $1", [esc])).n)).toBe(antes + 1);
    const tarefa = await um<{ titulo: string; criado_por: string; processo_id: string }>("select titulo, criado_por, processo_id from public.tarefa where id = $1", [res.id]);
    expect(tarefa).toEqual({ titulo: "Protocolar contestação", criado_por: BIA, processo_id: proc });

    // Rastro: rascunho de origem 'mcp' confirmado, auditoria e registro da chamada.
    const rasc = await um<{ origem: string; status: string; id: string }>("select id, origem, status from public.assistente_rascunho where resultado_id = $1", [res.id]);
    expect(rasc).toMatchObject({ origem: "mcp", status: "confirmado" });
    const audit = (await db.query<{ tabela: string; acao: string; usuario_id: string }>("select tabela, acao, usuario_id from public.audit_log where registro_id in ($1, $2) order by id", [rasc.id, res.id])).rows;
    expect(audit).toEqual(expect.arrayContaining([
      { tabela: "assistente_rascunho", acao: "insert", usuario_id: BIA }, { tabela: "assistente_rascunho", acao: "update", usuario_id: BIA },
    ]));
    const chamadas = (await db.query<{ ferramenta: string; escrita: boolean; ok: boolean }>(
      "select c.ferramenta, c.escrita, c.ok from public.mcp_chamada c join public.oauth_token t on t.concessao_id = c.concessao_id where t.hash = $1 order by c.id", [hashSegredo(tk.access_token)])).rows;
    expect(chamadas).toEqual([{ ferramenta: "buscar_prazos", escrita: false, ok: true }, { ferramenta: "criar_tarefa", escrita: true, ok: true }]);

    // 3) Tela Conexões: Bia vê a conexão e revoga. A PRÓXIMA chamada já é recusada.
    const conexoes = await chamar<{ conexoes: { id: string; cliente: string; escopos: string[]; revogada_em: string | null; escritas_24h: number }[] }>(BIA, "conexoes_listar", { p_escritorio: esc });
    const minha = conexoes.conexoes.find((c) => c.cliente === "Claude" && !c.revogada_em && c.escopos.includes("law.write"))!;
    expect(minha.escritas_24h).toBe(1);
    await chamar(BIA, "conexao_revogar", { p_concessao: minha.id });
    const depois = await mcp(tk.access_token, "tools/call", { name: "buscar_prazos", arguments: { periodo: "semana" } });
    expect(depois.status).toBe(401);
    const r = await emitirToken(formulario({ grant_type: "refresh_token", client_id: claude, refresh_token: tk.refresh_token }), deps());
    expect(r.status).toBe(400);
  });
});

describe("Segredo de justiça fora do LAW só com a permissão do dono", () => {
  it("padrão: não aparece nem o número; com a permissão: só número e link; a Lia (dentro do LAW) sempre vê restrito", async () => {
    const tk = await conectar(BIA, claude, CLAUDE_CB, ["law.read"]);
    const buscar = async () => textoDaFerramenta(await mcp(tk.access_token, "tools/call", { name: "buscar_processos", arguments: {} })).itens as { id: string; restrito: boolean; partes?: unknown }[];
    expect((await buscar()).map((p) => p.id)).toEqual([proc]);
    const pelaLia = await chamar<{ itens: { id: string }[] }>(BIA, "assistente_buscar_processos", { p_escritorio: esc });
    expect(pelaLia.itens.map((p) => p.id).sort()).toEqual([proc, procSigilo].sort());

    await expect(chamar(BIA, "conectores_configurar", { p_escritorio: esc, p_ativos: true, p_expor_sigilo: true })).rejects.toThrow(/sem_permissao/);
    await chamar(ANA, "conectores_configurar", { p_escritorio: esc, p_ativos: true, p_expor_sigilo: true });
    const s = (await buscar()).find((p) => p.id === procSigilo)!;
    expect(s.restrito).toBe(true);
    expect(s.partes).toBeUndefined();
    await chamar(ANA, "conectores_configurar", { p_escritorio: esc, p_ativos: true, p_expor_sigilo: false });
    expect((await buscar()).map((p) => p.id)).toEqual([proc]);
    // O mesmo vale para prazos e publicações do processo sigiloso (já coberto no critério de pronto para prazos).
    await expect(chamar(BIA, "assistente_buscar_processos", { p_escritorio: esc }, "mcp")).resolves.toMatchObject({ itens: [expect.objectContaining({ id: proc })] });
  });
});

describe("Limites e permissões checados a cada chamada", () => {
  it("limite por token por minuto", async () => {
    const tk = await conectar(BIA, claude, CLAUDE_CB, ["law.read"]);
    const h = hashSegredo(tk.access_token);
    for (let i = 0; i < 2; i++) await servico()("mcp_autenticar", { p_acesso_hash: h, p_limite_minuto: 2, p_limite_dia: 100 });
    await expect(servico()("mcp_autenticar", { p_acesso_hash: h, p_limite_minuto: 2, p_limite_dia: 100 })).rejects.toThrow(/limite_excedido/);
  });

  it("dono desliga os conectores: corta todo mundo na hora (403); religar volta", async () => {
    const tk = await conectar(BIA, claude, CLAUDE_CB, ["law.read"]);
    await chamar(ANA, "conectores_configurar", { p_escritorio: esc, p_ativos: false, p_expor_sigilo: false });
    expect((await mcp(tk.access_token, "ping")).status).toBe(403);
    await expect(autorizar(BIA, claude, CLAUDE_CB, ["law.read"])).rejects.toThrow(/conectores_desligados/);
    await chamar(ANA, "conectores_configurar", { p_escritorio: esc, p_ativos: true, p_expor_sigilo: false });
    expect((await mcp(tk.access_token, "ping")).status).toBe(200);
  });

  it("tirar a permissão da Lia do membro corta o conector; devolver religa", async () => {
    const tk = await conectar(BIA, claude, CLAUDE_CB, ["law.read"]);
    const membro = (await um<{ id: string }>("select id from public.membro where usuario_id = $1 and escritorio_id = $2", [BIA, esc])).id;
    await db.query("delete from public.permissao_tela where membro_id = $1 and modulo = 'assistente'", [membro]);
    expect((await mcp(tk.access_token, "ping")).status).toBe(403);
    await db.query("insert into public.permissao_tela (escritorio_id, membro_id, modulo) values ($2, $1, 'assistente')", [membro, esc]);
    expect((await mcp(tk.access_token, "ping")).status).toBe(200);
  });

  it("dono vê e revoga a conexão do membro; outro escritório não vê nem revoga", async () => {
    const tk = await conectar(BIA, claude, CLAUDE_CB, ["law.read"]);
    const daAna = await chamar<{ dono: boolean; conexoes: { id: string; pessoa: string; minha: boolean; revogada_em: string | null }[] }>(ANA, "conexoes_listar", { p_escritorio: esc });
    expect(daAna.dono).toBe(true);
    const daBia = daAna.conexoes.find((c) => c.pessoa === "bia" && !c.revogada_em)!;
    expect(daBia.minha).toBe(false);
    await expect(chamar(ZE, "conexao_revogar", { p_concessao: daBia.id })).rejects.toThrow(/nao_encontrado/);
    expect(await consultar(ZE, "select id from public.oauth_concessao")).toEqual([]);
    expect(await consultar(ZE, "select id from public.mcp_chamada")).toEqual([]);
    // Tokens e clientes nem podem ser lidos pela API (só o servidor do LAW, com a chave de serviço).
    await expect(consultar(BIA, "select id from public.oauth_token")).rejects.toThrow(/permission denied/);
    await expect(consultar(BIA, "select id from public.oauth_cliente")).rejects.toThrow(/permission denied/);
    await chamar(ANA, "conexao_revogar", { p_concessao: daBia.id });
    expect((await mcp(tk.access_token, "ping")).status).toBe(401);
  });

  it("sem token: 401 apontando para os metadados OAuth", async () => {
    const r = await mcp(null, "tools/list");
    expect(r.status).toBe(401);
  });
});
