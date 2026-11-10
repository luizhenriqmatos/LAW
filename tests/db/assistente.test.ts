import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { responder } from "@/lib/assistente/motor";
import { dadosParaConfirmar, prepararLancamento, type CtxRascunho } from "@/lib/assistente/rascunhos";
import { ContextoAssistente, ErroAssistente, type Rpc } from "@/lib/assistente/tipos";
import type { BlocoFerramenta, BlocoTexto, MensagemIa, RespostaConversa, ServicoIaFerramentas } from "@/lib/integrations/ia";
import { calcularPrazo, entradasDoTribunal, type EntradaCalendario } from "@/lib/prazos/contagem";
import { comoUsuario, criarBanco, criarUsuario } from "./banco";

const ANA = "00000000-0000-4000-8000-0000000000f1"; // dona (vê tudo)
const BIA = "00000000-0000-4000-8000-0000000000f2"; // Lia + processos + tarefas, SEM financeiro
const CAIO = "00000000-0000-4000-8000-0000000000f3"; // só financeiro, SEM a Lia
const DANI = "00000000-0000-4000-8000-0000000000f4"; // Lia + financeiro + processos
const ZE = "00000000-0000-4000-8000-0000000000f5"; // dono de outro escritório

const CNJ = "00012345620268050001";
const CNJ_SIGILO = "00099999920268050001";
const CPF_FICTICIO = "52998224725"; // CPF de teste (dígitos válidos, não é de ninguém)

let db: PGlite;
let esc: string, escZe: string;
let fulano: string, proc: string, procSigilo: string;

const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const contar = async (tabela: string) => Number((await um<{ n: string }>(`select count(*)::text as n from public.${tabela} where escritorio_id = $1`, [esc])).n);

/** Parâmetros que são listas do Postgres (text[]/uuid[]); o resto que for objeto/lista vai como JSON, igual ao PostgREST. */
const LISTAS = new Set(["p_sem_permissao", "p_rascunhos"]);

/** Rpc COM O LOGIN do usuário (papel authenticated + JWT), como o app faz com o cliente Supabase da sessão. */
function rpcDe(uid: string): Rpc {
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
      const r = await comoUsuario(db, uid, (tx) => tx.query<{ r: unknown }>(sql, valores));
      return { data: r.rows[0].r, error: null };
    } catch (e) {
      const x = e as { message: string; code?: string; detail?: string };
      return { data: null, error: { message: x.message, code: x.code, details: x.detail ?? null } };
    }
  };
}
const consultar = <T extends object>(uid: string, sql: string, p: unknown[] = []) => comoUsuario(db, uid, async (tx) => (await tx.query<T>(sql, p)).rows);
async function chamar<T>(uid: string, funcao: string, args: Record<string, unknown>): Promise<T> {
  const r = await rpcDe(uid)(funcao, args);
  if (r.error) throw new Error(r.error.message + (r.error.details ? ` [${r.error.details}]` : ""));
  return r.data as T;
}

async function ctxDe(uid: string): Promise<CtxRascunho> {
  const rpc = rpcDe(uid);
  const contexto = ContextoAssistente.parse(await chamar(uid, "assistente_contexto", { p_escritorio: esc }));
  return {
    rpc, escritorioId: esc, contexto,
    carregarCalendario: async () => (await consultar<{ data: string; data_fim: string | null; escopo: EntradaCalendario["escopo"]; tribunal: string | null; uf: string | null; tipo: EntradaCalendario["tipo"]; descricao: string }>(uid,
      "select data::text, data_fim::text, escopo, tribunal, uf, tipo, descricao from public.calendario_forense where escritorio_id is null or escritorio_id = $1", [esc]))
      .map((r) => ({ data: r.data, dataFim: r.data_fim, escopo: r.escopo, tribunal: r.tribunal, uf: r.uf, tipo: r.tipo, descricao: r.descricao })),
  };
}

