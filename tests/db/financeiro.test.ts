import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { dividirEmParcelas, vencimentosMensais } from "@/lib/financeiro/parcelas";
import { comoUsuario, criarBanco, criarUsuario, rpcComoServico } from "./banco";

const ANA = "00000000-0000-4000-8000-0000000000d1"; // dona
const BIA = "00000000-0000-4000-8000-0000000000d2"; // membro: processos, SEM financeiro
const CAIO = "00000000-0000-4000-8000-0000000000d3"; // membro: só financeiro
const ZE = "00000000-0000-4000-8000-0000000000d4"; // dono de outro escritório

let db: PGlite;
let esc: string;
let escZe: string;
let cliA: string, cliB: string, cliProv: string, proc1: string, proc2: string, procProv: string;
let H: string; // hoje em Brasília, igual ao do banco

const chamar = (uid: string, sql: string, p: unknown[] = []) => comoUsuario(db, uid, (tx) => tx.query(sql, p));
const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const rpcUser = async <T,>(uid: string, sql: string, p: unknown[] = []) => ((await chamar(uid, sql, p)).rows[0] as { r: T }).r;
const dia = async (expr: string) => (await um<{ d: string }>(`select (${expr})::date::text as d`)).d;

type Dados = Record<string, unknown>;
const criar = (uid: string, d: Dados, e = esc) => rpcUser<string>(uid, "select public.lancamento_criar($1, $2::jsonb) as r", [e, JSON.stringify(d)]);
const parcelasDe = async (lanc: string) => (await db.query<{ id: string; numero: number; valor_centavos: string; valor_pago_centavos: string; status: string; vencimento: string; data_pagamento: string | null }>(
  "select id, numero, valor_centavos::text, valor_pago_centavos::text, status, vencimento::text, data_pagamento::text from public.parcela where lancamento_id = $1 order by numero", [lanc])).rows;
const pagar = (uid: string, parcela: string, valor: number, data: string | null = null, forma: string | null = "pix") =>
  rpcUser<string>(uid, "select public.pagamento_registrar($1, $2, $3::date, $4) as r", [parcela, valor, data, forma]);

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, e] of [[ANA, "ana@t.com"], [BIA, "bia@t.com"], [CAIO, "caio@t.com"], [ZE, "ze@t.com"]]) await criarUsuario(db, id, e);
  esc = await rpcUser<string>(ANA, "select public.criar_escritorio('Prado Advocacia', null, 'equipe') as r");
  escZe = await rpcUser<string>(ZE, "select public.criar_escritorio('Outro', null, 'equipe') as r");
  const t1 = await rpcUser<string>(ANA, "select public.criar_convite($1, 'bia@t.com', '{processos,agenda}'::text[]) as r", [esc]);
  await chamar(BIA, "select public.aceitar_convite($1)", [t1]);
  const t2 = await rpcUser<string>(ANA, "select public.criar_convite($1, 'caio@t.com', '{financeiro}'::text[]) as r", [esc]);
  await chamar(CAIO, "select public.aceitar_convite($1)", [t2]);
  const cli = async (nome: string, status = "confirmado") => (await um<{ id: string }>("insert into public.cliente (escritorio_id, nome, status) values ($1, $2, $3) returning id", [esc, nome, status])).id;
  cliA = await cli("Maria Silva");
  cliB = await cli("Empresa Beta Ltda");
  cliProv = await cli("Provisório Zé", "provisorio");
  const proc = async (cnj: string, status = "confirmado") => (await um<{ id: string }>("insert into public.processo (escritorio_id, numero_cnj, status) values ($1, $2, $3) returning id", [esc, cnj, status])).id;
  proc1 = await proc("00000011220268050001");
  proc2 = await proc("00000022320268050001");
  procProv = await proc("00000033420268050001", "provisorio");
  H = await dia("public.hoje_brasilia()");
});

