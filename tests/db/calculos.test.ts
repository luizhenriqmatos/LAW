import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { REGIMES_CIVEIS_PADRAO, REGIMES_TRABALHISTAS_PADRAO } from "@/lib/calculos/regimes-padrao";
import { comoUsuario, criarBanco, criarUsuario, rpcComoServico } from "./banco";

const ANA = "00000000-0000-4000-8000-0000000000e1"; // dona
const BIA = "00000000-0000-4000-8000-0000000000e2"; // membro SEM cálculos (processos, financeiro)
const CAIO = "00000000-0000-4000-8000-0000000000e3"; // membro só com cálculos
const ZE = "00000000-0000-4000-8000-0000000000e4"; // dono de outro escritório

let db: PGlite;
let esc: string, escZe: string, proc: string, procProv: string, procZe: string;

const chamar = (uid: string, sql: string, p: unknown[] = []) => comoUsuario(db, uid, (tx) => tx.query(sql, p));
const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const rpcUser = async <T,>(uid: string, sql: string, p: unknown[] = []) => ((await chamar(uid, sql, p)).rows[0] as { r: T }).r;

const REGIME_PERSONALIZADO = {
  nome: "Critério da sentença: IPCA-E + 0,5% a.m.", escopo: "civel", fundamento: "Sentença, fls. 120: IPCA-E desde o vencimento e juros de 0,5% ao mês desde a citação.",
  correcao_indice: "IPCA_E", juros_tipo: "percentual_ao_mes", juros_valor: "0.5",
};
const salvar = (uid: string, dados: Record<string, unknown>, id: string | null = null, e = esc) =>
  rpcUser<string>(uid, "select public.calculo_salvar($1, $2, $3::jsonb) as r", [e, id, JSON.stringify({
    tipo: "atualizacao", titulo: "Atualização teste", parametros: { valorCentavos: 100 }, resultado: { versao: 1 },
    total_centavos: 123, data_calculo: "2026-11-09", regimes: REGIMES_CIVEIS_PADRAO.map((r) => r.id), ...dados,
  })]);

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, e] of [[ANA, "ana@c.com"], [BIA, "bia@c.com"], [CAIO, "caio@c.com"], [ZE, "ze@c.com"]]) await criarUsuario(db, id, e);
  esc = await rpcUser<string>(ANA, "select public.criar_escritorio('Prado Advocacia', null, 'equipe') as r");
  escZe = await rpcUser<string>(ZE, "select public.criar_escritorio('Outro', null, 'equipe') as r");
  const t1 = await rpcUser<string>(ANA, "select public.criar_convite($1, 'bia@c.com', '{processos,financeiro}'::text[]) as r", [esc]);
  await chamar(BIA, "select public.aceitar_convite($1)", [t1]);
  const t2 = await rpcUser<string>(ANA, "select public.criar_convite($1, 'caio@c.com', '{calculos}'::text[]) as r", [esc]);
  await chamar(CAIO, "select public.aceitar_convite($1)", [t2]);
  const p = async (e: string, cnj: string, status = "confirmado") => (await um<{ id: string }>("insert into public.processo (escritorio_id, numero_cnj, status, tribunal) values ($1, $2, $3, 'TJBA') returning id", [e, cnj, status])).id;
  proc = await p(esc, "00000011220268050001");
  procProv = await p(esc, "00000022320268050001", "provisorio");
  procZe = await p(escZe, "00000033420268050001");
  await db.query("insert into public.processo_parte (escritorio_id, processo_id, nome, polo) values ($1, $2, 'Maria Autora', 'ativo'), ($1, $2, 'Banco Réu S.A.', 'passivo')", [esc, proc]);
});

