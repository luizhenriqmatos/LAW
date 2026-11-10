import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import type { ChamarRpc } from "@/lib/captura/job";
import { baixarArquivo, enviarArquivo, LIMITE_DOWNLOAD_BYTES } from "@/lib/drive/arquivos";
import { concluirConexaoDrive } from "@/lib/drive/conectar";
import { processarFilaDrive } from "@/lib/drive/sync";
import type { DepsDrive } from "@/lib/drive/token";
import { hashDoToken, novoToken } from "@/lib/portal/token";
import { comoAnonimo, comoUsuario, criarBanco, criarUsuario, rpcComoServico } from "./banco";
import { DriveFalso } from "../fake-drive";

const ANA = "00000000-0000-4000-8000-0000000000d1"; // dona
const BIA = "00000000-0000-4000-8000-0000000000d2"; // processos + portal_cliente
const CAIO = "00000000-0000-4000-8000-0000000000d3"; // só tarefas
const OUTRO = "00000000-0000-4000-8000-0000000000d4"; // dono de outro escritório
const IP = "203.0.113.7";
const RODAPE = "Dúvidas? Fale com seu advogado.";
const TEXTO = `O processo foi enviado ao juiz, que vai analisá-lo e decidir o próximo passo.\n\n${RODAPE}`;

let db: PGlite;
let esc: string;
let escOutro: string;
const drive = new DriveFalso();
const chave = randomBytes(32);

const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const servico = <T = never,>(funcao: string, args: Record<string, unknown>) => rpcComoServico(db)<T>(funcao, args);
const jsonOuTexto = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

/** Chama uma função como usuário logado (RLS e permissões valem). */
function usuario<T = never>(uid: string, funcao: string, args: Record<string, unknown>): Promise<T> {
  const nomes = Object.keys(args);
  const sql = `select public.${funcao}(${nomes.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`;
  return comoUsuario(db, uid, async (tx) => (await tx.query<{ r: T }>(sql, nomes.map((n) => jsonOuTexto(args[n])))).rows[0].r);
}
const consultar = <T extends object>(uid: string, sql: string, p: unknown[] = []) => comoUsuario(db, uid, async (tx) => (await tx.query<T>(sql, p)).rows);

const rpcServ: ChamarRpc = async (funcao, args) => {
  if (funcao === "drive_pegar_fila") {
    return db.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      return (await tx.query<{ r: unknown }>("select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) r from public.drive_pegar_fila(p_limite => $1) t", [args.p_limite])).rows[0].r as never;
    });
  }
  return rpcComoServico(db)(funcao, args);
};
const deps = (): DepsDrive => ({ rpc: rpcServ, api: drive, renovar: drive.renovar, chave });
async function esvaziar() {
  for (let i = 0; i < 5; i++) if ((await processarFilaDrive(deps())).itens === 0) return;
}

let contador = 0;
const cnj = () => String(++contador + 7000).padStart(20, "0");
async function novoCliente(nome: string, email: string | null, escritorio = esc) {
  const { id } = await um<{ id: string }>("insert into public.cliente (escritorio_id, nome, email) values ($1, $2, $3) returning id", [escritorio, nome, email]);
  if (escritorio === esc) await usuario(BIA, "confirmar_cliente", { p_cliente: id });
  return id;
}
async function novoProcesso(opts: { clientes: string[]; segredo?: boolean; movimentos?: { dataHora: string; codigo: string; nome: string; complementos?: string[] }[]; nivelSigilo?: number; confirmar?: boolean }) {
  const numero = cnj();
  const { id } = await um<{ id: string }>(
    "insert into public.processo (escritorio_id, numero_cnj, classe, tribunal, segredo_justica) values ($1, $2, 'Procedimento Comum Cível', 'TJBA', $3) returning id",
    [esc, numero, opts.segredo ?? false],
  );
  for (const c of opts.clientes) {
    await db.query("insert into public.processo_parte (escritorio_id, processo_id, nome, polo, cliente_id) select $1, $2, nome, 'ativo', id from public.cliente where id = $3", [esc, id, c]);
  }
  if (opts.movimentos || opts.nivelSigilo !== undefined) {
    await db.query("insert into public.processo_metadados (escritorio_id, numero_cnj, fonte, dados) values ($1, $2, 'datajud', $3::jsonb)", [
      esc, numero, JSON.stringify({ nivelSigilo: opts.nivelSigilo ?? 0, movimentos: opts.movimentos ?? [] }),
    ]);
  }
  if (opts.confirmar !== false) await usuario(BIA, "confirmar_processo", { p_processo: id });
  return { id, numero };
}
const liberar = (processo: string, cliente: string, o: { mov?: boolean; resumo?: boolean; comp?: boolean; docs?: boolean; situacao?: string | null; titulo?: string | null } = {}, uid = BIA) =>
  usuario<string>(uid, "portal_liberar", {
    p_processo: processo, p_cliente: cliente, p_movimentacoes: o.mov ?? false, p_resumo: o.resumo ?? false,
    p_compromissos: o.comp ?? false, p_documentos: o.docs ?? false, p_situacao: o.situacao ?? null, p_titulo: o.titulo ?? null,
  });

type Consumo = { ok: boolean; motivo?: string; expira_em?: string };
/** Pede o link e entra, como o cliente faz. */
async function entrar(email: string) {
  const link = novoToken(), sessao = novoToken();
  const sol = await servico<{ enviar: boolean; motivo?: string }>("portal_link_solicitar", { p_email: email, p_token_hash: hashDoToken(link), p_ip: IP });
  const cons = sol.enviar
    ? await servico<Consumo>("portal_link_consumir", { p_token_hash: hashDoToken(link), p_sessao_hash: hashDoToken(sessao), p_ip: IP, p_user_agent: "teste" })
    : null;
  return { sol, cons, link, sessao, hash: hashDoToken(sessao) };
}
const inicio = (hash: string) => servico<{ ok: boolean; processos?: { processo_id: string; numero_cnj: string }[]; clientes?: string[] }>("portal_inicio", { p_sessao_hash: hash, p_ip: IP });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const verProcesso = (hash: string, processo: string) => servico<Record<string, any>>("portal_processo", { p_sessao_hash: hash, p_processo: processo, p_ip: IP });

const MOVS = [
  { dataHora: "2026-10-01T12:00:00.000Z", codigo: "26", nome: "Distribuição" },
  { dataHora: "2026-10-20T15:30:00.000Z", codigo: "85", nome: "Juntada de petição", complementos: ["DADO INTERNO SENSÍVEL"] },
  { dataHora: "2026-11-03T13:00:00.000Z", codigo: "51", nome: "Conclusos para despacho" },
];