describe("Parcelamento no banco", () => {
  it("valores que não dividem exato: a diferença de centavos vai para a primeira parcela", async () => {
    const l = await criar(ANA, { tipo: "receita", categoria: "honorarios_contratuais", cliente_id: cliA, descricao: "Honorários", valor_centavos: 100000, parcelas: 3, primeiro_vencimento: await dia(`'${H}'::date + 30`) });
    const p = await parcelasDe(l);
    expect(p.map((x) => Number(x.valor_centavos))).toEqual([33334, 33333, 33333]);
    expect(p.reduce((s, x) => s + Number(x.valor_centavos), 0)).toBe(100000);
    expect(p.map((x) => x.status)).toEqual(["aberta", "aberta", "aberta"]);
  });

  it("o banco e o código TypeScript fazem exatamente a mesma divisão e os mesmos vencimentos", async () => {
    const venc0 = "2031-01-31";
    for (const [total, n] of [[10000, 3], [100, 7], [1, 1], [99999, 12], [7, 7], [123457, 120], [10001, 4], [50000, 10]] as const) {
      const l = await criar(ANA, { tipo: "despesa", categoria: "despesa_fixa", descricao: `Teste ${total}/${n}`, valor_centavos: total, parcelas: n, primeiro_vencimento: venc0 });
      const p = await parcelasDe(l);
      expect(p.map((x) => Number(x.valor_centavos)), `${total}/${n}`).toEqual(dividirEmParcelas(total, n));
      expect(p.map((x) => x.vencimento), `${total}/${n}`).toEqual(vencimentosMensais(venc0, n));
    }
  });

  it("dia 31 vira 28 em fevereiro e volta ao 31 em março", async () => {
    const l = await criar(ANA, { tipo: "despesa", categoria: "outros", descricao: "Dia 31", valor_centavos: 3000, parcelas: 3, primeiro_vencimento: "2031-01-31" });
    expect((await parcelasDe(l)).map((x) => x.vencimento)).toEqual(["2031-01-31", "2031-02-28", "2031-03-31"]);
  });

  it("parcela que já nasce vencida entra como atrasada", async () => {
    const l = await criar(ANA, { tipo: "receita", categoria: "custas", cliente_id: cliA, descricao: "Retroativo", valor_centavos: 20000, parcelas: 2, primeiro_vencimento: await dia(`'${H}'::date - 5`) });
    expect((await parcelasDe(l)).map((x) => x.status)).toEqual(["atrasada", "aberta"]);
  });

  it("recusa dados inválidos com erro claro", async () => {
    const base = { tipo: "receita", categoria: "exito", cliente_id: cliA, descricao: "X Y", valor_centavos: 1000, parcelas: 1, primeiro_vencimento: "2031-01-10" };
    const falha = (d: Dados, esperado: RegExp) => expect(criar(ANA, { ...base, ...d })).rejects.toThrow(esperado);
    await falha({ tipo: "x" }, /tipo_invalido/);
    await falha({ categoria: "x" }, /categoria_invalida/);
    await falha({ descricao: " " }, /descricao_invalida/);
    await falha({ valor_centavos: 0 }, /valor_invalido/);
    await falha({ valor_centavos: -5 }, /valor_invalido/);
    await falha({ parcelas: 0 }, /parcelas_invalidas/);
    await falha({ parcelas: 121 }, /parcelas_invalidas/);
    await falha({ valor_centavos: 2, parcelas: 3 }, /parcelas_demais/);
    await falha({ primeiro_vencimento: "" }, /vencimento_invalido/);
    await falha({ cliente_id: null }, /cliente_obrigatorio/);
    await falha({ cliente_id: cliProv }, /vinculo_provisorio/);
    await falha({ processo_id: procProv }, /vinculo_provisorio/);
  });
});