describe("Índices em cache", () => {
  it("carga inicial com os valores do SGS, sem a Selic parcial do mês corrente", async () => {
    const v = async (s: string, m: string) => (await um<{ v: string } | undefined>("select valor::text as v from public.indice_valor where serie = $1 and mes = $2", [s, m]))?.v;
    expect(await v("IPCA", "2023-01-01")).toBe("0.5300000000");
    expect(await v("TAXA_LEGAL", "2025-03-01")).toBe("0.0000000000");
    expect(await v("TAXA_LEGAL", "2024-08-01")).toBe("0.6053060000");
    expect(await v("SELIC", "2026-11-01")).toBeUndefined();
    const s = await um<{ n: number }>("select count(*)::int as n from public.indice_serie where coletado_em is not null and ultimo_mes is not null");
    expect(s.n).toBe(8);
  });

  it("qualquer membro lê (dado público), ninguém do app grava; só o job (service_role)", async () => {
    const r = await rpcUser<{ valores: Record<string, Record<string, string>> }>(BIA, "select public.indices_periodo('{IPCA,TAXA_LEGAL}'::text[], '2025-01-10', '2025-03-01') as r");
    expect(r.valores.IPCA).toEqual({ "2025-01": "0.1600000000", "2025-02": "1.3100000000", "2025-03": "0.5600000000" });
    await expect(chamar(ANA, "insert into public.indice_valor (serie, mes, valor) values ('IPCA', '2030-01-01', 9)")).rejects.toThrow();
    await expect(chamar(ANA, "select public.indices_gravar('IPCA', '[]'::jsonb)")).rejects.toThrow(/permission denied/);
    const rpc = rpcComoServico(db);
    await rpc("indices_gravar", { p_serie: "IPCA", p_valores: [{ mes: "2026-10-01", valor: "0.09" }] });
    expect((await um<{ m: string }>("select ultimo_mes::text as m from public.indice_serie where codigo = 'IPCA'")).m).toBe("2026-10-01");
    await rpc("indices_gravar", { p_serie: "IPCA", p_valores: [{ mes: "2026-10-01", valor: "0.10" }] }); // revisão na fonte
    expect((await um<{ v: string }>("select valor::text as v from public.indice_valor where serie = 'IPCA' and mes = '2026-10-01'")).v).toBe("0.1000000000");
  });
});