// Clientes e processos usados por vários testes
let joao: string, maria: string;
let p1: { id: string; numero: string }, p2: { id: string; numero: string };

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, email] of [[ANA, "ana@t.com"], [BIA, "bia@t.com"], [CAIO, "caio@t.com"], [OUTRO, "outro@t.com"]]) await criarUsuario(db, id, email);
  esc = (await usuario<string>(ANA, "criar_escritorio", { p_nome: "Prado Advocacia", p_cnpj: null, p_plano: "equipe" }));
  escOutro = (await usuario<string>(OUTRO, "criar_escritorio", { p_nome: "Outro Escritorio", p_cnpj: null, p_plano: "equipe" }));
  const t1 = await usuario<string>(ANA, "criar_convite", { p_escritorio: esc, p_email: "bia@t.com", p_modulos: "{processos,portal_cliente,agenda}" });
  await usuario(BIA, "aceitar_convite", { p_token: t1 });
  const t2 = await usuario<string>(ANA, "criar_convite", { p_escritorio: esc, p_email: "caio@t.com", p_modulos: "{tarefas}" });
  await usuario(CAIO, "aceitar_convite", { p_token: t2 });

  await concluirConexaoDrive({
    rpc: rpcServ, api: drive, chave, escritorioId: esc, usuarioId: ANA,
    tokens: { accessToken: "acc-ana-0", refreshToken: "ana", expiraEm: new Date(Date.now() + 3600_000), escopo: "drive.file" },
  });
  joao = await novoCliente("João da Silva Teste", "Joao.Cliente@Teste.com");
  maria = await novoCliente("Maria Souza Teste", "maria.cliente@teste.com");
  p1 = await novoProcesso({ clientes: [joao], movimentos: MOVS });
  p2 = await novoProcesso({ clientes: [maria], movimentos: MOVS });
  await esvaziar();
});

describe("CRITÉRIO: processo em segredo de justiça não aparece, mesmo se o advogado tentar liberar", () => {
  it("o advogado tenta liberar e o banco recusa; nada é gravado e o cliente não vê nada", async () => {
    const cli = await novoCliente("Cliente do Segredo", "segredo.cliente@teste.com");
    const seg = await novoProcesso({ clientes: [cli], segredo: true, movimentos: MOVS });

    await expect(liberar(seg.id, cli, { mov: true, resumo: true, comp: true, docs: true }, ANA)).rejects.toThrow(/segredo_de_justica/); // dono
    await expect(liberar(seg.id, cli, { mov: true }, BIA)).rejects.toThrow(/segredo_de_justica/); // quem tem a tela
    expect((await um<{ n: number }>("select count(*)::int n from public.portal_liberacao where processo_id = $1", [seg.id])).n).toBe(0);

    // O cliente não consegue nem pedir o link (não tem nada liberado) e, mesmo com sessão de outro processo, não enxerga o segredo.
    const sol = await servico<{ enviar: boolean; motivo: string }>("portal_link_solicitar", { p_email: "segredo.cliente@teste.com", p_token_hash: hashDoToken(novoToken()), p_ip: IP });
    expect(sol).toMatchObject({ enviar: false, motivo: "sem_acesso" });
  });

  it("nem o servidor (service_role) consegue gravar a liberação: o gatilho vale para qualquer papel", async () => {
    const cli = await novoCliente("Cliente Segredo Dois", "segredo2.cliente@teste.com");
    const seg = await novoProcesso({ clientes: [cli], segredo: true });
    await expect(db.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      await tx.query("insert into public.portal_liberacao (escritorio_id, processo_id, cliente_id, ver_movimentacoes) values ($1, $2, $3, true)", [esc, seg.id, cli]);
    })).rejects.toThrow(/segredo_de_justica/);
    // Documento e compromisso visível também são barrados.
    await expect(servico("portal_documento_compartilhar", { p_processo: seg.id, p_arquivo: "arquivo-qualquer", p_nome: "x.pdf", p_mime: null, p_tamanho: 1 })).rejects.toThrow();
    await expect(usuario(BIA, "portal_documento_compartilhar", { p_processo: seg.id, p_arquivo: "arquivo-qualquer", p_nome: "x.pdf", p_mime: null, p_tamanho: 1 })).rejects.toThrow(/segredo_de_justica/);
    await expect(db.query("insert into public.portal_documento (escritorio_id, processo_id, arquivo_drive_id, nome) values ($1, $2, 'arquivo-qualquer', 'x.pdf')", [esc, seg.id])).rejects.toThrow(/segredo_de_justica/);
    const { id: comp } = await um<{ id: string }>("insert into public.compromisso (escritorio_id, titulo, tipo, inicio, fim, processo_id) values ($1, 'Audiência', 'audiencia', now() + interval '3 days', now() + interval '3 days 1 hour', $2) returning id", [esc, seg.id]);
    await expect(usuario(BIA, "portal_compromisso_visivel", { p_compromisso: comp, p_visivel: true })).rejects.toThrow(/segredo_de_justica/);
  });

  it("sigilo informado pelo DataJud (nivelSigilo) também barra, mesmo com a caixa de segredo desmarcada", async () => {
    const cli = await novoCliente("Cliente Sigilo Tribunal", "sigilo.cliente@teste.com");
    const proc = await novoProcesso({ clientes: [cli], segredo: false, nivelSigilo: 2, movimentos: MOVS });
    await expect(liberar(proc.id, cli, { mov: true })).rejects.toThrow(/segredo_de_justica/);
    const painel = await usuario<{ processo: { sigiloso: boolean }; partes?: unknown }>(BIA, "portal_painel_processo", { p_processo: proc.id });
    expect(painel.processo.sigiloso).toBe(true);
    expect(painel.partes).toBeUndefined(); // a tela do advogado nem lista clientes nem arquivos
  });

  it("falha fechado: processo que o banco não conhece conta como sigiloso", async () => {
    expect((await um<{ s: boolean }>("select public.portal_processo_sigiloso('00000000-0000-4000-8000-00000000ffff') s")).s).toBe(true);
  });

  it("defesa em profundidade: mesmo com a liberação gravada à força, TODA leitura do portal exclui o segredo", async () => {
    const cli = await novoCliente("Cliente Forcado", "forcado.cliente@teste.com");
    const normal = await novoProcesso({ clientes: [cli], movimentos: MOVS });
    const seg = await novoProcesso({ clientes: [cli], segredo: true, movimentos: MOVS });
    await liberar(normal.id, cli, { mov: true, docs: true });
    const { hash } = await entrar("forcado.cliente@teste.com");

    // Alguém com acesso de superusuário desliga o gatilho e força a linha (simula bug ou acesso indevido).
    await db.exec("alter table public.portal_liberacao disable trigger portal_liberacao_valida");
    try {
      await db.query("insert into public.portal_liberacao (escritorio_id, processo_id, cliente_id, ver_movimentacoes, ver_documentos) values ($1, $2, $3, true, true)", [esc, seg.id, cli]);
      const lista = await inicio(hash);
      expect(lista.processos?.map((p) => p.numero_cnj)).toEqual([normal.numero]);
      expect(await verProcesso(hash, seg.id)).toMatchObject({ ok: false, motivo: "nao_encontrado" });
      expect(await servico("portal_documento_obter", { p_sessao_hash: hash, p_processo: seg.id, p_documento: "00000000-0000-4000-8000-000000000001", p_ip: IP })).toMatchObject({ ok: false });
      expect((await servico<unknown[]>("portal_resumos_pendentes", { p_limite: 200 })).some((x) => (x as { processo_id: string }).processo_id === seg.id)).toBe(false);
    } finally {
      await db.exec("alter table public.portal_liberacao enable trigger portal_liberacao_valida");
    }
  });

  it("a IA nunca recebe conteúdo de processo em segredo", async () => {
    const cli = await novoCliente("Cliente IA Segredo", "ia.segredo@teste.com");
    const seg = await novoProcesso({ clientes: [cli], segredo: true, movimentos: MOVS });
    await expect(usuario(BIA, "portal_movimentos_para_resumo", { p_processo: seg.id })).rejects.toThrow(/segredo_de_justica/);
    await expect(usuario(BIA, "portal_resumo_salvar", { p_processo: seg.id, p_texto: TEXTO, p_origem: "ia", p_modelo: "m", p_base_hash: null, p_alertas: [] })).rejects.toThrow(/segredo_de_justica/);
  });

  it("processo já liberado que vira segredo de justiça é retirado do portal na mesma hora", async () => {
    const cli = await novoCliente("Cliente Vira Segredo", "vira.segredo@teste.com");
    const proc = await novoProcesso({ clientes: [cli], movimentos: MOVS });
    const lib = await liberar(proc.id, cli, { mov: true, resumo: true, comp: true, docs: true });
    const { id: comp } = await um<{ id: string }>("insert into public.compromisso (escritorio_id, titulo, tipo, inicio, fim, processo_id) values ($1, 'Reunião', 'reuniao', now() + interval '2 days', now() + interval '2 days 1 hour', $2) returning id", [esc, proc.id]);
    await usuario(BIA, "portal_compromisso_visivel", { p_compromisso: comp, p_visivel: true });
    await usuario(BIA, "portal_documento_compartilhar", { p_processo: proc.id, p_arquivo: "arquivo-123456", p_nome: "peticao.pdf", p_mime: "application/pdf", p_tamanho: 10 });
    await usuario(BIA, "portal_resumo_salvar", { p_processo: proc.id, p_texto: TEXTO, p_origem: "advogado", p_modelo: null, p_base_hash: null, p_alertas: [] });

    const { hash } = await entrar("vira.segredo@teste.com");
    expect((await verProcesso(hash, proc.id)).ok).toBe(true);

    await db.query("update public.processo set segredo_justica = true where id = $1", [proc.id]);

    expect(await verProcesso(hash, proc.id)).toMatchObject({ ok: false, motivo: "nao_encontrado" });
    expect((await inicio(hash)).processos).toEqual([]);
    expect(await um("select ativo, motivo_revogacao from public.portal_liberacao where id = $1", [lib])).toEqual({ ativo: false, motivo_revogacao: "segredo_de_justica" });
    expect((await um<{ n: number }>("select count(*)::int n from public.portal_documento where processo_id = $1 and revogado_em is null", [proc.id])).n).toBe(0);
    expect((await um<{ n: number }>("select count(*)::int n from public.portal_resumo where processo_id = $1 and status in ('rascunho','publicado')", [proc.id])).n).toBe(0);
    expect((await um<{ v: boolean }>("select visivel_portal v from public.compromisso where id = $1", [comp])).v).toBe(false);
    // E o advogado não consegue liberar de novo.
    await expect(liberar(proc.id, cli, { mov: true })).rejects.toThrow(/segredo_de_justica/);
  });

  it("sigilo que chega depois pelos metadados do tribunal também retira o que estava liberado", async () => {
    const cli = await novoCliente("Cliente Sigilo Tardio", "sigilo.tardio@teste.com");
    const proc = await novoProcesso({ clientes: [cli], movimentos: MOVS, nivelSigilo: 0 });
    await liberar(proc.id, cli, { mov: true });
    const { hash } = await entrar("sigilo.tardio@teste.com");
    expect((await verProcesso(hash, proc.id)).ok).toBe(true);

    await db.query("update public.processo_metadados set dados = jsonb_set(dados, '{nivelSigilo}', '3') where numero_cnj = $1", [proc.numero]);
    expect((await verProcesso(hash, proc.id)).ok).toBe(false);
    expect((await um<{ ativo: boolean }>("select ativo from public.portal_liberacao where processo_id = $1", [proc.id])).ativo).toBe(false);
  });
});