describe("Pagamento parcial e saldo", () => {
  let lanc: string;
  beforeAll(async () => {
    lanc = await criar(ANA, { tipo: "receita", categoria: "honorarios_contratuais", cliente_id: cliB, processo_id: proc2, descricao: "Contrato Beta", valor_centavos: 100000, parcelas: 3, primeiro_vencimento: await dia(`'${H}'::date + 10`) });
  });
  const saldoCliente = async (id: string) => {
    const r = await rpcUser<{ id: string; em_aberto: number; atrasado: number; recebido: number }[]>(ANA, "select public.financeiro_saldos($1, 'cliente') as r", [esc]);
    return r.find((x) => x.id === id);
  };
  const saldoProcesso = async (id: string) => {
    const r = await rpcUser<{ id: string; em_aberto: number }[]>(ANA, "select public.financeiro_saldos($1, 'processo') as r", [esc]);
    return r.find((x) => x.id === id);
  };

  it("antes de pagar: saldo = soma de todas as parcelas, por cliente e por processo", async () => {
    expect((await saldoCliente(cliB))?.em_aberto).toBe(100000);
    expect((await saldoProcesso(proc2))?.em_aberto).toBe(100000);
  });

  it("pagamento parcial: parcela vira “parcial” e o saldo cai só o que foi pago", async () => {
    const [p1] = await parcelasDe(lanc);
    await pagar(ANA, p1.id, 10000);
    const [a] = await parcelasDe(lanc);
    expect(a).toMatchObject({ status: "parcial", valor_pago_centavos: "10000", data_pagamento: H });
    expect((await saldoCliente(cliB))?.em_aberto).toBe(90000);
    expect((await saldoCliente(cliB))?.recebido).toBe(10000);
    expect((await saldoProcesso(proc2))?.em_aberto).toBe(90000);
  });

  it("segundo pagamento completa a parcela: vira “paga” e o saldo cai de novo", async () => {
    const [p1] = await parcelasDe(lanc);
    await pagar(ANA, p1.id, 23334, H, "transferencia");
    const [a, b, c] = await parcelasDe(lanc);
    expect(a).toMatchObject({ status: "paga", valor_pago_centavos: "33334" });
    expect([b.status, c.status]).toEqual(["aberta", "aberta"]);
    expect((await saldoCliente(cliB))?.em_aberto).toBe(66666);
  });

  it("não deixa pagar mais que a parcela, valor zero, data futura ou forma inventada", async () => {
    const [, p2] = await parcelasDe(lanc);
    await expect(pagar(ANA, p2.id, 33334)).rejects.toThrow(/pagamento_excede/);
    await expect(pagar(ANA, p2.id, 0)).rejects.toThrow(/valor_invalido/);
    await expect(pagar(ANA, p2.id, 100, await dia(`'${H}'::date + 1`))).rejects.toThrow(/data_futura/);
    await expect(pagar(ANA, p2.id, 100, null, "bitcoin")).rejects.toThrow(/forma_invalida/);
    expect((await parcelasDe(lanc))[1].valor_pago_centavos).toBe("0");
  });

  it("estornar um pagamento devolve o saldo e o status", async () => {
    const [p1] = await parcelasDe(lanc);
    const g = (await db.query<{ id: string }>("select id from public.pagamento where parcela_id = $1 and valor_centavos = 23334", [p1.id])).rows[0];
    await rpcUser(ANA, "select public.pagamento_estornar($1) as r", [g.id]);
    expect((await parcelasDe(lanc))[0]).toMatchObject({ status: "parcial", valor_pago_centavos: "10000" });
    expect((await saldoCliente(cliB))?.em_aberto).toBe(90000);
    await expect(chamar(ANA, "select public.pagamento_estornar($1)", [g.id])).rejects.toThrow(/ja_estornado/);
    await pagar(ANA, p1.id, 23334); // paga de novo
    expect((await parcelasDe(lanc))[0].status).toBe("paga");
  });
});