/** IA falsa: segue um roteiro de respostas e guarda o que recebeu (para provar o que foi enviado ao provedor). */
class IaRoteiro implements ServicoIaFerramentas {
  readonly modelo = "roteiro-de-teste";
  recebidas: MensagemIa[][] = [];
  constructor(private roteiro: (BlocoTexto | BlocoFerramenta)[][]) {}
  async conversar(p: { mensagens: MensagemIa[] }): Promise<RespostaConversa> {
    this.recebidas.push(JSON.parse(JSON.stringify(p.mensagens)));
    const blocos = this.roteiro.shift();
    if (!blocos) return { ok: false, motivo: "roteiro acabou" };
    return { ok: true, blocos, parada: blocos.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
  }
  /** Conteúdo de todos os tool_result que o LAW devolveu à IA. */
  resultados(): { content: string; is_error?: boolean }[] {
    const ultima = this.recebidas.at(-1) ?? [];
    return ultima.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content : [])) as { content: string; is_error?: boolean }[];
  }
}
const usar = (name: string, input: unknown, id = `t_${name}`): BlocoFerramenta => ({ type: "tool_use", id, name, input });
const texto = (t: string): BlocoTexto => ({ type: "text", text: t });

async function novaConversa(uid: string) {
  return chamar<string>(uid, "assistente_conversa_criar", { p_escritorio: esc, p_titulo: "teste" });
}

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, e] of [[ANA, "ana@t.com"], [BIA, "bia@t.com"], [CAIO, "caio@t.com"], [DANI, "dani@t.com"], [ZE, "ze@t.com"]]) await criarUsuario(db, id, e);
  esc = await chamar<string>(ANA, "criar_escritorio", { p_nome: "Prado Advocacia", p_cnpj: null, p_plano: "equipe" });
  escZe = await chamar<string>(ZE, "criar_escritorio", { p_nome: "Outro Escritório", p_cnpj: null, p_plano: "equipe" });
  const convidar = async (uid: string, email: string, modulos: string[]) => {
    const token = await chamar<string>(ANA, "criar_convite", { p_escritorio: esc, p_email: email, p_modulos: modulos });
    await chamar(uid, "aceitar_convite", { p_token: token });
  };
  // criar_convite recebe text[]: passa direto (o helper só manda JSON para objetos).
  LISTAS.add("p_modulos");
  await convidar(BIA, "bia@t.com", ["assistente", "processos", "tarefas"]);
  await convidar(CAIO, "caio@t.com", ["financeiro"]);
  await convidar(DANI, "dani@t.com", ["assistente", "financeiro", "processos"]);
  await db.query("update public.membro set nome = split_part(email, '@', 1) where escritorio_id = $1", [esc]);

  const cli = async (nome: string, doc: string | null = null) =>
    (await um<{ id: string }>("insert into public.cliente (escritorio_id, nome, documento, status, confirmado_em) values ($1, $2, $3, 'confirmado', now()) returning id", [esc, nome, doc])).id;
  fulano = await cli("Fulano de Tal", CPF_FICTICIO);
  await cli("Beltrano Souza");
  await cli("Maria Fulana Prado");
  proc = (await um<{ id: string }>("insert into public.processo (escritorio_id, numero_cnj, tribunal, titulo, status, confirmado_em) values ($1, $2, 'TJBA', 'Cobrança Fulano x Banco', 'confirmado', now()) returning id", [esc, CNJ])).id;
  procSigilo = (await um<{ id: string }>("insert into public.processo (escritorio_id, numero_cnj, tribunal, titulo, segredo_justica, status, confirmado_em) values ($1, $2, 'TJBA', 'Guarda do menor', true, 'confirmado', now()) returning id", [esc, CNJ_SIGILO])).id;
  await db.query("insert into public.processo_parte (escritorio_id, processo_id, nome, polo, cliente_id) values ($1, $2, 'Fulano de Tal', 'ativo', $3), ($1, $4, 'Parte Sigilosa Exemplo', 'passivo', null)", [esc, proc, fulano, procSigilo]);
  const pub = (cnj: string, procId: string, txt: string) => db.query(
    `insert into public.publicacao (escritorio_id, fonte, hash, data_disponibilizacao, tribunal, texto, numero_cnj, bruto, status_triagem, processo_id)
     values ($1, 'exemplo', encode(sha256(convert_to($2, 'UTF8')), 'hex'), '2026-11-03', 'TJBA', $2, $3, '{}'::jsonb, 'vinculada', $4)`, [esc, txt, cnj, procId]);
  await pub(CNJ, proc, "Intime-se a parte autora para se manifestar em 15 dias sobre a contestação.");
  await pub(CNJ_SIGILO, procSigilo, "SEGREDO: conteúdo sensível da guarda do menor.");
});

