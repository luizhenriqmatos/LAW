import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Dec, type TabelaIndices } from "@/lib/calculos/base";
import { atualizar } from "@/lib/calculos/motor";
import { REGIME_TRAB_DESDE_LEI, REGIME_TRAB_PRE_JUDICIAL, REGIME_TRAB_SELIC, REGIMES_TRABALHISTAS_PADRAO } from "@/lib/calculos/regimes-padrao";
import { anosCompletos, apurarRescisao, avosDeFerias, avosPorMesCivil, diasDeAviso, type EntradaRescisao } from "@/lib/calculos/rescisao";
import { calcularTrabalhista } from "@/lib/calculos/trabalhista";

/**
 * Valores esperados: planilha de conferência docs/conferencia/conferencia-trabalhista.xlsx (fórmulas próprias,
 * recalculadas no LibreOffice) e Calculadora do Cidadão (IPCA-E, IPCA e Taxa Legal).
 */
const INDICES: TabelaIndices = JSON.parse(readFileSync(join(__dirname, "fixtures", "indices-sgs-2026-11-09.json"), "utf8")).valores;
const trab = (valor: number, venc: string, ajuizamento: string, fim: string) =>
  atualizar({ valorCentavos: valor, dataBase: venc, inicioJuros: venc, dataFinal: fim, regimes: REGIMES_TRABALHISTAS_PADRAO, indices: INDICES, marcos: { ajuizamento } });