describe("Atrasadas (job diário) e visão geral", () => {
  let futuro: string;
  it("o job marca como atrasada só a parcela ABERTA e vencida; paga, parcial e cancelada ficam como estão", async () => {
    futuro = await criar(ANA, { tipo: "receita", categoria: "exito", cliente_id: cliA, descricao: "Êxito Maria", valor_centavos: 100000, parcelas: 4, primeiro_vencimento: await dia(`'${H}'::date + 20`) });
    const [p1, p2, p3] = await parcelasDe(futuro);
    await pagar(ANA, p1.id, 25000, H); // paga
    await pagar(ANA, p2.id, 5000, H); // parcial
    await rpcUser(ANA, "select public.parcela_cancelar($1) as r", [p3.id]); // cancelada
    // o tempo passa: todos os vencimentos ficam no passado
    await db.query("update public.parcela set vencimento = $2::date - 3 where lancamento_id = $1", [futuro, H]);
    expect(await rpcComoServico(db)<number>("parcelas_marcar_atrasadas", {})).toBeGreaterThanOrEqual(1);
    expect((await parcelasDe(futuro)).map((x) => x.status)).toEqual(["paga", "parcial", "cancelada", "atrasada"]);
  });

  it("job com data de referência: marca as abertas que passaram do vencimento naquela data e é repetível", async () => {
    const l = await criar(ANA, { tipo: "receita", categoria: "outros", cliente_id: cliA, descricao: "Job", valor_centavos: 2000, parcelas: 2, primeiro_vencimento: await dia(`'${H}'::date + 5`) });
    const servico = rpcComoServico(db);
    expect(await servico<number>("parcelas_marcar_atrasadas", { p_hoje: await dia(`'${H}'::date + 6`) })).toBe(1);
    expect((await parcelasDe(l)).map((x) => x.status)).toEqual(["atrasada", "aberta"]);
    expect(await servico<number>("parcelas_marcar_atrasadas", { p_hoje: await dia(`'${H}'::date + 6`) })).toBe(0);
    // o job não é chamável pelo usuário logado
    await expect(chamar(ANA, "select public.parcelas_marcar_atrasadas()")).rejects.toThrow(/permission denied/);
  });

  it("mudar o vencimento de uma atrasada para o futuro devolve “aberta”", async () => {
    const l = await criar(ANA, { tipo: "receita", categoria: "outros", cliente_id: cliA, descricao: "Prorroga", valor_centavos: 1000, parcelas: 1, primeiro_vencimento: await dia(`'${H}'::date - 2`) });
    const [p] = await parcelasDe(l);
    expect(p.status).toBe("atrasada");
    await rpcUser(ANA, "select public.parcela_alterar_vencimento($1, $2::date) as r", [p.id, await dia(`'${H}'::date + 7`)]);
    expect((await parcelasDe(l))[0].status).toBe("aberta");
  });
});