describe("Critério de pronto: 'lança 3 parcelas de R$ 1.000 de honorários para o cliente Fulano'", () => {
  it("gera o rascunho correto e NADA é gravado antes do Confirmar; só o Confirmar grava", async () => {
    const lancAntes = await contar("lancamento");
    const parcAntes = await contar("parcela");
    const conversa = await novaConversa(DANI);
    const ia = new IaRoteiro([
      [usar("preparar_lancamento", { tipo: "receita", categoria: "honorarios_contratuais", cliente: "Fulano", parcelas: 3, valor_parcela_reais: 1000 })],
      [texto("Preparei o rascunho: 3 parcelas de R$ 1.000,00 para Fulano de Tal. Confira no cartão e clique em Confirmar.")],
    ]);
    const ctx = await ctxDe(DANI);
    const resposta = await responder({ ia, ctx: { ...ctx, conversaId: conversa }, historico: [], pergunta: "lança 3 parcelas de R$ 1.000 de honorários para o cliente Fulano" });

    expect(resposta.falhou).toBe(false);
    expect(resposta.rascunhos).toHaveLength(1);
    // NADA gravado no financeiro.
    expect(await contar("lancamento")).toBe(lancAntes);
    expect(await contar("parcela")).toBe(parcAntes);
    // A IA foi avisada de que nada foi gravado.
    const devolvido = JSON.parse(ia.resultados()[0].content);
    expect(devolvido.gravado).toBe(false);
    expect(devolvido.valor_total_centavos).toBe(300000);

    // O rascunho tem exatamente o que a tela de lançamento gravaria.
    const [r] = await consultar<{ id: string; tipo: string; status: string; dados: Record<string, unknown>; resumo: string }>(DANI,
      "select id, tipo, status, dados, resumo from public.assistente_rascunho where id = $1", [resposta.rascunhos[0]]);
    expect(r.tipo).toBe("lancamento");
    expect(r.status).toBe("pendente");
    const { _exibir, ...dados } = r.dados as Record<string, unknown> & { _exibir: { parcelas: { valor_centavos: number; vencimento: string }[]; cliente_nome: string } };
    expect(dados).toMatchObject({ tipo: "receita", categoria: "honorarios_contratuais", valor_centavos: 300000, parcelas: 3, cliente_id: fulano, processo_id: null });
    expect(_exibir.cliente_nome).toBe("Fulano de Tal");
    expect(_exibir.parcelas.map((p) => p.valor_centavos)).toEqual([100000, 100000, 100000]);
    expect(r.resumo).toContain("3 parcelas de R$");
    expect(r.resumo).toContain("total R$");

    // Confirmar (o que o cartão envia sem editar) grava 1 lançamento com 3 parcelas de R$ 1.000,00.
    const form = {
      tipo: "receita", categoria: "honorarios_contratuais", descricao: String(dados.descricao), cliente_id: fulano, processo_id: "",
      valor_total: "3.000,00", parcelas: "3", primeiro_vencimento: String(dados.primeiro_vencimento), data_competencia: "",
    };
    const final = await dadosParaConfirmar("lancamento", dados, form, ctx);
    const res = await chamar<{ tipo: string; id: string; link: string }>(DANI, "assistente_rascunho_confirmar", { p_rascunho: r.id, p_dados: final });
    expect(res.tipo).toBe("lancamento");
    expect(res.link).toBe(`/app/financeiro/lancamentos/${res.id}`);
    expect(await contar("lancamento")).toBe(lancAntes + 1);
    const parcelas = (await db.query<{ valor_centavos: string }>("select valor_centavos::text from public.parcela where lancamento_id = $1 order by numero", [res.id])).rows;
    expect(parcelas.map((p) => Number(p.valor_centavos))).toEqual([100000, 100000, 100000]);
    const l = await um<{ cliente_id: string; categoria: string; criado_por: string }>("select cliente_id, categoria, criado_por from public.lancamento where id = $1", [res.id]);
    expect(l).toMatchObject({ cliente_id: fulano, categoria: "honorarios_contratuais", criado_por: DANI });

    // Ação confirmada fica no audit_log (rascunho: pendente -> confirmado; e o lançamento em si).
    const audit = (await db.query<{ tabela: string; acao: string; usuario_id: string }>(
      "select tabela, acao, usuario_id from public.audit_log where escritorio_id = $1 and (registro_id = $2 or registro_id = $3) order by id", [esc, r.id, res.id])).rows;
    expect(audit).toEqual(expect.arrayContaining([
      { tabela: "assistente_rascunho", acao: "insert", usuario_id: DANI },
      { tabela: "assistente_rascunho", acao: "update", usuario_id: DANI },
      { tabela: "lancamento", acao: "insert", usuario_id: DANI },
    ]));

    // Não grava duas vezes.
    await expect(chamar(DANI, "assistente_rascunho_confirmar", { p_rascunho: r.id, p_dados: final })).rejects.toThrow(/rascunho_encerrado/);
    expect(await contar("lancamento")).toBe(lancAntes + 1);
  });

  it("nome com mais de um cliente parecido: rascunho sai SEM cliente e o Confirmar recusa até escolher", async () => {
    const ctx = await ctxDe(DANI);
    const r = await prepararLancamento({ categoria: "honorarios_contratuais", cliente: "Fulan", parcelas: 2, valor_total_reais: 1500.5 }, ctx);
    expect(r.dados.cliente_id).toBeNull();
    expect((r.exibir.candidatos_cliente as { nome: string }[]).map((c) => c.nome).sort()).toEqual(["Fulano de Tal", "Maria Fulana Prado"]);
    expect(r.dados.valor_centavos).toBe(150050);
    expect((r.exibir.parcelas as { valor_centavos: number }[]).map((p) => p.valor_centavos)).toEqual([75025, 75025]);
    await expect(dadosParaConfirmar("lancamento", r.dados, {
      tipo: "receita", categoria: "honorarios_contratuais", descricao: "Honorários", cliente_id: "", processo_id: "", valor_total: "1.500,50", parcelas: "2", primeiro_vencimento: "2031-01-10",
    }, ctx)).rejects.toThrow(ErroAssistente);
  });

  it("cliente inexistente: nada é preparado e a IA recebe 'não encontrado'", async () => {
    const conversa = await novaConversa(DANI);
    const ia = new IaRoteiro([[usar("preparar_lancamento", { categoria: "exito", cliente: "Cicrano Inexistente", valor_total_reais: 500 })], [texto("Não encontrei esse cliente.")]]);
    const r = await responder({ ia, ctx: { ...(await ctxDe(DANI)), conversaId: conversa }, historico: [], pergunta: "lança 500 de êxito para Cicrano" });
    expect(r.rascunhos).toEqual([]);
    expect(ia.resultados()[0].is_error).toBe(true);
    expect(JSON.parse(ia.resultados()[0].content).erro).toBe("cliente_nao_encontrado");
  });

  it("descartar não grava nada e encerra o rascunho", async () => {
    const conversa = await novaConversa(DANI);
    const ctx = await ctxDe(DANI);
    const ia = new IaRoteiro([[usar("preparar_lancamento", { categoria: "custas", cliente: "Beltrano Souza", valor_total_reais: 80 })], [texto("ok")]]);
    const r = await responder({ ia, ctx: { ...ctx, conversaId: conversa }, historico: [], pergunta: "custas de 80 para Beltrano" });
    const antes = await contar("lancamento");
    await chamar(DANI, "assistente_rascunho_descartar", { p_rascunho: r.rascunhos[0] });
    await expect(chamar(DANI, "assistente_rascunho_confirmar", { p_rascunho: r.rascunhos[0], p_dados: { tipo: "receita" } })).rejects.toThrow(/rascunho_encerrado/);
    expect(await contar("lancamento")).toBe(antes);
  });
});

