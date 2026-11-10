import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Dec, ErroCalculo, type Regime, type TabelaIndices } from "@/lib/calculos/base";
import { atualizar, type EntradaMotor } from "@/lib/calculos/motor";
import { REGIME_CIVEL_ATE_LEI, REGIME_CIVEL_DESDE_LEI, REGIMES_CIVEIS_PADRAO } from "@/lib/calculos/regimes-padrao";
import { calcularArt523, calcularAtualizacao, calcularHonorarios, type Contexto, type ParametrosAtualizacao } from "@/lib/calculos/calculos";

/**
 * Índices reais do SGS (Banco Central), coletados em 09/11/2026 — os mesmos da carga inicial do banco.
 * Os valores esperados vêm de duas fontes independentes do motor (docs/conferencia/README.md):
 *  - Calculadora do Cidadão do Banco Central (consultada em 09/11/2026): fatores de INPC/IPCA e percentual da Taxa Legal;
 *  - script de conferência em Python (decimal), sem usar o código do motor: valores em centavos.
 */
const INDICES: TabelaIndices = JSON.parse(readFileSync(join(__dirname, "fixtures", "indices-sgs-2026-11-09.json"), "utf8")).valores;

const motor = (e: Partial<EntradaMotor> & Pick<EntradaMotor, "valorCentavos" | "dataBase" | "dataFinal">) =>
  atualizar({ inicioJuros: e.dataBase, regimes: REGIMES_CIVEIS_PADRAO, indices: INDICES, ...e });

/** Calculadora mostra o fator com 7 casas (ex.: 1,05186860): o nosso, sem arredondar, fica a meio passo dele. */
const pertoDaCalculadora = (nosso: string, calculadora: string) => expect(new Dec(nosso).minus(calculadora).abs().lte("0.00000005")).toBe(true);