describe("Visão geral, saldos e extratos", () => {
  it("a receber (no prazo), atrasado, recebido no mês e despesas do mês — com números conferidos à mão", async () => {
    // Começa de um escritório limpo para os números serem exatos.
    const e2 = await rpcUser<string>(CAIO, "select public.criar_escritorio('Contas Limpas', null, 'equipe') as r");
    const c = (await um<{ id: string }>("insert into public.cliente (escritorio_id, nome, status) values ($1, 'Cliente Limpo', 'confirmado') returning id", [e2])).id;
    const nova = (d: Dados) => criar(CAIO, d, e2);
    // R$ 900,00 em 3: 300 no passado (atrasada), 300 e 300 no futuro
    const l1 = await nova({ tipo: "receita", categoria: "honorarios_contratuais", cliente_id: c, descricao: "Honorários A", valor_centavos: 90000, parcelas: 3, primeiro_vencimento: await dia(`'${H}'::date - 15`) });
    // vencimentos: H-15 (atrasada), H+15, H+45
    const ps = (await db.query<{ id: string }>("select id from public.parcela where lancamento_id = $1 order by numero", [l1])).rows;
    // paga 100,00 da primeira (parcial, ainda vencida) hoje e 300,00 da segunda ontem... (no mês corrente: hoje)
    await rpcUser(CAIO, "select public.pagamento_registrar($1, 10000, $2::date, 'pix') as r", [ps[0].id, H]);
    // pagamento do mês anterior não entra em "recebido no mês"
    const mesAnterior = await dia(`date_trunc('month', '${H}'::date) - interval '1 day'`);
    await rpcUser(CAIO, "select public.pagamento_registrar($1, 5000, $2::date, 'pix') as r", [ps[1].id, mesAnterior]);
    // despesa deste mês (competência hoje) e uma de outro mês
    await nova({ tipo: "despesa", categoria: "despesa_fixa", descricao: "Aluguel", valor_centavos: 250000, parcelas: 1, primeiro_vencimento: await dia(`'${H}'::date + 3`), data_competencia: H });
    await nova({ tipo: "despesa", categoria: "custas", descricao: "Custas antigas", valor_centavos: 70000, parcelas: 1, primeiro_vencimento: await dia(`'${H}'::date + 3`), data_competencia: mesAnterior });
    // lançamento cancelado não entra em nada
    const lx = await nova({ tipo: "receita", categoria: "outros", cliente_id: c, descricao: "Cancelado", valor_centavos: 77700, parcelas: 1, primeiro_vencimento: await dia(`'${H}'::date + 3`) });
    await rpcUser(CAIO, "select public.lancamento_cancelar($1) as r", [lx]);

    const r = await rpcUser<Record<string, number>>(CAIO, "select public.financeiro_resumo($1) as r", [e2]);
    // parcela 1: 30000 - 10000 = 20000 em atraso. parcela 2: 30000 - 5000 = 25000 a vencer. parcela 3: 30000 a vencer.
    expect(r.atrasado).toBe(20000);
    expect(r.a_receber).toBe(25000 + 30000);
    expect(r.recebido_mes).toBe(10000);
    expect(r.despesas_mes).toBe(250000);
    expect(r.a_pagar).toBe(250000 + 70000);
    expect(r.parcelas_atrasadas).toBe(1);
    // saldo por cliente = soma do que falta nas parcelas não pagas (atrasado + a vencer)
    const saldos = await rpcUser<{ id: string; em_aberto: number; atrasado: number }[]>(CAIO, "select public.financeiro_saldos($1, 'cliente') as r", [e2]);
    expect(saldos).toEqual([expect.objectContaining({ id: c, em_aberto: 75000, atrasado: 20000 })]);
  });

  it("extrato por cliente e por processo: parcelas e totais separados por tipo", async () => {
    const porCliente = await rpcUser<{ itens: { numero: number; cliente_nome: string }[]; totais: Record<string, Record<string, number>>; total: number }>(
      ANA, "select public.financeiro_parcelas($1, $2::jsonb) as r", [esc, JSON.stringify({ cliente_id: cliB })]);
    expect(porCliente.total).toBe(3);
    expect(porCliente.itens.every((i) => i.cliente_nome === "Empresa Beta Ltda")).toBe(true);
    expect(porCliente.totais.receita).toEqual({ total: 100000, pago: 33334, em_aberto: 66666, atrasado: 0 });
    expect(porCliente.totais.despesa.total).toBe(0);
    const porProcesso = await rpcUser<{ total: number }>(ANA, "select public.financeiro_parcelas($1, $2::jsonb) as r", [esc, JSON.stringify({ processo_id: proc2 })]);
    expect(porProcesso.total).toBe(3);
    const semNada = await rpcUser<{ total: number }>(ANA, "select public.financeiro_parcelas($1, $2::jsonb) as r", [esc, JSON.stringify({ processo_id: proc1 })]);
    expect(semNada.total).toBe(0);
  });

  it("lista de lançamentos filtra por tipo, categoria, cliente, situação e busca; mostra pago e em aberto", async () => {
    const lista = (f: Dados) => rpcUser<{ total: number; itens: { descricao: string; pago: number; aberto: number; parcelas: number; cliente_nome: string | null }[] }>(
      ANA, "select public.financeiro_lancamentos($1, $2::jsonb) as r", [esc, JSON.stringify(f)]);
    const todos = await lista({});
    expect(todos.total).toBeGreaterThan(5);
    const beta = await lista({ cliente_id: cliB });
    expect(beta.itens).toHaveLength(1);
    expect(beta.itens[0]).toMatchObject({ descricao: "Contrato Beta", pago: 33334, aberto: 66666, parcelas: 3, cliente_nome: "Empresa Beta Ltda" });
    expect((await lista({ tipo: "despesa" })).itens.every((i) => /Teste|Dia 31/.test(i.descricao))).toBe(true);
    expect((await lista({ categoria: "exito" })).itens.map((i) => i.descricao)).toEqual(["Êxito Maria"]);
    expect((await lista({ busca: "contrato" })).total).toBe(1);
    expect((await lista({ busca: "%" })).total).toBe(0); // % não é curinga
    expect((await lista({ situacao: "atrasado" })).itens.map((i) => i.descricao)).toContain("Êxito Maria");
    expect((await lista({ situacao: "quitado" })).total).toBe(0);
    expect((await lista({ limite: 2, deslocamento: 1 })).itens).toHaveLength(2);
  });

  it("detalhe do lançamento traz parcelas com o histórico de pagamentos", async () => {
    const id = (await um<{ id: string }>("select id from public.lancamento where descricao = 'Contrato Beta'")).id;
    const d = await rpcUser<{ cliente_nome: string; numero_cnj: string; parcelas: { numero: number; pagamentos: { estornado_em: string | null }[] }[] }>(
      ANA, "select public.lancamento_obter($1) as r", [id]);
    expect(d.cliente_nome).toBe("Empresa Beta Ltda");
    expect(d.numero_cnj).toBe("00000022320268050001");
    expect(d.parcelas).toHaveLength(3);
    expect(d.parcelas[0].pagamentos.length).toBeGreaterThanOrEqual(3); // 10000, 23334 estornado, 23334
    expect(d.parcelas[0].pagamentos.some((g) => g.estornado_em !== null)).toBe(true);
  });
});