describe("CRITÉRIO: link reutilizado ou expirado é recusado", () => {
  const EMAIL = "joao.cliente@teste.com";
  const pedir = async (email = EMAIL) => {
    // Zera o limite de 5 links/hora entre os testes (envelhece os links antigos).
    await db.query("update public.portal_link set criado_em = now() - interval '3 hours' where email = $1", [email]);
    const token = novoToken(), sessao = novoToken();
    const sol = await servico<{ enviar: boolean; motivo?: string; escritorios?: string[] }>("portal_link_solicitar", { p_email: email, p_token_hash: hashDoToken(token), p_ip: IP });
    const consumir = (t = token, s = sessao) => servico<Consumo>("portal_link_consumir", { p_token_hash: hashDoToken(t), p_sessao_hash: hashDoToken(s), p_ip: IP, p_user_agent: "Navegador de teste" });
    return { token, sessao, sol, consumir };
  };

  beforeAll(async () => { await liberar(p1.id, joao, { mov: true }); });

  it("link novo funciona UMA vez; a segunda tentativa é recusada", async () => {
    const l = await pedir();
    expect(l.sol).toMatchObject({ enviar: true, escritorios: ["Prado Advocacia"] });
    const primeira = await l.consumir();
    expect(primeira.ok).toBe(true);
    const segunda = await l.consumir(l.token, novoToken());
    expect(segunda).toEqual({ ok: false, motivo: "usado" });
    // A sessão que a primeira vez criou continua valendo; a segunda não criou outra.
    expect((await um<{ n: number }>("select count(*)::int n from public.portal_sessao where link_id = (select id from public.portal_link where token_hash = $1)", [hashDoToken(l.token)])).n).toBe(1);
    expect((await inicio(hashDoToken(l.sessao))).ok).toBe(true);
  });

  it("link usado duas vezes AO MESMO TEMPO: só uma das tentativas entra", async () => {
    const l = await pedir();
    const resultados = await Promise.all([l.consumir(l.token, novoToken()), l.consumir(l.token, novoToken()), l.consumir(l.token, novoToken())]);
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    expect(resultados.filter((r) => !r.ok).every((r) => r.motivo === "usado")).toBe(true);
  });

  it("link com mais de 30 minutos é recusado e NÃO cria sessão", async () => {
    const l = await pedir();
    await db.query("update public.portal_link set expira_em = now() - interval '1 second' where token_hash = $1", [hashDoToken(l.token)]);
    expect(await l.consumir()).toEqual({ ok: false, motivo: "expirado" });
    expect((await um<{ n: number }>("select count(*)::int n from public.portal_sessao where token_hash = $1", [hashDoToken(l.sessao)])).n).toBe(0);
    expect((await inicio(hashDoToken(l.sessao))).ok).toBe(false);
  });

  it("link que ainda está dentro dos 30 minutos entra; os prazos gravados são 30 minutos e 7 dias", async () => {
    const l = await pedir();
    await db.query("update public.portal_link set criado_em = now() - interval '29 minutes', expira_em = now() - interval '29 minutes' + interval '30 minutes' where token_hash = $1", [hashDoToken(l.token)]);
    expect((await l.consumir()).ok).toBe(true);
    const novo = await pedir();
    expect((await um<{ s: number }>("select extract(epoch from expira_em - criado_em)::int s from public.portal_link where token_hash = $1", [hashDoToken(novo.token)])).s).toBe(30 * 60);
    await novo.consumir();
    expect((await um<{ s: number }>("select extract(epoch from expira_em - criado_em)::int s from public.portal_sessao where token_hash = $1", [hashDoToken(novo.sessao)])).s).toBe(7 * 24 * 3600);
  });

  it("token inventado ou adulterado é inválido", async () => {
    const l = await pedir();
    expect(await servico("portal_link_consumir", { p_token_hash: hashDoToken(novoToken()), p_sessao_hash: hashDoToken(novoToken()), p_ip: IP, p_user_agent: null })).toEqual({ ok: false, motivo: "invalido" });
    expect(await l.consumir(`${l.token.slice(0, -1)}${l.token.endsWith("A") ? "B" : "A"}`)).toEqual({ ok: false, motivo: "invalido" });
    expect((await l.consumir()).ok).toBe(true); // o verdadeiro continua intacto
  });

  it("o banco só guarda o hash do token (nunca o token)", async () => {
    const l = await pedir();
    const linhas = await db.query<{ t: string }>("select token_hash t from public.portal_link where token_hash = $1", [hashDoToken(l.token)]);
    expect(linhas.rows[0].t).toBe(hashDoToken(l.token));
    expect(linhas.rows[0].t).not.toBe(l.token);
    const tudo = JSON.stringify((await db.query("select * from public.portal_link")).rows);
    expect(tudo).not.toContain(l.token);
  });

  it("sessão vencida (7 dias) ou encerrada (sair) é recusada", async () => {
    const a = await pedir(); await a.consumir();
    expect((await inicio(hashDoToken(a.sessao))).ok).toBe(true);
    await db.query("update public.portal_sessao set expira_em = now() - interval '1 second' where token_hash = $1", [hashDoToken(a.sessao)]);
    expect((await inicio(hashDoToken(a.sessao))).ok).toBe(false);
    expect(await verProcesso(hashDoToken(a.sessao), p1.id)).toMatchObject({ ok: false, motivo: "sessao" });

    const b = await pedir(); await b.consumir();
    await servico("portal_sessao_encerrar", { p_sessao_hash: hashDoToken(b.sessao) });
    expect((await inicio(hashDoToken(b.sessao))).ok).toBe(false);
  });

  it("não revela quem é cliente: e-mail desconhecido, sem processo liberado ou inválido não gera link", async () => {
    const antes = (await um<{ n: number }>("select count(*)::int n from public.portal_link")).n;
    const semLiberacao = await novoCliente("Cliente Sem Liberacao", "sem.liberacao@teste.com");
    expect(semLiberacao).toBeTruthy();
    for (const email of ["ninguem@teste.com", "sem.liberacao@teste.com", "isto-nao-e-email", "", "a@b"]) {
      const r = await servico<{ enviar: boolean }>("portal_link_solicitar", { p_email: email, p_token_hash: hashDoToken(novoToken()), p_ip: IP });
      expect(r.enviar).toBe(false);
    }
    expect((await um<{ n: number }>("select count(*)::int n from public.portal_link")).n).toBe(antes);
  });

  it("e-mail vale sem diferenciar maiúsculas; o limite é de 5 links por e-mail por hora", async () => {
    const email = "maria.cliente@teste.com";
    await liberar(p2.id, maria, { mov: true });
    const ok = [];
    for (let i = 0; i < 5; i++) ok.push((await servico<{ enviar: boolean }>("portal_link_solicitar", { p_email: i % 2 ? email.toUpperCase() : ` ${email} `, p_token_hash: hashDoToken(novoToken()), p_ip: IP })).enviar);
    expect(ok).toEqual([true, true, true, true, true]);
    expect(await servico("portal_link_solicitar", { p_email: email, p_token_hash: hashDoToken(novoToken()), p_ip: IP })).toMatchObject({ enviar: false, motivo: "limite" });
  });

  it("o advogado manda o link de UM cliente; só se houver processo liberado e e-mail, e também é de uso único", async () => {
    await db.query("update public.portal_link set criado_em = now() - interval '3 hours' where email = $1", [EMAIL]);
    const token = novoToken();
    const r = await usuario<{ email: string; escritorio: string }>(BIA, "portal_link_advogado", { p_cliente: joao, p_token_hash: hashDoToken(token), p_ip: IP });
    expect(r).toEqual({ email: "joao.cliente@teste.com", escritorio: "Prado Advocacia" });
    const sessao = novoToken();
    const dados = { p_token_hash: hashDoToken(token), p_sessao_hash: hashDoToken(sessao), p_ip: IP, p_user_agent: null };
    expect((await servico<Consumo>("portal_link_consumir", dados)).ok).toBe(true);
    expect(await servico("portal_link_consumir", { ...dados, p_sessao_hash: hashDoToken(novoToken()) })).toEqual({ ok: false, motivo: "usado" });

    const semProcesso = await novoCliente("Cliente Sem Nada", "sem.nada@teste.com");
    await expect(usuario(BIA, "portal_link_advogado", { p_cliente: semProcesso, p_token_hash: hashDoToken(novoToken()), p_ip: null })).rejects.toThrow(/sem_processo_liberado/);
    const semEmail = await novoCliente("Cliente Sem Email", null);
    await expect(usuario(BIA, "portal_link_advogado", { p_cliente: semEmail, p_token_hash: hashDoToken(novoToken()), p_ip: null })).rejects.toThrow(/cliente_sem_email/);
    await expect(usuario(CAIO, "portal_link_advogado", { p_cliente: joao, p_token_hash: hashDoToken(novoToken()), p_ip: null })).rejects.toThrow(/sem_permissao/);
  });
});