describe("Motor por trechos — conferência com a Calculadora do Cidadão", () => {
  it("trecho INTEIRO ANTES da Lei 14.905 (INPC + 1% a.m.): um trecho só", () => {
    const r = motor({ valorCentavos: 1234567, dataBase: "2023-03-10", dataFinal: "2024-07-20" });
    expect(r.trechos).toHaveLength(1);
    expect(r.trechos[0].regime.id).toBe(REGIME_CIVEL_ATE_LEI.id);
    // Calculadora: INPC 03/2023 a 06/2024, R$ 12.345,67 → fator 1,05186860 e R$ 12.986,02.
    pertoDaCalculadora(r.fatorCorrecao, "1.0518686");
    expect(r.principalCorrigido).toBe(1298602);
    // 1% a.m. pro rata: 22/31 de mar/2023 + 15 meses cheios + 19/31 de jul/2024 = 0,709677 + 15 + 0,612903.
    expect(r.jurosPercentual).toBe("16.322580");
    expect(r.juros).toBe(211965);
    expect(r.total).toBe(1298602 + 211965);
  });

  it("trecho INTEIRO DEPOIS da lei (IPCA + Taxa Legal), juros desde a citação", () => {
    const r = motor({ valorCentavos: 5000000, dataBase: "2024-10-05", inicioJuros: "2024-11-12", dataFinal: "2025-06-20" });
    expect(r.trechos).toHaveLength(1);
    expect(r.trechos[0].regime.id).toBe(REGIME_CIVEL_DESDE_LEI.id);
    // Calculadora: IPCA 10/2024 a 05/2025, R$ 50.000,00 → 1,04263250 e R$ 52.131,62.
    pertoDaCalculadora(r.fatorCorrecao, "1.0426325");
    expect(r.principalCorrigido).toBe(5213162);
    // Calculadora, Taxa Legal de 12/11/2024 a 20/06/2025: 3,344571% (idêntico, 6 casas).
    expect(r.jurosPercentual).toBe("3.344571");
    expect(r.juros).toBe(174358);
  });

  it("débito de 2023 a 2026 ATRAVESSA a lei: dois trechos, troca exatamente em 30/08/2024", () => {
    const r = motor({ valorCentavos: 10000000, dataBase: "2023-05-15", dataFinal: "2026-02-10" });
    expect(r.trechos.map((t) => [t.inicio, t.fim, t.regime.id])).toEqual([
      ["2023-05-15", "2024-08-29", REGIME_CIVEL_ATE_LEI.id],
      ["2024-08-30", "2026-02-09", REGIME_CIVEL_DESDE_LEI.id],
    ]);
    // Agosto/2024: 29 dias a 1% a.m. (até 29/08) + 2 dias de Taxa Legal (30 e 31/08). Taxa Legal de ago/2024 = 0,605306%.
    const agosto = r.linhas.find((l) => l.mes === "2024-08")!;
    expect(agosto.juros.map((j) => [j.serie, j.dias, j.aplicado])).toEqual([["FIXO", 29, "0.935484"], ["TAXA_LEGAL", 2, "0.039052"]]);
    // Correção: agosto ainda pelo INPC (regime do 1º dia do mês); IPCA desde setembro.
    expect(agosto.correcao.map((c) => c.serie)).toEqual(["INPC"]);
    expect(r.linhas.find((l) => l.mes === "2024-09")!.correcao.map((c) => c.serie)).toEqual(["IPCA"]);
    // Calculadora: INPC 05/2023 a 08/2024 = 1,04091310; IPCA 09/2024 a 01/2026 = 1,06620740.
    pertoDaCalculadora(r.fatorCorrecao, new Dec("1.0409131").mul("1.0662074").toString());
    // Calculadora, Taxa Legal de 30/08/2024 a 10/02/2026: 12,231549%. Mais 1% a.m. de 15/05/2023 a 29/08/2024: 15,483871%.
    expect(r.jurosPercentual).toBe(new Dec("12.231549").plus("15.483871").toFixed(6));
    expect(r.principalCorrigido).toBe(11098292);
    expect(r.juros).toBe(3075938);
  });

  it("mês com Taxa Legal ZERO (mar/2025): juros do mês R$ 0,00", () => {
    const r = motor({ valorCentavos: 100000, dataBase: "2025-03-10", dataFinal: "2025-05-15", regimes: [REGIME_CIVEL_DESDE_LEI] });
    const marco = r.linhas.find((l) => l.mes === "2025-03")!;
    expect(marco.jurosMesPercentual).toBe("0.000000");
    expect(marco.jurosMes).toBe(0);
    // Calculadora, Taxa Legal de 10/03/2025 a 15/05/2025: 0,603414%.
    expect(r.jurosPercentual).toBe("0.603414");
    // Mês inteiro de março: Calculadora dá 0,000000%.
    expect(motor({ valorCentavos: 100000, dataBase: "2025-03-01", dataFinal: "2025-04-01", regimes: [REGIME_CIVEL_DESDE_LEI] }).jurosPercentual).toBe("0.000000");
  });

  it("Taxa Legal: os exemplos da metodologia da Calculadora (dia inicial conta, final não)", () => {
    const so = (de: string, ate: string) => motor({ valorCentavos: 100000, dataBase: de, dataFinal: ate, regimes: [{ ...REGIME_CIVEL_DESDE_LEI, correcao_indice: "nenhuma" }] }).jurosPercentual;
    expect(so("2024-08-30", "2024-08-31")).toBe("0.019526");
    expect(so("2024-08-30", "2024-09-30")).toBe("0.692738");
    expect(so("2025-01-15", "2025-06-10")).toBe("2.403407");
  });

  it("IGP-M pela série 28655 (a mesma da Calculadora)", () => {
    const igpm: Regime = { ...REGIME_CIVEL_ATE_LEI, id: "igpm", vigencia_fim: null, correcao_indice: "IGP_M", juros_tipo: "nenhum", juros_valor: null };
    const r = atualizar({ valorCentavos: 777777, dataBase: "2022-01-20", inicioJuros: null, dataFinal: "2025-01-05", regimes: [igpm], indices: INDICES });
    // Calculadora: IGP-M 01/2022 a 12/2024, R$ 7.777,77 → 1,08771580 e R$ 8.460,00.
    pertoDaCalculadora(r.fatorCorrecao, "1.0877158");
    expect(r.principalCorrigido).toBe(846000);
  });
});