describe("Cancelamentos e proteção do valor", () => {
  it("parcela com pagamento não cancela; sem pagamento cancela e sai do saldo", async () => {
    const l = await criar(ANA, { tipo: "receita", categoria: "outros", cliente_id: cliA, descricao: "Cancelável", valor_centavos: 6000, parcelas: 2, primeiro_vencimento: await dia(`'${H}'::date + 9`) });
    const [p1, p2] = await parcelasDe(l);
    await pagar(ANA, p1.id, 100);
    await expect(chamar(ANA, "select public.parcela_cancelar($1)", [p1.id])).rejects.toThrow(/parcela_com_pagamento/);
    await rpcUser(ANA, "select public.parcela_cancelar($1) as r", [p2.id]);
    expect((await parcelasDe(l)).map((x) => x.status)).toEqual(["parcial", "cancelada"]);
    await expect(pagar(ANA, p2.id, 100)).rejects.toThrow(/parcela_cancelada/);
    await expect(chamar(ANA, "select public.lancamento_cancelar($1)", [l])).rejects.toThrow(/lancamento_com_pagamento/);
  });

  it("lançamento sem pagamento cancela inteiro, uma vez só", async () => {
    const l = await criar(ANA, { tipo: "despesa", categoria: "outros", descricao: "Engano", valor_centavos: 3000, parcelas: 3, primeiro_vencimento: await dia(`'${H}'::date + 9`) });
    await rpcUser(ANA, "select public.lancamento_cancelar($1) as r", [l]);
    expect((await parcelasDe(l)).every((x) => x.status === "cancelada")).toBe(true);
    await expect(chamar(ANA, "select public.lancamento_cancelar($1)", [l])).rejects.toThrow(/ja_cancelado/);
  });

  it("valor do lançamento parcelado não muda por consulta direta, nem some com as parcelas", async () => {
    const id = (await um<{ id: string }>("select id from public.lancamento where descricao = 'Contrato Beta'")).id;
    await expect(chamar(ANA, "update public.lancamento set valor_centavos = 1 where id = $1", [id])).rejects.toThrow(/lancamento_com_parcelas/);
    await expect(chamar(ANA, "delete from public.lancamento where id = $1", [id])).rejects.toThrow(/foreign key|violates/);
    await expect(chamar(ANA, "update public.parcela set valor_pago_centavos = 0", [])).rejects.toThrow(/permission denied/);
    await expect(chamar(ANA, "insert into public.pagamento (escritorio_id, parcela_id, valor_centavos, data_pagamento) select escritorio_id, id, 1, current_date from public.parcela limit 1")).rejects.toThrow(/permission denied/);
  });

  it("parcela e pagamento ficam na auditoria", async () => {
    const t = await db.query<{ tabela: string }>("select distinct tabela from public.audit_log where tabela in ('parcela','pagamento','lancamento')");
    expect(t.rows.map((x) => x.tabela).sort()).toEqual(["lancamento", "pagamento", "parcela"]);
  });
});