describe("Regimes", () => {
  it("os regimes padrão do banco (cíveis e trabalhistas) são os mesmos do código", async () => {
    const linhas = (await db.query<Record<string, unknown>>("select id, escopo, vigencia_inicio::text, vigencia_fim::text, inicio_no_marco, fim_no_marco, correcao_indice, juros_tipo, juros_valor::float as juros_valor, juros_pro_rata, correcao_pro_rata, indice_editavel, nome, fundamento from public.regime_atualizacao where escritorio_id is null order by id")).rows;
    expect(linhas).toEqual([...REGIMES_CIVEIS_PADRAO, ...REGIMES_TRABALHISTAS_PADRAO].map((r) => ({
      id: r.id, escopo: r.escopo, vigencia_inicio: r.vigencia_inicio, vigencia_fim: r.vigencia_fim, inicio_no_marco: r.inicio_no_marco ?? null, fim_no_marco: r.fim_no_marco ?? null,
      correcao_indice: r.correcao_indice, juros_tipo: r.juros_tipo,
      juros_valor: r.juros_valor === null ? null : Number(r.juros_valor), juros_pro_rata: r.juros_pro_rata, correcao_pro_rata: r.correcao_pro_rata,
      indice_editavel: r.indice_editavel, nome: r.nome, fundamento: r.fundamento,
    })));
  });

  it("regime personalizado; mudança vira NOVA VERSÃO e a antiga continua igual", async () => {
    const v1 = await rpcUser<string>(CAIO, "select public.regime_criar($1, $2::jsonb) as r", [esc, JSON.stringify(REGIME_PERSONALIZADO)]);
    const v2 = await rpcUser<string>(CAIO, "select public.regime_nova_versao($1, $2::jsonb) as r", [v1, JSON.stringify({ ...REGIME_PERSONALIZADO, juros_valor: "1" })]);
    const rs = (await db.query<{ id: string; versao: number; ativo: boolean; juros_valor: string; grupo_id: string }>("select id, versao, ativo, juros_valor::text, grupo_id from public.regime_atualizacao where grupo_id = $1 order by versao", [v1])).rows;
    expect(rs.map((r) => [r.id, r.versao, r.ativo, r.juros_valor])).toEqual([[v1, 1, false, "0.500000"], [v2, 2, true, "1.000000"]]);
    // A versão inativa não aceita nova versão (evita duas linhas de evolução).
    await expect(chamar(CAIO, "select public.regime_nova_versao($1, $2::jsonb)", [v1, JSON.stringify(REGIME_PERSONALIZADO)])).rejects.toThrow(/regime_desatualizado/);
  });

  it("ninguém altera um regime: nem pelo app, nem por função (gatilho)", async () => {
    const id = REGIMES_CIVEIS_PADRAO[0].id;
    await expect(chamar(ANA, "update public.regime_atualizacao set juros_valor = 2 where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.regime_atualizacao set juros_valor = 2 where id = $1", [id])).rejects.toThrow(/regime_imutavel/);
    await expect(db.query("delete from public.regime_atualizacao where id = $1", [id])).rejects.toThrow(/regime_imutavel/);
    await expect(chamar(ANA, "select public.regime_nova_versao($1, '{}'::jsonb)", [id])).rejects.toThrow(/regime_do_sistema/);
  });

  it("regime personalizado pode começar ou terminar num marco do processo", async () => {
    const id = await rpcUser<string>(CAIO, "select public.regime_criar($1, $2::jsonb) as r", [esc, JSON.stringify({ ...REGIME_PERSONALIZADO, escopo: "trabalhista", fim_no_marco: "ajuizamento" })]);
    expect((await um<{ f: string }>("select fim_no_marco as f from public.regime_atualizacao where id = $1", [id])).f).toBe("ajuizamento");
    await expect(chamar(CAIO, "select public.regime_criar($1, $2::jsonb)", [esc, JSON.stringify({ ...REGIME_PERSONALIZADO, fim_no_marco: "lua_cheia" })])).rejects.toThrow(/regime_invalido/);
  });

  it("Selic + outro índice no mesmo regime é recusado", async () => {
    await expect(chamar(ANA, "select public.regime_criar($1, $2::jsonb)", [esc, JSON.stringify({ ...REGIME_PERSONALIZADO, juros_tipo: "selic_englobando_correcao_e_juros", juros_valor: null })])).rejects.toThrow(/selic_com_indice/);
  });
});