describe("O advogado escolhe o que o cliente vê (padrão: nada)", () => {
  it("sem liberação, o cliente não vê o processo; liberado sem opções, vê só a situação", async () => {
    const cli = await novoCliente("Cliente Padrao", "padrao.cliente@teste.com");
    const proc = await novoProcesso({ clientes: [cli], movimentos: MOVS });
    expect((await entrar("padrao.cliente@teste.com")).sol.enviar).toBe(false);

    await liberar(proc.id, cli, {});
    const { hash } = await entrar("padrao.cliente@teste.com");
    const r = await verProcesso(hash, proc.id);
    expect(r).toMatchObject({ ok: true, ver_movimentacoes: false, ver_resumo: false, ver_compromissos: false, ver_documentos: false });
    expect(r.movimentacoes).toEqual([]);
    expect(r.resumo).toBeNull();
    expect(r.compromissos).toEqual([]);
    expect(r.documentos).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("Conclusos"); // nem escapa pelo resto do JSON
  });

  it("cada opção liga só a sua parte; movimentações vêm só com data, código e nome (sem complementos)", async () => {
    const cli = await novoCliente("Cliente Opcoes", "opcoes.cliente@teste.com");
    const proc = await novoProcesso({ clientes: [cli], movimentos: MOVS });
    await liberar(proc.id, cli, { mov: true, situacao: "Aguardando decisão do juiz", titulo: "Ação de cobrança" });
    const { hash } = await entrar("opcoes.cliente@teste.com");
    const r = await verProcesso(hash, proc.id);
    expect(r.movimentacoes.map((m: { nome: string }) => m.nome)).toEqual(["Conclusos para despacho", "Juntada de petição", "Distribuição"]); // mais recente primeiro
    expect(Object.keys(r.movimentacoes[0]).sort()).toEqual(["codigo", "data_hora", "nome"]);
    expect(JSON.stringify(r)).not.toContain("DADO INTERNO SENSÍVEL");
    expect(r.processo).toMatchObject({ situacao_texto: "Aguardando decisão do juiz", titulo: "Ação de cobrança", escritorio: "Prado Advocacia" });
    expect(r.resumo).toBeNull();
    // A lista também só traz a última movimentação quando a opção está ligada.
    const lista = await servico<{ processos: { ultima_movimentacao: { nome: string } | null }[] }>("portal_inicio", { p_sessao_hash: hash, p_ip: IP });
    expect(lista.processos[0].ultima_movimentacao?.nome).toBe("Conclusos para despacho");
  });

  it("a lista de movimentações mostra no máximo as 15 mais recentes", async () => {
    const cli = await novoCliente("Cliente Muitas Movs", "muitas.movs@teste.com");
    const muitas = Array.from({ length: 30 }, (_, i) => ({ dataHora: new Date(Date.UTC(2026, 0, 1 + i, 12)).toISOString(), codigo: String(i), nome: `Movimento ${i}` }));
    const proc = await novoProcesso({ clientes: [cli], movimentos: muitas });
    await liberar(proc.id, cli, { mov: true });
    const { hash } = await entrar("muitas.movs@teste.com");
    const r = await verProcesso(hash, proc.id);
    expect(r.movimentacoes).toHaveLength(15);
    expect(r.movimentacoes[0].nome).toBe("Movimento 29");
  });

  it("compromissos: só os futuros, marcados como visíveis, sem a descrição interna", async () => {
    const cli = await novoCliente("Cliente Agenda", "agenda.cliente@teste.com");
    const proc = await novoProcesso({ clientes: [cli] });
    const mk = async (titulo: string, inicio: string, fim: string) =>
      (await um<{ id: string }>("insert into public.compromisso (escritorio_id, titulo, tipo, inicio, fim, local, descricao, processo_id) values ($1, $2, 'audiencia', now() + $3::interval, now() + $4::interval, 'Fórum de Salvador', 'ESTRATÉGIA INTERNA', $5) returning id", [esc, titulo, inicio, fim, proc.id])).id;
    const visivel = await mk("Audiência de conciliação", "5 days", "5 days 1 hour");
    const oculto = await mk("Reunião interna", "6 days", "6 days 1 hour");
    const passado = await mk("Audiência antiga", "-5 days", "-5 days +1 hour");
    await usuario(BIA, "portal_compromisso_visivel", { p_compromisso: visivel, p_visivel: true });
    await usuario(BIA, "portal_compromisso_visivel", { p_compromisso: passado, p_visivel: true });
    expect(oculto).toBeTruthy();

    await liberar(proc.id, cli, { comp: true });
    const { hash } = await entrar("agenda.cliente@teste.com");
    const r = await verProcesso(hash, proc.id);
    expect(r.compromissos.map((c: { titulo: string }) => c.titulo)).toEqual(["Audiência de conciliação"]);
    expect(Object.keys(r.compromissos[0]).sort()).toEqual(["fim", "inicio", "local", "tipo", "titulo"]);
    expect(JSON.stringify(r)).not.toContain("ESTRATÉGIA INTERNA");

    // Compromisso sem processo não pode ser marcado como visível (nem pelo banco).
    const { id: solto } = await um<{ id: string }>("insert into public.compromisso (escritorio_id, titulo, tipo, inicio, fim) values ($1, 'Solto', 'outro', now(), now()) returning id", [esc]);
    await expect(usuario(BIA, "portal_compromisso_visivel", { p_compromisso: solto, p_visivel: true })).rejects.toThrow();
  });

  it("um cliente não vê o processo de outro; trocar o e-mail do cliente encerra o acesso na hora; retirar a liberação também", async () => {
    const a = await novoCliente("Cliente A Isolado", "isolado.a@teste.com");
    const b = await novoCliente("Cliente B Isolado", "isolado.b@teste.com");
    const pa = await novoProcesso({ clientes: [a], movimentos: MOVS });
    const pb = await novoProcesso({ clientes: [b], movimentos: MOVS });
    const libA = await liberar(pa.id, a, { mov: true });
    await liberar(pb.id, b, { mov: true });
    const sa = await entrar("isolado.a@teste.com");
    expect((await verProcesso(sa.hash, pa.id)).ok).toBe(true);
    expect(await verProcesso(sa.hash, pb.id)).toMatchObject({ ok: false, motivo: "nao_encontrado" });
    expect((await inicio(sa.hash)).processos?.map((p) => p.numero_cnj)).toEqual([pa.numero]);

    await db.query("update public.cliente set email = 'novo.email@teste.com' where id = $1", [a]);
    expect((await verProcesso(sa.hash, pa.id)).ok).toBe(false);
    await db.query("update public.cliente set email = 'isolado.a@teste.com' where id = $1", [a]);
    expect((await verProcesso(sa.hash, pa.id)).ok).toBe(true);

    await usuario(BIA, "portal_revogar", { p_liberacao: libA });
    expect(await verProcesso(sa.hash, pa.id)).toMatchObject({ ok: false, motivo: "nao_encontrado" });
  });

  it("só libera cliente confirmado, com e-mail, que seja parte do processo; processo provisório não entra", async () => {
    const cliente = await novoCliente("Cliente Regras", "regras.cliente@teste.com");
    const estranho = await novoCliente("Cliente Estranho", "estranho.cliente@teste.com");
    const proc = await novoProcesso({ clientes: [cliente] });
    await expect(liberar(proc.id, estranho, { mov: true })).rejects.toThrow(/cliente_fora_do_processo/);
    const { id: prov } = await um<{ id: string }>("insert into public.cliente (escritorio_id, nome, email) values ($1, 'Cliente Provisorio', 'prov@teste.com') returning id", [esc]);
    await db.query("insert into public.processo_parte (escritorio_id, processo_id, nome, polo, cliente_id) values ($1, $2, 'Cliente Provisorio', 'ativo', $3)", [esc, proc.id, prov]);
    await expect(liberar(proc.id, prov, { mov: true })).rejects.toThrow(/cliente_nao_confirmado/);
    const semEmail = await novoCliente("Cliente Sem Email Regras", null);
    await db.query("insert into public.processo_parte (escritorio_id, processo_id, nome, polo, cliente_id) values ($1, $2, 'Cliente Sem Email Regras', 'ativo', $3)", [esc, proc.id, semEmail]);
    await expect(liberar(proc.id, semEmail, { mov: true })).rejects.toThrow(/cliente_sem_email/);
    const provisorio = await novoProcesso({ clientes: [cliente], confirmar: false });
    await expect(liberar(provisorio.id, cliente, { mov: true })).rejects.toThrow(/processo_nao_confirmado/);
  });
});