describe("Permissão do financeiro: quem não tem a tela não vê valor nenhum", () => {
  it("consulta direta com o token do membro sem financeiro devolve zero linhas nas três tabelas", async () => {
    for (const t of ["lancamento", "parcela", "pagamento"]) {
      expect((await chamar(BIA, `select * from public.${t}`)).rows, t).toHaveLength(0);
    }
  });
  it("todas as funções de leitura e escrita recusam o membro sem financeiro", async () => {
    const [p] = await parcelasDe((await um<{ id: string }>("select id from public.lancamento where descricao = 'Contrato Beta'")).id);
    const lanc = (await um<{ id: string }>("select id from public.lancamento where descricao = 'Contrato Beta'")).id;
    const chamadas: [string, unknown[]][] = [
      ["select public.financeiro_resumo($1)", [esc]],
      ["select public.financeiro_saldos($1, 'cliente')", [esc]],
      ["select public.financeiro_lancamentos($1, '{}'::jsonb)", [esc]],
      ["select public.financeiro_parcelas($1, '{}'::jsonb)", [esc]],
      ["select public.financeiro_opcoes($1)", [esc]],
      ["select public.lancamento_obter($1)", [lanc]],
      ["select public.pagamento_registrar($1, 100, null, 'pix')", [p.id]],
      ["select public.parcela_cancelar($1)", [p.id]],
      ["select public.parcela_alterar_vencimento($1, current_date)", [p.id]],
      ["select public.lancamento_cancelar($1)", [lanc]],
      [`select public.lancamento_criar($1, '{"tipo":"despesa","categoria":"outros","descricao":"xx","valor_centavos":100,"parcelas":1,"primeiro_vencimento":"2031-01-01"}'::jsonb)`, [esc]],
    ];
    for (const [sql, args] of chamadas) await expect(chamar(BIA, sql, args), sql).rejects.toThrow(/sem_permissao/);
  });
  it("membro que TEM financeiro (e não tem processos) vê valores e os nomes de cliente/processo no financeiro", async () => {
    const r = await rpcUser<{ itens: { cliente_nome: string | null }[] }>(CAIO, "select public.financeiro_lancamentos($1, '{}'::jsonb) as r", [esc]);
    expect(r.itens.some((i) => i.cliente_nome === "Maria Silva")).toBe(true);
    const op = await rpcUser<{ clientes: { nome: string }[]; processos: unknown[] }>(CAIO, "select public.financeiro_opcoes($1) as r", [esc]);
    expect(op.clientes.some((c) => c.nome === "Maria Silva")).toBe(true);
    expect((await chamar(CAIO, "select * from public.parcela where escritorio_id = $1", [esc])).rows.length).toBeGreaterThan(0);
  });
  it("o dono tira o financeiro do membro: some tudo na hora; devolve: volta", async () => {
    const membroId = (await um<{ id: string }>("select id from public.membro where usuario_id = $1 and escritorio_id = $2", [CAIO, esc])).id;
    await chamar(ANA, "delete from public.permissao_tela where membro_id = $1 and modulo = 'financeiro'", [membroId]);
    expect((await chamar(CAIO, "select * from public.parcela where escritorio_id = $1", [esc])).rows).toHaveLength(0);
    await expect(chamar(CAIO, "select public.financeiro_resumo($1)", [esc])).rejects.toThrow(/sem_permissao/);
    await chamar(ANA, "insert into public.permissao_tela (membro_id, escritorio_id, modulo) values ($1, $2, 'financeiro')", [membroId, esc]);
    expect((await chamar(CAIO, "select * from public.parcela where escritorio_id = $1", [esc])).rows.length).toBeGreaterThan(0);
  });
  it("outro escritório não vê nem mexe em nada", async () => {
    for (const t of ["lancamento", "parcela", "pagamento"]) expect((await chamar(ZE, `select * from public.${t}`)).rows, t).toHaveLength(0);
    await expect(chamar(ZE, "select public.financeiro_resumo($1)", [esc])).rejects.toThrow(/sem_permissao/);
    await expect(chamar(ZE, "select public.financeiro_parcelas($1, '{}'::jsonb)", [esc])).rejects.toThrow(/sem_permissao/);
    await expect(chamar(ZE, "select public.financeiro_opcoes($1)", [esc])).rejects.toThrow(/sem_permissao/);
    const lanc = (await um<{ id: string }>("select id from public.lancamento where descricao = 'Contrato Beta'")).id;
    await expect(chamar(ZE, "select public.lancamento_obter($1)", [lanc])).rejects.toThrow(/sem_permissao/);
    await expect(criar(ZE, { tipo: "despesa", categoria: "outros", descricao: "Invasão", valor_centavos: 100, parcelas: 1, primeiro_vencimento: "2031-01-01" }, esc)).rejects.toThrow(/sem_permissao/);
    expect(escZe).toBeTruthy();
  });
  it("lançamento de um escritório não aponta para cliente de outro", async () => {
    const cliZe = (await um<{ id: string }>("insert into public.cliente (escritorio_id, nome, status) values ($1, 'Cliente do Zé', 'confirmado') returning id", [escZe])).id;
    await expect(criar(ANA, { tipo: "receita", categoria: "outros", cliente_id: cliZe, descricao: "Cruzado", valor_centavos: 100, parcelas: 1, primeiro_vencimento: "2031-01-01" })).rejects.toThrow(/vinculo_provisorio/);
  });
});