describe("Cálculos salvos", () => {
  let calc: string;
  it("cria com marcos; edita trocando os marcos; duplica guardando a origem", async () => {
    calc = await salvar(CAIO, { processo_id: proc, marcos: [{ tipo: "vencimento", data: "2023-05-15" }, { tipo: "citacao", data: "2023-09-01" }] });
    expect((await db.query("select tipo from public.marco_processual where calculo_id = $1 order by tipo", [calc])).rows).toEqual([{ tipo: "citacao" }, { tipo: "vencimento" }]);
    await salvar(CAIO, { processo_id: proc, titulo: "Editado", total_centavos: 999, marcos: [{ tipo: "intimacao", data: "2025-03-10" }] }, calc);
    const c = await um<{ titulo: string; total_centavos: string }>("select titulo, total_centavos::text from public.calculo where id = $1", [calc]);
    expect(c).toEqual({ titulo: "Editado", total_centavos: "999" });
    expect((await db.query("select tipo from public.marco_processual where calculo_id = $1", [calc])).rows).toEqual([{ tipo: "intimacao" }]);
    const copia = await salvar(CAIO, { origem_id: calc, titulo: "Editado (cópia)" });
    expect((await um<{ o: string }>("select origem_id::text as o from public.calculo where id = $1", [copia])).o).toBe(calc);
    expect((await db.query("select 1 from public.audit_log where tabela = 'calculo' and registro_id = $1", [calc])).rows.length).toBeGreaterThanOrEqual(2);
  });

  it("recusa processo provisório, processo de outro escritório, regime de outro escritório e troca de tipo", async () => {
    await expect(salvar(CAIO, { processo_id: procProv })).rejects.toThrow(/processo_invalido/);
    await expect(salvar(CAIO, { processo_id: procZe })).rejects.toThrow(/processo_invalido/);
    const deZe = await rpcUser<string>(ZE, "select public.regime_criar($1, $2::jsonb) as r", [escZe, JSON.stringify(REGIME_PERSONALIZADO)]);
    await expect(salvar(CAIO, { regimes: [deZe] })).rejects.toThrow(/regime_invalido/);
    await expect(salvar(CAIO, { tipo: "honorarios" }, calc)).rejects.toThrow(/tipo_invalido/);
    await expect(salvar(CAIO, { tipo: "inventado" })).rejects.toThrow(/tipo_invalido/);
    const trab = await salvar(CAIO, { tipo: "trabalhista", regimes: REGIMES_TRABALHISTAS_PADRAO.map((r) => r.id), marcos: [{ tipo: "ajuizamento", data: "2023-03-15" }] });
    expect((await um<{ tipo: string }>("select tipo from public.calculo where id = $1", [trab])).tipo).toBe("trabalhista");
  });

  it("opções: processos confirmados com tribunal e partes por polo", async () => {
    const op = await rpcUser<{ id: string; tribunal: string; ativo: string; passivo: string }[]>(CAIO, "select public.calculo_opcoes($1) as r", [esc]);
    expect(op).toHaveLength(1);
    expect(op[0]).toMatchObject({ id: proc, tribunal: "TJBA", ativo: "Maria Autora", passivo: "Banco Réu S.A." });
  });
});

describe("Permissão (três camadas: aqui a do banco)", () => {
  it("membro SEM a tela Cálculos não vê cálculo nem regime do escritório, e toda função recusa", async () => {
    for (const t of ["calculo", "marco_processual"]) expect((await chamar(BIA, `select * from public.${t}`)).rows, t).toHaveLength(0);
    expect((await chamar(BIA, "select * from public.regime_atualizacao where escritorio_id is not null")).rows).toHaveLength(0);
    // Os regimes padrão (lei) são públicos.
    expect((await chamar(BIA, "select * from public.regime_atualizacao where escritorio_id is null")).rows).toHaveLength(5);
    for (const [sql, args] of [
      ["select public.calculo_opcoes($1)", [esc]],
      ["select public.regime_criar($1, $2::jsonb)", [esc, JSON.stringify(REGIME_PERSONALIZADO)]],
      ["select public.calculo_salvar($1, null, '{}'::jsonb)", [esc]],
    ] as [string, unknown[]][]) await expect(chamar(BIA, sql, args), sql).rejects.toThrow(/sem_permissao/);
    const algum = (await um<{ id: string }>("select id from public.calculo limit 1")).id;
    await expect(chamar(BIA, "select public.calculo_excluir($1)", [algum])).rejects.toThrow(/sem_permissao/);
  });

  it("outro escritório não vê nem mexe", async () => {
    expect((await chamar(ZE, "select * from public.calculo where escritorio_id = $1", [esc])).rows).toHaveLength(0);
    await expect(chamar(ZE, "select public.calculo_opcoes($1)", [esc])).rejects.toThrow(/sem_permissao/);
    const algum = (await um<{ id: string }>("select id from public.calculo where escritorio_id = $1 limit 1", [esc])).id;
    await expect(chamar(ZE, "select public.calculo_registrar_pdf($1, 'x')", [algum])).rejects.toThrow(/sem_permissao/);
  });

  it("dono vê tudo (módulo novo entra para o dono automaticamente) e exclui", async () => {
    expect((await rpcUser<string[]>(ANA, "select public.meus_modulos($1) as r", [esc]))).toContain("calculos");
    const id = await salvar(ANA, { titulo: "Para excluir" });
    await chamar(ANA, "select public.calculo_excluir($1)", [id]);
    expect((await db.query("select 1 from public.calculo where id = $1", [id])).rows).toHaveLength(0);
  });
});