describe("Resumo em linguagem simples: rascunho, publicação direta e fecho obrigatório", () => {
  const salvar = (uid: string, proc: string, o: { texto?: string; origem?: string; alertas?: string[] } = {}) =>
    usuario<{ id: string; status: string }>(uid, "portal_resumo_salvar", { p_processo: proc, p_texto: o.texto ?? TEXTO, p_origem: o.origem ?? "ia", p_modelo: "modelo-teste", p_base_hash: "a".repeat(64), p_alertas: o.alertas ?? [] });
  const modo = (m: "revisar" | "direto") => usuario(ANA, "portal_configurar", { p_escritorio: esc, p_modo: m });
  let cli: string, proc: { id: string; numero: string };
  beforeAll(async () => {
    cli = await novoCliente("Cliente Resumo", "resumo.cliente@teste.com");
    proc = await novoProcesso({ clientes: [cli], movimentos: MOVS });
    await liberar(proc.id, cli, { mov: true, resumo: true });
  });

  it("modo revisar (padrão): a IA gera rascunho; o cliente só vê depois que o advogado publica", async () => {
    const { hash } = await entrar("resumo.cliente@teste.com");
    expect((await um<{ m: string }>("select portal_resumo_modo m from public.escritorio where id = $1", [esc])).m).toBe("revisar");
    const r = await salvar(BIA, proc.id);
    expect(r.status).toBe("rascunho");
    expect((await verProcesso(hash, proc.id)).resumo).toBeNull();

    await usuario(BIA, "portal_resumo_editar", { p_resumo: r.id, p_texto: `O processo foi enviado ao juiz, que vai decidir o próximo passo com calma.\n\n${RODAPE}` });
    await usuario(BIA, "portal_resumo_publicar", { p_resumo: r.id });
    const visto = (await verProcesso(hash, proc.id)).resumo;
    expect(visto).toMatchObject({ revisado: true });
    expect(visto.texto).toContain("com calma");
    expect(visto.texto.endsWith(RODAPE)).toBe(true);
  });

  it("publicar um novo resumo substitui o anterior (só um fica no ar)", async () => {
    const r = await salvar(BIA, proc.id, { texto: `Novo andamento: o processo recebeu mais um documento.\n\n${RODAPE}` });
    await usuario(BIA, "portal_resumo_publicar", { p_resumo: r.id });
    const { n } = await um<{ n: number }>("select count(*)::int n from public.portal_resumo where processo_id = $1 and status = 'publicado'", [proc.id]);
    expect(n).toBe(1);
    expect((await um<{ n: number }>("select count(*)::int n from public.portal_resumo where processo_id = $1 and status = 'substituido'", [proc.id])).n).toBeGreaterThanOrEqual(1);
  });

  it("modo direto: IA sem alerta publica na hora; com alerta, ou escrito à mão, continua rascunho", async () => {
    await modo("direto");
    try {
      const { hash } = await entrar("resumo.cliente@teste.com");
      const limpo = await salvar(BIA, proc.id, { texto: `O processo foi distribuído e aguarda os primeiros passos da Justiça.\n\n${RODAPE}` });
      expect(limpo.status).toBe("publicado");
      expect((await verProcesso(hash, proc.id)).resumo).toMatchObject({ revisado: false }); // o cliente é avisado de que não houve revisão

      const comAlerta = await salvar(BIA, proc.id, { texto: `Você provavelmente vai ganhar esta ação em breve.\n\n${RODAPE}`, alertas: ["O texto tem previsão ou certeza sobre o resultado."] });
      expect(comAlerta.status).toBe("rascunho");
      expect((await verProcesso(hash, proc.id)).resumo.texto).toContain("distribuído"); // o publicado anterior segue; o rascunho não vaza

      const manual = await salvar(BIA, proc.id, { origem: "advogado" });
      expect(manual.status).toBe("rascunho");

      // O job (service_role) segue a mesma regra.
      const viaJob = await servico<{ status: string }>("portal_resumo_salvar_servico", { p_escritorio: esc, p_processo: proc.id, p_texto: `Houve mais um andamento simples no processo nesta semana.\n\n${RODAPE}`, p_modelo: "m", p_base_hash: "b".repeat(64), p_alertas: [] });
      expect(viaJob.status).toBe("publicado");
    } finally {
      await modo("revisar");
    }
  });

  it("só o dono muda o modo; o job é só do servidor", async () => {
    await expect(usuario(BIA, "portal_configurar", { p_escritorio: esc, p_modo: "direto" })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(ANA, "portal_configurar", { p_escritorio: esc, p_modo: "tanto-faz" })).rejects.toThrow(/modo_invalido/);
    await expect(usuario(BIA, "portal_resumo_salvar_servico", { p_escritorio: esc, p_processo: proc.id, p_texto: TEXTO, p_modelo: "m", p_base_hash: null, p_alertas: [] })).rejects.toThrow(/permission denied/);
  });

  it("resumo sem o fecho \"Dúvidas? Fale com seu advogado.\" é recusado, na função e na tabela", async () => {
    await expect(salvar(BIA, proc.id, { texto: "O processo está andando normalmente, sem novidades." })).rejects.toThrow(/resumo_invalido/);
    await expect(db.query("insert into public.portal_resumo (escritorio_id, processo_id, texto, origem) values ($1, $2, 'Texto comprido o bastante, mas sem o fecho obrigatório.', 'ia')", [esc, proc.id])).rejects.toThrow(/check/);
    const r = await salvar(BIA, proc.id);
    await expect(usuario(BIA, "portal_resumo_editar", { p_resumo: r.id, p_texto: "Editei e apaguei o fecho do resumo sem querer." })).rejects.toThrow(/resumo_invalido/);
  });

  it("o job só lista processos liberados com resumo ligado e fora de segredo", async () => {
    const pendentes = await servico<{ processo_id: string; movimentos: unknown[]; ultimo_base_hash: string | null }[]>("portal_resumos_pendentes", { p_limite: 200 });
    const ids = pendentes.map((x) => x.processo_id);
    expect(ids).toContain(proc.id);
    expect(ids).not.toContain(p2.id); // liberado sem a opção "resumo"
    const meu = pendentes.find((x) => x.processo_id === proc.id)!;
    expect(meu.movimentos).toHaveLength(3);
    expect(meu.ultimo_base_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Registro de acessos (data e IP)", () => {
  it("entrada, lista e abertura do processo ficam gravadas com o IP, visíveis só ao escritório", async () => {
    const cli = await novoCliente("Cliente Acessos", "acessos.cliente@teste.com");
    const proc = await novoProcesso({ clientes: [cli], movimentos: MOVS });
    await liberar(proc.id, cli, { mov: true });
    const { hash } = await entrar("acessos.cliente@teste.com");
    await inicio(hash);
    await verProcesso(hash, proc.id);

    const linhas = await db.query<{ tipo: string; ip: string; processo_id: string | null; criado_em: string }>(
      "select tipo, host(ip) ip, processo_id, criado_em from public.portal_acesso where cliente_id = $1 order by id", [cli]);
    expect(linhas.rows.map((l) => l.tipo)).toEqual(["link_gerado", "entrou", "lista", "processo"]);
    expect(linhas.rows.every((l) => l.ip === IP && l.criado_em)).toBe(true);
    expect(linhas.rows[3].processo_id).toBe(proc.id);

    // O advogado vê o histórico na tela, com o nome do cliente e o IP (sem a lista repetida de "lista").
    const visao = await usuario<{ acessos: { cliente_nome: string; ip: string; tipo: string }[] }>(BIA, "portal_visao_geral", { p_escritorio: esc });
    const meus = visao.acessos.filter((a) => a.cliente_nome === "Cliente Acessos");
    expect(meus.map((a) => a.tipo).sort()).toEqual(["entrou", "link_gerado", "processo"]);
    expect(meus.every((a) => a.ip === IP)).toBe(true);
  });
});

describe("Documentos compartilhados (Drive)", () => {
  it("o cliente baixa só o que foi compartilhado e liberado; ao revogar, o acesso some", async () => {
    const cli = await novoCliente("Cliente Documentos", "docs.cliente@teste.com");
    const proc = await novoProcesso({ clientes: [cli], movimentos: MOVS });
    await esvaziar();
    const pasta = await um<{ drive_id: string }>("select drive_id from public.drive_pasta where tipo = 'processo' and ref_id = $1 and status = 'ativa'", [proc.id]);
    const conteudo = new TextEncoder().encode("conteúdo do documento %PDF-fake");
    const enviado = await enviarArquivo(deps(), esc, pasta.drive_id, { nome: "peticao.pdf", tipo: "application/pdf", dados: conteudo });
    const naoCompartilhado = await enviarArquivo(deps(), esc, pasta.drive_id, { nome: "interno.pdf", tipo: "application/pdf", dados: conteudo });
    if (!enviado.ok || !naoCompartilhado.ok) throw new Error("falha no envio de teste");

    // A pasta do processo está disponível para a tela do advogado.
    const pa = await usuario<{ escritorio_id: string; drive_id: string }>(BIA, "portal_pasta_processo", { p_processo: proc.id });
    expect(pa).toEqual({ escritorio_id: esc, drive_id: pasta.drive_id });
    await expect(usuario(CAIO, "portal_pasta_processo", { p_processo: proc.id })).rejects.toThrow(/sem_permissao/);

    const doc = await usuario<string>(BIA, "portal_documento_compartilhar", { p_processo: proc.id, p_arquivo: enviado.dados.id, p_nome: "peticao.pdf", p_mime: "application/pdf", p_tamanho: conteudo.byteLength });
    await liberar(proc.id, cli, { docs: true });
    const { hash } = await entrar("docs.cliente@teste.com");

    const r = await verProcesso(hash, proc.id);
    expect(r.documentos.map((d: { nome: string }) => d.nome)).toEqual(["peticao.pdf"]);
    expect(JSON.stringify(r)).not.toContain(enviado.dados.id); // o id do Drive nunca vai para a tela do cliente

    const obter = (d: string) => servico<{ ok: boolean; arquivo_drive_id?: string; escritorio_id?: string }>("portal_documento_obter", { p_sessao_hash: hash, p_processo: proc.id, p_documento: d, p_ip: IP });
    const autorizado = await obter(doc);
    expect(autorizado).toMatchObject({ ok: true, arquivo_drive_id: enviado.dados.id, escritorio_id: esc });
    const baixado = await baixarArquivo(deps(), esc, autorizado.arquivo_drive_id!);
    if (!baixado.ok) throw new Error("download falhou");
    expect(new Uint8Array(await new Response(baixado.dados.corpo).arrayBuffer())).toEqual(conteudo);
    expect(baixado.dados).toMatchObject({ nome: "peticao.pdf", mime: "application/pdf" });
    expect((await um<{ n: number }>("select count(*)::int n from public.portal_acesso where cliente_id = $1 and tipo = 'documento'", [cli])).n).toBe(1);

    // Documento de outro processo / inventado / sessão errada: negado.
    expect((await obter("00000000-0000-4000-8000-0000000000aa")).ok).toBe(false);
    expect((await servico<{ ok: boolean }>("portal_documento_obter", { p_sessao_hash: hashDoToken(novoToken()), p_processo: proc.id, p_documento: doc, p_ip: IP })).ok).toBe(false);

    // Sem a opção "documentos" ligada, nem a lista nem o download funcionam.
    await liberar(proc.id, cli, { docs: false });
    expect((await verProcesso(hash, proc.id)).documentos).toEqual([]);
    expect((await obter(doc)).ok).toBe(false);
    await liberar(proc.id, cli, { docs: true });
    expect((await obter(doc)).ok).toBe(true);

    await usuario(BIA, "portal_documento_revogar", { p_documento: doc });
    expect((await obter(doc)).ok).toBe(false);
    expect((await verProcesso(hash, proc.id)).documentos).toEqual([]);

    // Arquivo grande demais não é entregue.
    const grande = drive.nos.get(naoCompartilhado.dados.id)!;
    grande.size = LIMITE_DOWNLOAD_BYTES + 1;
    expect(await baixarArquivo(deps(), esc, grande.id)).toEqual({ ok: false, codigo: "arquivo_grande" });
  });
});

describe("RLS e permissões do portal", () => {
  let liberacaoId: string, docId: string, resumoId: string;
  beforeAll(async () => {
    const cli = await novoCliente("Cliente RLS", "rls.cliente@teste.com");
    const proc = await novoProcesso({ clientes: [cli], movimentos: MOVS });
    liberacaoId = await liberar(proc.id, cli, { mov: true, resumo: true, docs: true });
    docId = await usuario<string>(BIA, "portal_documento_compartilhar", { p_processo: proc.id, p_arquivo: "arquivo-rls-1", p_nome: "rls.pdf", p_mime: null, p_tamanho: 1 });
    resumoId = (await usuario<{ id: string }>(BIA, "portal_resumo_salvar", { p_processo: proc.id, p_texto: TEXTO, p_origem: "advogado", p_modelo: null, p_base_hash: null, p_alertas: [] })).id;
    await entrar("rls.cliente@teste.com");
  });

  it("quem tem a tela lê; outro escritório e quem não tem a tela não leem nada", async () => {
    for (const t of ["portal_liberacao", "portal_resumo", "portal_documento", "portal_acesso"]) {
      expect((await consultar(ANA, `select 1 from public.${t}`)).length, `${t}: dona`).toBeGreaterThan(0);
      expect((await consultar(BIA, `select 1 from public.${t}`)).length, `${t}: Bia`).toBeGreaterThan(0);
      expect(await consultar(CAIO, `select 1 from public.${t}`), `${t}: Caio (sem a tela)`).toEqual([]);
      expect(await consultar(OUTRO, `select 1 from public.${t}`), `${t}: outro escritório`).toEqual([]);
    }
  });

  it("link e sessão não são legíveis por ninguém do app (hash de token nunca chega ao navegador)", async () => {
    for (const t of ["portal_link", "portal_sessao"]) {
      for (const uid of [ANA, BIA, OUTRO]) await expect(consultar(uid, `select * from public.${t}`)).rejects.toThrow(/permission denied/);
      await expect(comoAnonimo(db, async (tx) => tx.query(`select * from public.${t}`))).rejects.toThrow(/permission denied/);
    }
  });

  it("ninguém escreve direto nas tabelas do portal; só pelas funções", async () => {
    for (const sql of [
      `update public.portal_liberacao set ver_documentos = true where id = '${liberacaoId}'`,
      `delete from public.portal_liberacao where id = '${liberacaoId}'`,
      `update public.portal_resumo set status = 'publicado' where id = '${resumoId}'`,
      `update public.portal_documento set revogado_em = null where id = '${docId}'`,
      `insert into public.portal_acesso (escritorio_id, cliente_id, tipo) select escritorio_id, cliente_id, 'entrou' from public.portal_liberacao limit 1`,
    ]) {
      await expect(comoUsuario(db, ANA, (tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
  });

  it("outro escritório não consegue usar as funções do advogado sobre o nosso processo", async () => {
    const proc = (await um<{ processo_id: string; cliente_id: string }>("select processo_id, cliente_id from public.portal_liberacao where id = $1", [liberacaoId]));
    await expect(usuario(OUTRO, "portal_liberar", { p_processo: proc.processo_id, p_cliente: proc.cliente_id, p_movimentacoes: true, p_resumo: true, p_compromissos: true, p_documentos: true, p_situacao: null, p_titulo: null })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(OUTRO, "portal_revogar", { p_liberacao: liberacaoId })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(OUTRO, "portal_painel_processo", { p_processo: proc.processo_id })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(OUTRO, "portal_visao_geral", { p_escritorio: esc })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(OUTRO, "portal_resumo_publicar", { p_resumo: resumoId })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(OUTRO, "portal_documento_revogar", { p_documento: docId })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(OUTRO, "portal_link_advogado", { p_cliente: proc.cliente_id, p_token_hash: hashDoToken(novoToken()), p_ip: null })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(CAIO, "portal_liberar", { p_processo: proc.processo_id, p_cliente: proc.cliente_id, p_movimentacoes: true, p_resumo: true, p_compromissos: true, p_documentos: true, p_situacao: null, p_titulo: null })).rejects.toThrow(/sem_permissao/);
    // Nada mudou.
    expect((await um<{ ativo: boolean }>("select ativo from public.portal_liberacao where id = $1", [liberacaoId])).ativo).toBe(true);
    expect(escOutro).toBeTruthy();
  });

  it("as funções do visitante são só do servidor: usuário logado e anônimo não executam", async () => {
    const h = hashDoToken(novoToken());
    await expect(usuario(ANA, "portal_inicio", { p_sessao_hash: h, p_ip: null })).rejects.toThrow(/permission denied/);
    await expect(usuario(ANA, "portal_link_solicitar", { p_email: "rls.cliente@teste.com", p_token_hash: h, p_ip: null })).rejects.toThrow(/permission denied/);
    await expect(usuario(ANA, "portal_link_consumir", { p_token_hash: h, p_sessao_hash: h, p_ip: null, p_user_agent: null })).rejects.toThrow(/permission denied/);
    await expect(usuario(ANA, "portal_resumos_pendentes", { p_limite: 5 })).rejects.toThrow(/permission denied/);
    await expect(comoAnonimo(db, (tx) => tx.query("select public.portal_inicio($1, null)", [h]))).rejects.toThrow(/permission denied/);
    await expect(comoAnonimo(db, (tx) => tx.query("select public.portal_liberar(gen_random_uuid(), gen_random_uuid(), true, true, true, true)"))).rejects.toThrow(/permission denied/);
  });

  it("sessão inexistente nunca devolve dado", async () => {
    const h = hashDoToken(novoToken());
    expect(await inicio(h)).toEqual({ ok: false, motivo: "sessao" });
    expect(await verProcesso(h, p1.id)).toEqual({ ok: false, motivo: "sessao" });
  });
});

describe("Auditoria", () => {
  it("liberar, revogar e publicar resumo entram no audit_log, com quem fez", async () => {
    const cli = await novoCliente("Cliente Auditoria", "audit.cliente@teste.com");
    const proc = await novoProcesso({ clientes: [cli] });
    const lib = await liberar(proc.id, cli, { mov: true });
    await usuario(BIA, "portal_revogar", { p_liberacao: lib });
    const linhas = await db.query<{ acao: string; usuario_id: string }>("select acao, usuario_id from public.audit_log where tabela = 'portal_liberacao' and registro_id = $1 order by id", [lib]);
    expect(linhas.rows.map((l) => l.acao)).toEqual(["insert", "update"]);
    expect(linhas.rows.every((l) => l.usuario_id === BIA)).toBe(true);
  });
});