describe("Critério de pronto: sem permissão financeira, a Lia recusa perguntas sobre valores", () => {
  it("BIA (sem Financeiro) pergunta quanto Fulano deve: a ferramenta recusa, nenhum valor chega à IA e a tela recebe o aviso fixo", async () => {
    const conversa = await novaConversa(BIA);
    const ia = new IaRoteiro([
      [usar("buscar_lancamentos", { termo: "Fulano", situacao: "em_aberto" })],
      [texto("Você não tem permissão para ver informações financeiras.")],
    ]);
    const r = await responder({ ia, ctx: { ...(await ctxDe(BIA)), conversaId: conversa }, historico: [], pergunta: "quanto o Fulano ainda deve de honorários?" });
    expect(r.semPermissao).toEqual(["financeiro"]);
    const [res] = ia.resultados();
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).erro).toBe("sem_permissao");
    expect(res.content).not.toMatch(/100000|R\$|valor_total/);
    expect(r.fontes).toEqual([]);
    // O prompt do sistema também diz a ela que o usuário não vê o Financeiro.
    expect(r.ferramentas).toEqual([expect.objectContaining({ nome: "buscar_lancamentos", ok: false, codigo: "sem_permissao" })]);
  });

  it("o banco recusa direto: buscar lançamentos, preparar lançamento e ler a tabela", async () => {
    await expect(chamar(BIA, "assistente_buscar_lancamentos", { p_escritorio: esc })).rejects.toThrow(/sem_permissao.*financeiro/);
    const conversa = await novaConversa(BIA);
    await expect(chamar(BIA, "assistente_rascunho_criar", { p_conversa: conversa, p_tipo: "lancamento", p_dados: { valor_centavos: 1 }, p_resumo: "x", p_avisos: [] }))
      .rejects.toThrow(/sem_permissao/);
    await expect(prepararLancamento({ categoria: "exito", cliente: "Fulano", valor_total_reais: 10 }, await ctxDe(BIA))).rejects.toThrow(/permiss/);
    expect(await consultar(BIA, "select id from public.lancamento")).toEqual([]);
  });

  it("o prompt do sistema lista Financeiro entre as telas que ela NÃO pode ver", async () => {
    const ia = new IaRoteiro([[texto("ok")]]);
    let sistema = "";
    const espiao: ServicoIaFerramentas = { modelo: "x", conversar: async (p) => { sistema = p.sistema; return ia.conversar(p); } };
    await responder({ ia: espiao, ctx: { ...(await ctxDe(BIA)), conversaId: await novaConversa(BIA) }, historico: [], pergunta: "oi" });
    expect(sistema).toMatch(/NÃO pode ver:[^\n]*Financeiro/);
  });
});