describe("Motor — regras gerais", () => {
  it("a última linha da tabela bate com os totais e cada linha só arredonda no fim", () => {
    const r = motor({ valorCentavos: 10000000, dataBase: "2023-05-15", dataFinal: "2026-02-10" });
    const ultima = r.linhas.at(-1)!;
    expect([ultima.valorCorrigido, ultima.jurosAcumulados, ultima.subtotal]).toEqual([r.principalCorrigido, r.juros, r.total]);
    expect(r.linhas[0].mes).toBe("2023-05");
    expect(r.linhas.every((l) => Number.isInteger(l.valorCorrigido) && Number.isInteger(l.jurosMes))).toBe(true);
  });

  it("troca de índice só onde o regime permite (índice convencionado ou da decisão)", () => {
    const r = motor({ valorCentavos: 1234567, dataBase: "2023-03-10", dataFinal: "2024-07-20", indicesSubstitutos: { [REGIME_CIVEL_ATE_LEI.id]: "IPCA" } });
    expect(r.trechos[0].regime.indice_efetivo).toBe("IPCA");
    expect(r.linhas[0].correcao[0].serie).toBe("IPCA");
    const fixo = { ...REGIME_CIVEL_ATE_LEI, indice_editavel: false };
    expect(() => motor({ valorCentavos: 1, dataBase: "2023-03-10", dataFinal: "2024-07-20", regimes: [fixo], indicesSubstitutos: { [fixo.id]: "IPCA" } })).toThrow(/não permite/);
  });

  it("Selic não se soma com outro índice no mesmo trecho", () => {
    const selic: Regime = { ...REGIME_CIVEL_DESDE_LEI, id: "s", juros_tipo: "selic_englobando_correcao_e_juros" };
    expect(() => motor({ valorCentavos: 100, dataBase: "2025-01-01", dataFinal: "2025-03-01", regimes: [selic] })).toThrowError(ErroCalculo);
    const ok = motor({ valorCentavos: 100000, dataBase: "2025-01-01", dataFinal: "2025-03-01", regimes: [{ ...selic, correcao_indice: "nenhuma" }] });
    // A Selic entra no fator, em soma simples: jan/2025 1,01 + fev/2025 0,99 = 2,00%. Sem juros à parte.
    expect(ok.fatorCorrecao).toBe("1.0200000000");
    expect(ok.jurosPercentual).toBe("0.000000");
  });

  it("regimes que se sobrepõem ou deixam buraco são recusados", () => {
    const sobra = { ...REGIME_CIVEL_DESDE_LEI, id: "x", vigencia_inicio: "2024-08-01" };
    expect(() => motor({ valorCentavos: 100, dataBase: "2024-01-01", dataFinal: "2025-01-01", regimes: [REGIME_CIVEL_ATE_LEI, sobra] })).toThrow(/mesmo tempo/);
    expect(() => motor({ valorCentavos: 100, dataBase: "2024-01-01", dataFinal: "2025-01-01", regimes: [REGIME_CIVEL_ATE_LEI] })).toThrow(/30\/08\/2024/);
  });

  it("índice ainda não publicado: erro claro, sem chutar valor", () => {
    expect(() => motor({ valorCentavos: 100, dataBase: "2026-08-01", dataFinal: "2026-12-15" })).toThrow(/IPCA de 10\/2026/);
  });

  it("correção pro rata (quando o regime pede) e juros ao ano", () => {
    const r: Regime = { ...REGIME_CIVEL_ATE_LEI, id: "p", vigencia_fim: null, correcao_indice: "IPCA", correcao_pro_rata: true, juros_tipo: "percentual_fixo_ao_ano_simples", juros_valor: "6" };
    const x = atualizar({ valorCentavos: 100000, dataBase: "2023-01-16", inicioJuros: "2023-01-16", dataFinal: "2023-02-15", regimes: [r], indices: INDICES });
    // jan/2023 IPCA 0,53 por 16/31 dias; fev/2023 IPCA 0,84 por 14/28 dias.
    const esperado = new Dec("1.0053").pow(new Dec(16).div(31)).mul(new Dec("1.0084").pow(new Dec(14).div(28)));
    expect(x.fatorCorrecao).toBe(esperado.toFixed(10));
    // 6% a.a. = 0,5% a.m.: 0,5 × 16/31 = 0,258065 e 0,5 × 14/28 = 0,25.
    expect(x.jurosPercentual).toBe("0.508065");
  });

  it("teto: correção + juros limitados à Selic do trecho", () => {
    const r: Regime = { ...REGIME_CIVEL_ATE_LEI, id: "t", vigencia_fim: null, correcao_indice: "IPCA", juros_tipo: "percentual_ao_mes", juros_valor: "2", teto: "selic" };
    const x = atualizar({ valorCentavos: 100000, dataBase: "2025-01-01", inicioJuros: "2025-01-01", dataFinal: "2025-03-01", regimes: [r], indices: INDICES });
    // IPCA jan+fev/2025 = 0,16% e 1,31% (≈1,47%); juros 4%; Selic 2,00%: juros cortados para 2,00 − variação.
    const variacao = new Dec("1.0016").mul("1.0131").minus(1).mul(100);
    expect(x.jurosPercentual).toBe(new Dec(2).minus(variacao).toFixed(6));
    expect(x.linhas.at(-1)!.ajusteTeto).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
const ctx: Contexto = {
  titulo: "Teste",
  processo: null,
  partes: null,
  dataCalculo: "2026-11-09",
  regimes: REGIMES_CIVEIS_PADRAO,
  indices: INDICES,
  series: [],
  calendario: [], // só fins de semana
};
const baseAtualizacao: ParametrosAtualizacao = {
  valorCentavos: 2000000, dataBase: "2024-10-01", juros: "vencimento", dataCitacao: null, dataFinal: "2025-06-02",
  regimeIds: REGIMES_CIVEIS_PADRAO.map((r) => r.id), indicesSubstitutos: {}, dataAjuizamento: null, dataTransito: null,
};
const total = (d: ReturnType<typeof calcularArt523>, rotulo: RegExp) => d.totais.find((t) => rotulo.test(t.rotulo))!.centavos;

describe("Atualização (demonstrativo)", () => {
  it("monta regras, tabela, totais, séries e avisos", () => {
    const d = calcularAtualizacao({ ...baseAtualizacao, dataBase: "2023-05-15", valorCentavos: 10000000, dataFinal: "2026-02-10" }, ctx);
    expect(d.regras.map((r) => [r.inicio, r.fim, r.mesesCorrecao])).toEqual([["2023-05-15", "2024-08-29", "05/2023 a 08/2024"], ["2024-08-30", "2026-02-09", "09/2024 a 01/2026"]]);
    expect(d.totalCentavos).toBe(11098292 + 3075938);
    expect(d.avisos).toContain("Cálculo de apoio. Confira os critérios fixados na decisão judicial.");
    expect(d.tabela!.length).toBe(34);
  });
  it("juros desde a citação exigem a data", () => {
    expect(() => calcularAtualizacao({ ...baseAtualizacao, juros: "citacao" }, ctx)).toThrow(/citação/);
  });
});

describe("Cumprimento de sentença (art. 523)", () => {
  it("sem pagamento no prazo: multa 10% + honorários 10% sobre o débito atualizado", () => {
    const d = calcularArt523({ ...baseAtualizacao, dataIntimacao: "2025-03-10", pagamento: null }, ctx);
    // Intimação seg 10/03/2025 → dia 1 = 11/03; 15 dias úteis → 31/03/2025.
    expect(d.blocos[0].linhas.find((l) => l.rotulo === "Data final sugerida")!.valor).toContain("31/03/2025");
    expect(total(d, /^Principal/)).toBe(2085265);
    expect(total(d, /^Juros/)).toBe(77670);
    expect(total(d, /^Multa/)).toBe(216294);
    expect(total(d, /^Honorários/)).toBe(216294);
    expect(d.totalCentavos).toBe(2085265 + 77670 + 216294 * 2);
  });

  it("pagamento PARCIAL dentro do prazo: multa e honorários só sobre o restante", () => {
    const d = calcularArt523({ ...baseAtualizacao, dataIntimacao: "2025-03-10", pagamento: { valorCentavos: 500000, data: "2025-03-20" } }, ctx);
    expect(total(d, /^Principal/)).toBe(1592558);
    expect(total(d, /^Juros/)).toBe(59318);
    expect(total(d, /^Multa/)).toBe(165188);
    expect(total(d, /^Honorários/)).toBe(165188);
    expect(d.totalCentavos).toBe(1982252);
  });

  it("pagamento parcial DEPOIS do prazo: abate o saldo, mas multa e honorários ficam sobre o débito integral", () => {
    const d = calcularArt523({ ...baseAtualizacao, dataIntimacao: "2025-03-10", pagamento: { valorCentavos: 500000, data: "2025-04-15" } }, ctx);
    expect(total(d, /^Multa/)).toBe(216294);
    expect(d.totalCentavos).toBe(2088052);
  });

  it("prazo ainda correndo na data do cálculo: sem multa, com aviso", () => {
    const d = calcularArt523({ ...baseAtualizacao, dataFinal: "2025-03-25", dataIntimacao: "2025-03-10", pagamento: null }, ctx);
    expect(total(d, /^Multa/)).toBe(0);
    expect(d.avisos[0]).toMatch(/vence em 31\/03\/2025/);
  });

  it("pagamento integral no prazo: nada de multa", () => {
    const d = calcularArt523({ ...baseAtualizacao, dataIntimacao: "2025-03-10", pagamento: { valorCentavos: 3000000, data: "2025-03-20" } }, ctx);
    expect(d.totalCentavos).toBe(0);
  });

  it("feriado do calendário forense entra na contagem do prazo", () => {
    const comFeriado = { ...ctx, calendario: [{ data: "2025-03-20", dataFim: null, escopo: "nacional" as const, tribunal: null, uf: null, tipo: "feriado" as const, descricao: "Feriado de teste" }] };
    const d = calcularArt523({ ...baseAtualizacao, dataIntimacao: "2025-03-10", pagamento: null }, comFeriado);
    expect(d.blocos[0].linhas.find((l) => l.rotulo === "Data final sugerida")!.valor).toContain("01/04/2025");
  });
});

describe("Honorários", () => {
  const h = { titulo: "H", processo: null, partes: null, dataCalculo: "2026-11-09" };
  it("sucumbência: 10% a 20% sobre a base escolhida, com aviso da Fazenda", () => {
    const d = calcularHonorarios({ modalidade: "sucumbencia", forma: "percentual", baseTipo: "condenacao", baseCentavos: 12345678, percentual: "15", valorFixoCentavos: null, fazendaPublica: false }, h);
    expect(d.totalCentavos).toBe(1851852); // 123.456,78 × 15% = 18.518,517
    expect(d.avisos.join(" ")).toMatch(/art\. 85, § 3º/);
    expect(() => calcularHonorarios({ modalidade: "sucumbencia", forma: "percentual", baseTipo: "condenacao", baseCentavos: 100, percentual: "25", valorFixoCentavos: null, fazendaPublica: false }, h)).toThrow(/10% a 20%/);
    expect(() => calcularHonorarios({ modalidade: "sucumbencia", forma: "percentual", baseTipo: "valor_causa", baseCentavos: 100, percentual: "9,99", valorFixoCentavos: null, fazendaPublica: false }, h)).toThrow(/10% a 20%/);
  });
  it("contratuais: fixo ou percentual", () => {
    expect(calcularHonorarios({ modalidade: "contratuais", forma: "fixo", baseTipo: "outro", baseCentavos: null, percentual: null, valorFixoCentavos: 500000, fazendaPublica: false }, h).totalCentavos).toBe(500000);
    expect(calcularHonorarios({ modalidade: "contratuais", forma: "percentual", baseTipo: "outro", baseCentavos: 333333, percentual: "30", valorFixoCentavos: null, fazendaPublica: false }, h).totalCentavos).toBe(100000);
  });
  it("êxito: percentual sobre o valor efetivamente recebido", () => {
    const d = calcularHonorarios({ modalidade: "exito", forma: "percentual", baseTipo: "valor_recebido", baseCentavos: 1000001, percentual: "20", valorFixoCentavos: null, fazendaPublica: true }, h);
    expect(d.totalCentavos).toBe(200000);
    expect(d.avisos.join(" ")).toMatch(/Fazenda Pública/);
  });
});

describe("Formulário (leitura no servidor)", () => {
  const fd = (o: Record<string, string | string[]>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x);
    return f;
  };
  const PAD = REGIMES_CIVEIS_PADRAO.map((r) => r.id);
  it("atualização: converte valor em centavos, usa os regimes padrão e lê a troca de índice", async () => {
    const { lerFormulario, valoresDe } = await import("@/lib/calculos/formulario");
    const r = lerFormulario("atualizacao", fd({
      titulo: "Débito", processo: "", partes: "", valor: "12.345,67", data_base: "2023-03-10", juros: "vencimento", data_citacao: "",
      data_final: "2024-07-20", data_ajuizamento: "", data_transito: "", modo_regimes: "padrao", [`indice__${PAD[0]}`]: "IPCA",
    }), PAD, PAD);
    if ("erro" in r) throw new Error(r.erro);
    expect(r.parametros).toMatchObject({ valorCentavos: 1234567, regimeIds: PAD, indicesSubstitutos: { [PAD[0]]: "IPCA" } });
    const v = valoresDe({ titulo: r.titulo, processo_id: null, partes: null, parametros: { ...r.parametros, modoRegimes: "padrao" }, regimes: PAD });
    expect([v.valor, v.data_base, v.indices[PAD[0]]]).toEqual(["12.345,67", "2023-03-10", "IPCA"]);
  });
  it("recusa regime de fora da lista, citação sem data e datas invertidas", async () => {
    const { lerFormulario } = await import("@/lib/calculos/formulario");
    const base = { titulo: "X1", valor: "100", data_base: "2024-01-01", juros: "vencimento", data_final: "2024-06-01", modo_regimes: "escolher" };
    expect(lerFormulario("atualizacao", fd({ ...base, regimes: ["de-outro-escritorio"] }), PAD, PAD)).toEqual({ erro: "Escolha ao menos um regime." });
    expect(lerFormulario("atualizacao", fd({ ...base, juros: "citacao", modo_regimes: "padrao" }), PAD, PAD)).toEqual({ erro: "Informe a data da citação (início dos juros)." });
    expect(lerFormulario("atualizacao", fd({ ...base, data_final: "2023-01-01", modo_regimes: "padrao" }), PAD, PAD)).toEqual({ erro: "A data final não pode ser anterior à data-base." });
  });
  it("art. 523: pagamento parcial pela metade é recusado; honorários fixos", async () => {
    const { lerFormulario } = await import("@/lib/calculos/formulario");
    const base = { titulo: "X1", valor: "100", data_base: "2024-01-01", juros: "vencimento", data_final: "2024-06-01", modo_regimes: "padrao", data_intimacao: "2024-03-01" };
    expect(lerFormulario("art523", fd({ ...base, pagamento_valor: "50" }), PAD, PAD)).toEqual({ erro: "Pagamento parcial: informe a data do pagamento." });
    const h = lerFormulario("honorarios", fd({ titulo: "Hon", modalidade: "contratuais", forma: "fixo", valor_fixo: "5.000,00" }), PAD, PAD);
    expect(h).toMatchObject({ parametros: { modalidade: "contratuais", forma: "fixo", valorFixoCentavos: 500000, percentual: null } });
  });
});
