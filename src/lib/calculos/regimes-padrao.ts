import type { Regime } from "./base";

/**
 * Regimes cíveis padrão: os MESMOS da migração 20261110000000_calculos.sql (um teste de banco confere).
 * São sugestão: o contrato ou a decisão judicial podem fixar outro critério.
 */
export const DATA_LEI_14905 = "2024-08-30";

export const REGIME_CIVEL_ATE_LEI: Regime = {
  inicio_no_marco: null,
  fim_no_marco: null,
  id: "00000000-0000-4000-8000-000000000801",
  nome: "Cível — até 29/08/2024 (índice escolhido + juros de 1% ao mês)",
  versao: 1,
  escopo: "civel",
  vigencia_inicio: null,
  vigencia_fim: "2024-08-29",
  fundamento:
    "Código Civil, art. 406 (redação anterior à Lei 14.905/2024) c/c CTN, art. 161, § 1º: juros de mora de 1% ao mês, simples. Correção pelo índice convencionado ou fixado na decisão (padrão sugerido: INPC; Lei 6.899/1981).",
  correcao_indice: "INPC",
  correcao_pro_rata: false,
  indice_editavel: true,
  juros_tipo: "percentual_ao_mes",
  juros_valor: "1",
  juros_pro_rata: true,
  teto: "nenhum",
};

export const REGIME_CIVEL_DESDE_LEI: Regime = {
  inicio_no_marco: null,
  fim_no_marco: null,
  id: "00000000-0000-4000-8000-000000000802",
  nome: "Cível — desde 30/08/2024 (IPCA + Taxa Legal, Lei 14.905/2024)",
  versao: 1,
  escopo: "civel",
  vigencia_inicio: DATA_LEI_14905,
  vigencia_fim: null,
  fundamento:
    "Lei 14.905/2024: Código Civil, art. 389, parágrafo único (correção pelo IPCA quando não houver índice convencionado) e art. 406, §§ 1º a 3º (juros pela Taxa Legal = Selic menos IPCA, piso zero; Resolução CMN 5.171/2024). Vedada a soma da Selic com outro índice de correção no mesmo período.",
  correcao_indice: "IPCA",
  correcao_pro_rata: false,
  indice_editavel: true,
  juros_tipo: "taxa_legal",
  juros_valor: null,
  juros_pro_rata: true,
  teto: "nenhum",
};

export const REGIMES_CIVEIS_PADRAO = [REGIME_CIVEL_ATE_LEI, REGIME_CIVEL_DESDE_LEI];

// ---------------------------------------------------------------------------------------------------------------
// Trabalhista (Prompt 8B): fases do STF (ADC 58) e do TST. O marco "ajuizamento" corta a linha do tempo.
// ---------------------------------------------------------------------------------------------------------------
const FUNDAMENTO_ADC58 = "STF, ADC 58 e 59 (Tema 1191): até lei superveniente, IPCA-E na fase pré-judicial e Selic a partir do ajuizamento.";

export const REGIME_TRAB_PRE_JUDICIAL: Regime = {
  id: "00000000-0000-4000-8000-000000000803",
  nome: "Trabalhista — fase pré-judicial (IPCA-E + juros do art. 39 da Lei 8.177/1991)",
  versao: 1,
  escopo: "trabalhista",
  vigencia_inicio: null,
  vigencia_fim: null,
  inicio_no_marco: null,
  fim_no_marco: "ajuizamento",
  fundamento: `${FUNDAMENTO_ADC58} Do vencimento de cada verba até a véspera do ajuizamento: correção pelo IPCA-E e juros legais do art. 39, caput, da Lei 8.177/1991 (TR acumulada no período).`,
  correcao_indice: "IPCA_E",
  correcao_pro_rata: false,
  indice_editavel: false,
  juros_tipo: "tr_art39_lei8177",
  juros_valor: null,
  juros_pro_rata: true,
  teto: "nenhum",
};

export const REGIME_TRAB_SELIC: Regime = {
  id: "00000000-0000-4000-8000-000000000804",
  nome: "Trabalhista — do ajuizamento até 29/08/2024 (Selic)",
  versao: 1,
  escopo: "trabalhista",
  vigencia_inicio: null,
  vigencia_fim: "2024-08-29",
  inicio_no_marco: "ajuizamento",
  fim_no_marco: null,
  fundamento: `${FUNDAMENTO_ADC58} Do ajuizamento até 29/08/2024: só a Selic, que já engloba correção e juros; nenhum juro adicional.`,
  correcao_indice: "nenhuma",
  correcao_pro_rata: false,
  indice_editavel: false,
  juros_tipo: "selic_englobando_correcao_e_juros",
  juros_valor: null,
  juros_pro_rata: true,
  teto: "nenhum",
};

export const REGIME_TRAB_DESDE_LEI: Regime = {
  id: "00000000-0000-4000-8000-000000000805",
  nome: "Trabalhista — fase judicial desde 30/08/2024 (IPCA + Taxa Legal)",
  versao: 1,
  escopo: "trabalhista",
  vigencia_inicio: DATA_LEI_14905,
  vigencia_fim: null,
  inicio_no_marco: "ajuizamento",
  fim_no_marco: null,
  fundamento: "TST, SBDI-1, E-ED-RR-713-03.2010.5.04.0029 (17/10/2024), aplicando a Lei 14.905/2024: a partir de 30/08/2024, correção pelo IPCA (CC, art. 389, parágrafo único) e juros pela Taxa Legal = Selic menos IPCA, podendo ser zero (CC, art. 406).",
  correcao_indice: "IPCA",
  correcao_pro_rata: false,
  indice_editavel: false,
  juros_tipo: "taxa_legal",
  juros_valor: null,
  juros_pro_rata: true,
  teto: "nenhum",
};

export const REGIMES_TRABALHISTAS_PADRAO = [REGIME_TRAB_PRE_JUDICIAL, REGIME_TRAB_SELIC, REGIME_TRAB_DESDE_LEI];