describe("Ferramentas de leitura: RLS, citações e segredo de justiça", () => {
  it("buscar_processos devolve link da tela e partes; processo em segredo vai sem partes", async () => {
    const r = await chamar<{ itens: Record<string, unknown>[] }>(BIA, "assistente_buscar_processos", { p_escritorio: esc, p_termo: null, p_limite: 10 });
    const normal = r.itens.find((i) => i.id === proc)!;
    expect(normal).toMatchObject({ link: `/app/processos/${proc}`, rotulo: "Processo 0001234-56.2026.8.05.0001", restrito: false });
    expect(JSON.stringify(normal.partes)).toContain("Fulano de Tal");
    const sigilo = r.itens.find((i) => i.id === procSigilo)!;
    expect(sigilo.restrito).toBe(true);
    expect(sigilo.partes).toBeUndefined();
    expect(sigilo.titulo).toBeUndefined();
    expect(JSON.stringify(sigilo)).not.toMatch(/Sigilosa|menor/);
    // Buscar pelo nome da parte NÃO revela o processo sigiloso.
    const porParte = await chamar<{ itens: { id: string }[] }>(BIA, "assistente_buscar_processos", { p_escritorio: esc, p_termo: "Parte Sigilosa", p_limite: 10 });
    expect(porParte.itens).toEqual([]);
  });

  it("publicação de processo em segredo vem sem trecho; a normal vem com trecho", async () => {
    const r = await chamar<{ itens: { processo_id: string; trecho: string | null; restrito: boolean }[] }>(BIA, "assistente_buscar_publicacoes", { p_escritorio: esc, p_limite: 10 });
    expect(r.itens.find((i) => i.processo_id === proc)?.trecho).toContain("15 dias");
    const s = r.itens.find((i) => i.processo_id === procSigilo)!;
    expect(s).toMatchObject({ restrito: true, trecho: null });
    const porTexto = await chamar<{ itens: unknown[] }>(BIA, "assistente_buscar_publicacoes", { p_escritorio: esc, p_termo: "guarda do menor", p_limite: 10 });
    expect(porTexto.itens).toEqual([]);
  });

  it("buscar_clientes não manda CPF/CNPJ", async () => {
    const r = await chamar<{ itens: Record<string, unknown>[] }>(BIA, "assistente_buscar_clientes", { p_escritorio: esc, p_termo: "fulano de tal", p_limite: 5 });
    expect(r.itens[0]).toMatchObject({ id: fulano, nome: "Fulano de Tal", link: `/app/processos/clientes/${fulano}` });
    expect(JSON.stringify(r)).not.toContain(CPF_FICTICIO);
    expect(r.itens[0].documento).toBeUndefined();
  });

  it("as fontes da resposta são as que as ferramentas devolveram (a tela só cria link para elas)", async () => {
    const ia = new IaRoteiro([[usar("buscar_processos", { termo: CNJ })], [texto(`Achei o [Processo 0001234-56.2026.8.05.0001](/app/processos/${proc}).`)]]);
    const r = await responder({ ia, ctx: { ...(await ctxDe(BIA)), conversaId: await novaConversa(BIA) }, historico: [], pergunta: "qual o processo do Fulano?" });
    expect(r.fontes).toEqual([{ ref: `processo:${proc}`, rotulo: "Processo 0001234-56.2026.8.05.0001", link: `/app/processos/${proc}` }]);
  });

  it("quem não tem a Lia não usa nenhuma ferramenta nem cria conversa", async () => {
    await expect(chamar(CAIO, "assistente_contexto", { p_escritorio: esc })).rejects.toThrow(/sem_permissao/);
    await expect(chamar(CAIO, "assistente_buscar_lancamentos", { p_escritorio: esc })).rejects.toThrow(/sem_permissao/);
    await expect(chamar(CAIO, "assistente_conversa_criar", { p_escritorio: esc, p_titulo: "x" })).rejects.toThrow(/sem_permissao/);
  });

  it("outro escritório (RLS cruzada): não lê, não busca, não confirma", async () => {
    await expect(chamar(ZE, "assistente_buscar_processos", { p_escritorio: esc })).rejects.toThrow(/sem_permissao/);
    await expect(chamar(ZE, "assistente_contexto", { p_escritorio: esc })).rejects.toThrow(/sem_permissao/);
    for (const t of ["assistente_conversa", "assistente_mensagem", "assistente_rascunho", "modelo_contrato", "minuta"]) {
      expect(await consultar(ZE, `select id from public.${t}`), t).toEqual([]);
    }
    const [r] = (await db.query<{ id: string }>("select id from public.assistente_rascunho where escritorio_id = $1 limit 1", [esc])).rows;
    await expect(chamar(ZE, "assistente_rascunho_confirmar", { p_rascunho: r.id, p_dados: {} })).rejects.toThrow(/nao_encontrado/);
    await expect(chamar(ZE, "assistente_rascunho_descartar", { p_rascunho: r.id })).rejects.toThrow(/nao_encontrado/);
    // O próprio escritório do Zé funciona normalmente (e só vê os dados dele).
    const proprio = await chamar<{ itens: unknown[] }>(ZE, "assistente_buscar_processos", { p_escritorio: escZe });
    expect(proprio.itens).toEqual([]);
  });

  it("conversa é só de quem conversou: a dona não lê a conversa da Bia pela tabela (vê no audit_log)", async () => {
    const conversa = await novaConversa(BIA);
    await chamar(BIA, "assistente_mensagem_registrar", { p_conversa: conversa, p_papel: "usuario", p_texto: "pergunta da Bia" });
    expect(await consultar(ANA, "select id from public.assistente_mensagem where conversa_id = $1", [conversa])).toEqual([]);
    await expect(chamar(ANA, "assistente_mensagem_registrar", { p_conversa: conversa, p_papel: "usuario", p_texto: "intrusa" })).rejects.toThrow(/nao_encontrado/);
    const log = await consultar<{ depois: { texto: string } }>(ANA, "select depois from public.audit_log where tabela = 'assistente_mensagem' and depois->>'conversa_id' = $1", [conversa]);
    expect(log.map((l) => l.depois.texto)).toEqual(["pergunta da Bia"]);
  });
});