describe("Atualização trabalhista por fases (ADC 58 + TST)", () => {
  it("verba vencida em 2022, ação ajuizada em 2023, cálculo em 2026: TRÊS trechos com as regras certas", () => {
    const r = trab(1000000, "2022-05-05", "2023-03-15", "2026-02-10");
    expect(r.trechos.map((t) => [t.inicio, t.fim, t.regime.id])).toEqual([
      ["2022-05-05", "2023-03-14", REGIME_TRAB_PRE_JUDICIAL.id],
      ["2023-03-15", "2024-08-29", REGIME_TRAB_SELIC.id],
      ["2024-08-30", "2026-02-09", REGIME_TRAB_DESDE_LEI.id],
    ]);
    const t = r.trechos.map((x) => x.regime);
    expect([t[0].indice_efetivo, t[0].juros_tipo]).toEqual(["IPCA_E", "tr_art39_lei8177"]);
    expect([t[1].indice_efetivo, t[1].juros_tipo]).toEqual(["nenhuma", "selic_englobando_correcao_e_juros"]);
    expect([t[2].indice_efetivo, t[2].juros_tipo]).toEqual(["IPCA", "taxa_legal"]);
    // Planilha de conferência (aba Tres_fases).
    expect(r.fatorCorrecao).toBe("1.2823843905");
    expect(r.jurosPercentual).toBe("14.015717");
    expect([r.principalCorrigido, r.juros, r.total]).toEqual([1282384, 179735, 1462119]);
  });

  it("cada fase com a sua regra: IPCA-E mês a mês (= Calculadora), Selic sem juros à parte, Taxa Legal desde 30/08/2024", () => {
    const r = trab(1000000, "2022-05-05", "2023-03-15", "2026-02-10");
    // IPCA-E de 05/2022 a 02/2023 por meses inteiros: Calculadora do Cidadão = 1,02855190.
    const pre = r.linhas.filter((l) => l.mes <= "2023-02").reduce((f, l) => f.mul(l.fatorMes), new Dec(1));
    expect(pre.minus("1.0285519").abs().lte("0.00000005")).toBe(true);
    // Mês do ajuizamento repartido por dias: 14 dias de IPCA-E e TR, 17 dias de Selic.
    const marco = r.linhas.find((l) => l.mes === "2023-03")!;
    expect(marco.correcao.map((c) => [c.serie, c.dias])).toEqual([["IPCA_E", 14], ["SELIC", 17]]);
    expect(marco.juros.map((j) => [j.serie, j.dias])).toEqual([["TR", 14]]);
    // Fase Selic: nenhum juro adicional.
    expect(r.linhas.filter((l) => l.mes >= "2023-04" && l.mes <= "2024-07").every((l) => l.jurosMesPercentual === "0.000000")).toBe(true);
    // Desde 30/08/2024: IPCA e Taxa Legal; a soma da Taxa Legal é a da Calculadora (30/08/2024 a 10/02/2026 = 12,231549%).
    const tl = r.linhas.flatMap((l) => l.juros).filter((j) => j.serie === "TAXA_LEGAL").reduce((s, j) => s.plus(j.aplicado), new Dec(0));
    expect(tl.toFixed(6)).toBe("12.231549");
    expect(r.linhas.find((l) => l.mes === "2024-09")!.correcao.map((c) => c.serie)).toEqual(["IPCA"]);
  });

  it("ação ajuizada DEPOIS de 30/08/2024: sem fase Selic; pré-judicial até a véspera do ajuizamento", () => {
    const r = trab(500000, "2024-06-10", "2025-02-03", "2025-08-01");
    expect(r.trechos.map((t) => [t.inicio, t.fim, t.regime.id])).toEqual([
      ["2024-06-10", "2025-02-02", REGIME_TRAB_PRE_JUDICIAL.id],
      ["2025-02-03", "2025-07-31", REGIME_TRAB_DESDE_LEI.id],
    ]);
  });

  it("verba que vence depois do ajuizamento não tem fase pré-judicial", () => {
    const r = trab(500000, "2023-06-20", "2023-03-15", "2025-01-10");
    expect(r.trechos.map((t) => t.regime.id)).toEqual([REGIME_TRAB_SELIC.id, REGIME_TRAB_DESDE_LEI.id]);
  });

  it("sem data de ajuizamento o cálculo trabalhista não roda", () => {
    expect(() => atualizar({ valorCentavos: 100, dataBase: "2022-01-01", inicioJuros: "2022-01-01", dataFinal: "2025-01-01", regimes: REGIMES_TRABALHISTAS_PADRAO, indices: INDICES }))
      .toThrow(/ajuizamento/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
const EXEMPLO: EntradaRescisao = {
  admissao: "2021-03-10", saida: "2025-09-18", tipo: "sem_justa_causa", avisoIndenizado: true,
  salarioCentavos: 325000, mediasCentavos: 41237, feriasVencidas: 1, feriasVencidasEmDobro: 0, saldoFgtsCentavos: 1438052,
};
const valores = (e: EntradaRescisao) => Object.fromEntries(apurarRescisao(e).verbas.map((v) => [v.codigo, v.centavos]));

describe("Verbas rescisórias", () => {
  it("rescisão sem justa causa de exemplo bate com a planilha de conferência centavo a centavo", () => {
    const a = apurarRescisao(EXEMPLO);
    expect(valores(EXEMPLO)).toEqual({
      saldo_salario: 195000, aviso_previo: 512732, decimo_terceiro: 305198, ferias_vencidas: 366237, terco_ferias_vencidas: 122079,
      ferias_proporcionais: 244158, terco_ferias_proporcionais: 81386, fgts_mes: 81034, multa_fgts: 607634,
    });
    expect(a.verbas.reduce((s, v) => s + v.centavos, 0)).toBe(2515458); // planilha: R$ 25.154,58
    expect(a.vencimento).toBe("2025-09-28");
    // Cada verba traz a sua regra.
    expect(a.verbas.find((v) => v.codigo === "aviso_previo")!.regra).toMatch(/4 anos completos.*42 dias.*30\/10\/2025/);
    expect(a.verbas.find((v) => v.codigo === "decimo_terceiro")!.regra).toMatch(/10\/12/);
    expect(a.verbas.find((v) => v.codigo === "ferias_proporcionais")!.regra).toMatch(/8\/12.*10\/03\/2025/);
  });

  it("justa causa: só saldo, férias vencidas + 1/3 e FGTS do mês sobre o saldo; sem multa", () => {
    expect(valores({ ...EXEMPLO, tipo: "justa_causa" })).toEqual({
      saldo_salario: 195000, aviso_previo: 0, decimo_terceiro: 0, ferias_vencidas: 366237, terco_ferias_vencidas: 122079,
      ferias_proporcionais: 0, fgts_mes: 15600, multa_fgts: 0,
    });
  });

  it("pedido de demissão: sem aviso e sem projeção; 13º e férias proporcionais devidos; sem multa", () => {
    const v = valores({ ...EXEMPLO, tipo: "pedido_demissao" });
    expect(v).toMatchObject({ aviso_previo: 0, decimo_terceiro: 274678, ferias_proporcionais: 183119, terco_ferias_proporcionais: 61040, fgts_mes: 37574, multa_fgts: 0 });
  });

  it("acordo (art. 484-A): metade do aviso e multa de 20%", () => {
    expect(valores({ ...EXEMPLO, tipo: "acordo_484a" })).toMatchObject({ aviso_previo: 256366, fgts_mes: 60525, multa_fgts: 299715 });
  });

  it("aviso trabalhado: sem verba de aviso e sem projeção", () => {
    expect(valores({ ...EXEMPLO, avisoIndenizado: false })).toMatchObject({ aviso_previo: 0, decimo_terceiro: 274678 });
  });

  it("projeção do aviso que atravessa o ano e completa um período de férias", () => {
    const v = valores({ ...EXEMPLO, admissao: "2015-01-05", saida: "2025-12-10", salarioCentavos: 500000, mediasCentavos: 0, feriasVencidas: 0, saldoFgtsCentavos: 0 });
    // 10 anos → 60 dias → projeção até 08/02/2026: 13º = 12/12 de 2025 + 1/12 de 2026; férias = 13/12.
    expect(v).toMatchObject({ saldo_salario: 166667, aviso_previo: 1000000, decimo_terceiro: 541667, ferias_proporcionais: 541667, terco_ferias_proporcionais: 180556 });
  });

  it("mês da saída trabalhado por inteiro paga o salário cheio; aviso limitado a 90 dias", () => {
    expect(valores({ ...EXEMPLO, saida: "2025-09-30" }).saldo_salario).toBe(325000);
    expect(diasDeAviso(anosCompletos("1990-01-01", "2025-06-30"))).toBe(90);
    expect([anosCompletos("2021-03-10", "2022-03-08"), anosCompletos("2021-03-10", "2022-03-09")]).toEqual([0, 1]);
  });

  it("sem o saldo do FGTS a multa usa estimativa e avisa", () => {
    const a = apurarRescisao({ ...EXEMPLO, saldoFgtsCentavos: null });
    expect(a.verbas.find((v) => v.codigo === "multa_fgts")!.centavos).toBe(735589);
    expect(a.avisos[0]).toMatch(/estimado/);
  });

  it("contagem de avos: 15 dias ou mais contam como mês", () => {
    expect(avosPorMesCivil("2025-01-01", "2025-10-30")).toEqual([{ ano: 2025, avos: 10 }]);
    expect(avosPorMesCivil("2025-01-01", "2025-10-14")).toEqual([{ ano: 2025, avos: 9 }]);
    expect(avosDeFerias("2025-03-10", "2025-10-30")).toBe(8);
    expect(avosDeFerias("2025-03-10", "2025-10-23")).toBe(7);
  });
});

describe("Cálculo trabalhista completo (verba por verba)", () => {
  const ctx = { titulo: "Reclamação", processo: null, partes: null, dataCalculo: "2026-11-10", regimes: REGIMES_TRABALHISTAS_PADRAO, indices: INDICES, series: [] };
  it("atualiza cada verba pela sua linha do tempo e soma no final", () => {
    const d = calcularTrabalhista({
      dataAjuizamento: "2023-03-15", dataFinal: "2026-02-10", regimeIds: REGIMES_TRABALHISTAS_PADRAO.map((r) => r.id), indicesSubstitutos: {},
      rescisao: null,
      verbas: [{ descricao: "Diferença salarial de abril/2022", valorCentavos: 1000000, vencimento: "2022-05-05" }, { descricao: "Salário de maio/2023", valorCentavos: 500000, vencimento: "2023-06-20" }],
    }, ctx);
    const sozinha = trab(500000, "2023-06-20", "2023-03-15", "2026-02-10");
    expect(d.verbas!.map((v) => v.total)).toEqual([1462119, sozinha.total]);
    expect(d.totalCentavos).toBe(1462119 + sozinha.total);
    expect(d.grupos!.map((g) => g.regras.length)).toEqual([3, 2]);
    expect(d.avisos.join(" ")).toMatch(/horas extras/);
  });

  it("rescisão: as verbas devidas vencem 10 dias após a saída; as não devidas aparecem na apuração com a regra", () => {
    const d = calcularTrabalhista({
      dataAjuizamento: "2025-11-03", dataFinal: "2026-02-10", regimeIds: REGIMES_TRABALHISTAS_PADRAO.map((r) => r.id), indicesSubstitutos: {},
      rescisao: { ...EXEMPLO, tipo: "pedido_demissao" }, verbas: [],
    }, ctx);
    expect(d.apuracao!.find((a) => a.descricao === "Aviso prévio")!.regra).toMatch(/Pedido de demissão/);
    expect(new Set(d.verbas!.map((v) => v.vencimento))).toEqual(new Set(["2025-09-28"]));
    expect(d.verbas!.some((v) => v.original === 0)).toBe(false);
    expect(d.grupos![0].regras.map((r) => r.inicio)).toEqual(["2025-09-28", "2025-11-03"]);
    expect(d.grupos![0].tabela.at(-1)!.subtotal).toBe(d.totalCentavos);
  });

  it("sem verbas ou com verba vencendo depois da data final: erro claro", () => {
    const base = { dataAjuizamento: "2023-03-15", dataFinal: "2024-01-10", regimeIds: REGIMES_TRABALHISTAS_PADRAO.map((r) => r.id), indicesSubstitutos: {}, rescisao: null };
    expect(() => calcularTrabalhista({ ...base, verbas: [] }, ctx)).toThrow(/ao menos uma verba/);
    expect(() => calcularTrabalhista({ ...base, verbas: [{ descricao: "X", valorCentavos: 100, vencimento: "2024-05-01" }] }, ctx)).toThrow(/vence depois/);
  });
});

describe("Formulário trabalhista", () => {
  const PAD = REGIMES_TRABALHISTAS_PADRAO.map((r) => r.id);
  const fd = (o: Record<string, string | string[]>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x);
    return f;
  };
  it("lê rescisão e verbas avulsas (linhas vazias ignoradas) e devolve aos campos para editar", async () => {
    const { lerFormulario, valoresDe } = await import("@/lib/calculos/formulario");
    const r = lerFormulario("trabalhista", fd({
      titulo: "Reclamação", data_ajuizamento: "2023-03-15", data_final: "2026-02-10", modo_regimes: "padrao",
      com_rescisao: "on", admissao: "2021-03-10", saida: "2025-09-18", tipo_desligamento: "sem_justa_causa", aviso_indenizado: "on",
      salario: "3.250,00", medias: "412,37", ferias_vencidas: "1", ferias_dobro: "0", saldo_fgts: "14.380,52",
      verba_descricao: ["Salário de março/2022", ""], verba_valor: ["1.000,00", ""], verba_vencimento: ["2022-04-05", ""],
    }), PAD, PAD);
    if ("erro" in r) throw new Error(r.erro);
    expect(r.parametros).toMatchObject({
      dataAjuizamento: "2023-03-15", regimeIds: PAD,
      rescisao: { salarioCentavos: 325000, mediasCentavos: 41237, saldoFgtsCentavos: 1438052, avisoIndenizado: true },
      verbas: [{ descricao: "Salário de março/2022", valorCentavos: 100000, vencimento: "2022-04-05" }],
    });
    const v = valoresDe({ titulo: "R", processo_id: null, partes: null, parametros: { ...r.parametros, modoRegimes: "padrao" }, regimes: PAD });
    expect([v.data_ajuizamento, v.salario, v.saldo_fgts, v.verbas[0].valor, v.com_rescisao]).toEqual(["2023-03-15", "3.250,00", "14.380,52", "1.000,00", true]);
  });
  it("exige o ajuizamento e ao menos uma verba", async () => {
    const { lerFormulario } = await import("@/lib/calculos/formulario");
    expect(lerFormulario("trabalhista", fd({ titulo: "R1", data_final: "2026-02-10" }), PAD, PAD)).toEqual({ erro: "Informe a data de ajuizamento da ação (obrigatória no cálculo trabalhista)." });
    expect(lerFormulario("trabalhista", fd({ titulo: "R1", data_ajuizamento: "2023-03-15", data_final: "2026-02-10" }), PAD, PAD)).toEqual({ erro: "Informe os dados da rescisão ou ao menos uma verba." });
  });
});