describe("Mensagens só-acréscimo e rascunho protegido", () => {
  it("ninguém edita nem apaga mensagem, nem o dono da tabela", async () => {
    const conversa = await novaConversa(BIA);
    const id = await chamar<string>(BIA, "assistente_mensagem_registrar", { p_conversa: conversa, p_papel: "usuario", p_texto: "original" });
    await expect(consultar(BIA, "update public.assistente_mensagem set texto = 'x' where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(consultar(BIA, "delete from public.assistente_mensagem where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.assistente_mensagem set texto = 'x' where id = $1", [id])).rejects.toThrow(/campo_imutavel/);
    await expect(db.query("delete from public.assistente_mensagem where id = $1", [id])).rejects.toThrow(/campo_imutavel/);
  });

  it("dados do rascunho não mudam depois de criado; rascunho com mais de 24 h não confirma", async () => {
    const conversa = await novaConversa(BIA);
    const id = await chamar<string>(BIA, "assistente_rascunho_criar", { p_conversa: conversa, p_tipo: "tarefa", p_dados: { titulo: "A" }, p_resumo: "Tarefa A", p_avisos: [] });
    await expect(db.query("update public.assistente_rascunho set dados = '{\"titulo\":\"B\"}' where id = $1", [id])).rejects.toThrow(/campo_imutavel/);
    await expect(consultar(BIA, "update public.assistente_rascunho set status = 'descartado' where id = $1", [id])).rejects.toThrow(/permission denied/);
    await db.exec("alter table public.assistente_rascunho disable trigger assistente_rascunho_protecao");
    await db.query("update public.assistente_rascunho set criado_em = now() - interval '25 hours' where id = $1", [id]);
    await db.exec("alter table public.assistente_rascunho enable trigger assistente_rascunho_protecao");
    await expect(chamar(BIA, "assistente_rascunho_confirmar", { p_rascunho: id, p_dados: { titulo: "A" } })).rejects.toThrow(/rascunho_vencido/);
  });
});

describe("Tarefa, prazo e minuta", () => {
  it("tarefa: rascunho com responsável e coluna; grava só no Confirmar", async () => {
    const ctx = await ctxDe(BIA);
    const ia = new IaRoteiro([[usar("preparar_tarefa", { titulo: "Ligar para o Fulano", data: "2031-03-10", processo: CNJ, cliente: "Fulano de Tal" })], [texto("Rascunho pronto.")]]);
    const antes = await contar("tarefa");
    const r = await responder({ ia, ctx: { ...ctx, conversaId: await novaConversa(BIA) }, historico: [], pergunta: "cria tarefa de ligar pro Fulano dia 10/03/2031" });
    expect(await contar("tarefa")).toBe(antes);
    const [rasc] = await consultar<{ id: string; dados: Record<string, unknown> }>(BIA, "select id, dados from public.assistente_rascunho where id = $1", [r.rascunhos[0]]);
    const bia = ctx.contexto.meu_membro_id;
    expect(rasc.dados).toMatchObject({ titulo: "Ligar para o Fulano", data: "2031-03-10", responsavel_id: bia, processo_id: proc, cliente_id: fulano, coluna_id: ctx.contexto.colunas[0].id });
    const final = await dadosParaConfirmar("tarefa", rasc.dados, {
      titulo: "Ligar para o Fulano", descricao: "", data: "2031-03-10", responsavel_id: bia, coluna_id: ctx.contexto.colunas[0].id, processo_id: proc, cliente_id: fulano, etiquetas: "cliente, urgente",
    }, ctx);
    const res = await chamar<{ id: string }>(BIA, "assistente_rascunho_confirmar", { p_rascunho: rasc.id, p_dados: final });
    const t = await um<{ titulo: string; etiquetas: string[]; criado_por: string }>("select titulo, etiquetas, criado_por from public.tarefa where id = $1", [res.id]);
    expect(t).toMatchObject({ titulo: "Ligar para o Fulano", criado_por: BIA });
    expect(t.etiquetas.length).toBe(2);
  });

  it("prazo: a data vem do módulo de contagem (a IA não consegue mandar a data final)", async () => {
    const ctx = await ctxDe(ANA);
    const ia = new IaRoteiro([[usar("preparar_prazo", { processo: CNJ, descricao: "Manifestação sobre a contestação", dias: 15, data_disponibilizacao: "2026-11-03", data_final: "2099-01-01" })], [texto("Rascunho do prazo pronto.")]]);
    const antes = await contar("prazo");
    const r = await responder({ ia, ctx: { ...ctx, conversaId: await novaConversa(ANA) }, historico: [], pergunta: "prazo de 15 dias da publicação de 03/11" });
    expect(await contar("prazo")).toBe(antes);
    const esperado = calcularPrazo({ disponibilizacao: "2026-11-03", dias: 15, tipo: "util", calendario: entradasDoTribunal(await ctx.carregarCalendario(), "TJBA") });
    const [rasc] = await consultar<{ id: string; dados: Record<string, unknown>; avisos: string[] }>(ANA, "select id, dados, avisos from public.assistente_rascunho where id = $1", [r.rascunhos[0]]);
    expect(rasc.dados.data_final).toBe(esperado.dataFinal);
    expect(rasc.dados.data_final).not.toBe("2099-01-01");
    expect(rasc.avisos.join(" ")).toMatch(/sistema oficial do tribunal/);
    const final = await dadosParaConfirmar("prazo", rasc.dados, { descricao: "Manifestação sobre a contestação", responsavel_id: ctx.contexto.meu_membro_id, esperada: esperado.dataFinal }, ctx);
    // A data que o usuário viu tem de bater com o recálculo.
    await expect(dadosParaConfirmar("prazo", rasc.dados, { descricao: "x x x", responsavel_id: ctx.contexto.meu_membro_id, esperada: "2099-01-01" }, ctx)).rejects.toThrow(/mudou/);
    const res = await chamar<{ id: string; link: string }>(ANA, "assistente_rascunho_confirmar", { p_rascunho: rasc.id, p_dados: final });
    expect(res.link).toBe(`/app/processos/${proc}`);
    expect((await um<{ d: string }>("select data_final::text as d from public.prazo where id = $1", [res.id])).d).toBe(esperado.dataFinal);
  });

  it("minuta: parte de modelo do escritório, CPF não vai para a IA, nasce NÃO REVISADA", async () => {
    await chamar(ANA, "modelo_contrato_salvar", {
      p_escritorio: esc, p_id: null, p_nome: "Contrato de honorários", p_descricao: "Honorários fixos",
      p_texto: "CONTRATANTE: {{cliente_nome}}, CPF {{cliente_documento}}.\nCONTRATADO: {{escritorio_nome}}.\nHONORÁRIOS: {{valor_honorarios}}.\nOBJETO: {{objeto}}.\n{{data_hoje}}.",
    });
    const ctx = await ctxDe(ANA);
    const ia = new IaRoteiro([[usar("preparar_minuta", { modelo: "contrato de honorarios", cliente: "Fulano de Tal", campos: { valor_honorarios: "R$ 5.000,00", inventado: "x" } })], [texto("Minuta preparada.")]]);
    const r = await responder({ ia, ctx: { ...ctx, conversaId: await novaConversa(ANA) }, historico: [], pergunta: "gera o contrato de honorários do Fulano, 5 mil" });
    const paraIa = ia.resultados()[0].content;
    expect(paraIa).not.toContain("529.982.247-25");
    expect(JSON.parse(paraIa).campos_faltando).toEqual(["objeto"]);
    expect(await contar("minuta")).toBe(0);
    const [rasc] = await consultar<{ id: string; dados: Record<string, unknown> & { _exibir: { previa: string } } }>(ANA, "select id, dados from public.assistente_rascunho where id = $1", [r.rascunhos[0]]);
    expect(rasc.dados.campos).toEqual({ valor_honorarios: "R$ 5.000,00" }); // campo que não existe no modelo é ignorado
    expect(rasc.dados._exibir.previa).toContain("[PREENCHER: objeto]");
    const original: Record<string, unknown> = { ...rasc.dados };
    delete original._exibir;
    const final = await dadosParaConfirmar("minuta", original, { titulo: "Contrato — Fulano", campo_valor_honorarios: "R$ 5.000,00", campo_objeto: "Ação de cobrança" }, ctx);
    const res = await chamar<{ id: string }>(ANA, "assistente_rascunho_confirmar", { p_rascunho: rasc.id, p_dados: final });
    const m = await um<{ texto: string; status: string; origem: string }>("select texto, status, origem from public.minuta where id = $1", [res.id]);
    expect(m.status).toBe("nao_revisado");
    expect(m.origem).toBe("assistente");
    expect(m.texto).toContain("CONTRATANTE: Fulano de Tal, CPF 529.982.247-25.");
    expect(m.texto).toContain("CONTRATADO: Prado Advocacia.");
    expect(m.texto).toContain("OBJETO: Ação de cobrança.");
    expect(m.texto).not.toContain("PREENCHER");
    await chamar(ANA, "minuta_marcar_revisada", { p_id: res.id });
    expect((await um<{ s: string }>("select status as s from public.minuta where id = $1", [res.id])).s).toBe("revisado");
    // Bia (sem Documentos) não lê minutas nem modelos e não consegue preparar minuta.
    expect(await consultar(BIA, "select id from public.minuta")).toEqual([]);
    expect(await consultar(BIA, "select id from public.modelo_contrato")).toEqual([]);
    const conv = await novaConversa(BIA);
    await expect(chamar(BIA, "assistente_rascunho_criar", { p_conversa: conv, p_tipo: "minuta", p_dados: {}, p_resumo: "x", p_avisos: [] })).rejects.toThrow(/sem_permissao/);
  });
});
