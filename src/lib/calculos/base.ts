/**
 * Peças básicas do motor de cálculo: decimal de alta precisão, datas por mês e tipos compartilhados.
 * MÓDULO PURO: sem banco, sem relógio, sem rede. Datas em texto AAAA-MM-DD; meses em AAAA-MM.
 */
import Decimal from "decimal.js";

/** Decimal com 50 dígitos significativos. Dinheiro só é arredondado no valor final de cada linha. */
export const Dec = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof Dec>;

export const ZERO = new Dec(0);
export const UM = new Dec(1);
export const CEM = new Dec(100);

/** Centavos inteiros, meio para cima (0,5 centavo sobe). */
export const centavos = (v: Dec): number => v.toDecimalPlaces(0, Dec.ROUND_HALF_UP).toNumber();
/** Percentual com 6 casas, meio para cima (metodologia da Taxa Legal, Res. CMN 5.171/2024). */
export const seisCasas = (v: Dec): Dec => v.toDecimalPlaces(6, Dec.ROUND_HALF_UP);

export class ErroCalculo extends Error {
  constructor(public codigo: string, mensagem: string, public detalhes?: unknown) {
    super(mensagem);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------------------------------------------
const DATA = /^\d{4}-\d{2}-\d{2}$/;

export function dataValida(iso: unknown): iso is string {
  if (typeof iso !== "string" || !DATA.test(iso)) return false;
  const [a, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const utc = (iso: string) => {
  const [a, m, d] = iso.split("-").map(Number);
  return Date.UTC(a, m - 1, d);
};
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const somarDias = (d: string, n: number) => iso(utc(d) + n * 86_400_000);
export const diasEntre = (a: string, b: string) => Math.round((utc(b) - utc(a)) / 86_400_000);
export const mesDe = (d: string) => d.slice(0, 7);
export const primeiroDia = (mes: string) => `${mes}-01`;
export function proximoMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
}
export function mesAnterior(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
}
export function diasNoMes(mes: string): number {
  const [a, m] = mes.split("-").map(Number);
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}
export const maxData = (a: string, b: string) => (a > b ? a : b);
export const minData = (a: string, b: string) => (a < b ? a : b);
export const dataBr = (d: string) => d.split("-").reverse().join("/");
export const mesBr = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;

// ---------------------------------------------------------------------------------------------------------------
// Índices e regimes
// ---------------------------------------------------------------------------------------------------------------
export const INDICES_CORRECAO = ["IPCA", "IPCA_E", "IPCA_15", "INPC", "IGP_M", "TR"] as const;
export type CodigoIndice = (typeof INDICES_CORRECAO)[number];
export type CodigoSerie = CodigoIndice | "SELIC" | "TAXA_LEGAL";
export const NOMES_SERIE: Record<CodigoSerie, string> = {
  IPCA: "IPCA", IPCA_E: "IPCA-E", IPCA_15: "IPCA-15", INPC: "INPC", IGP_M: "IGP-M", TR: "TR", SELIC: "Selic", TAXA_LEGAL: "Taxa Legal",
};

export const TIPOS_JUROS = [
  "nenhum", "taxa_legal", "percentual_fixo_ao_ano_simples", "percentual_ao_mes", "tr_art39_lei8177", "selic_englobando_correcao_e_juros",
] as const;
export type TipoJuros = (typeof TIPOS_JUROS)[number];
export const NOMES_JUROS: Record<TipoJuros, string> = {
  nenhum: "Sem juros",
  taxa_legal: "Taxa Legal (art. 406 CC)",
  percentual_fixo_ao_ano_simples: "% ao ano, simples",
  percentual_ao_mes: "% ao mês, simples",
  tr_art39_lei8177: "TR (art. 39 da Lei 8.177/1991)",
  selic_englobando_correcao_e_juros: "Selic (engloba correção e juros)",
};

export const ESCOPOS = ["civel", "trabalhista", "fazenda_pre_expedicao", "fazenda_pos_expedicao"] as const;
export type Escopo = (typeof ESCOPOS)[number];

export type TipoMarco = "vencimento" | "citacao" | "ajuizamento" | "transito_em_julgado" | "intimacao" | "expedicao_requisitorio";
export const NOMES_MARCO: Record<TipoMarco, string> = {
  vencimento: "Vencimento (data-base)",
  citacao: "Citação",
  ajuizamento: "Ajuizamento da ação",
  transito_em_julgado: "Trânsito em julgado",
  intimacao: "Intimação para pagamento",
  expedicao_requisitorio: "Expedição do requisitório",
};
export const MARCOS_DE_REGIME: TipoMarco[] = ["ajuizamento", "citacao", "transito_em_julgado", "expedicao_requisitorio"];

export type Regime = {
  id: string;
  nome: string;
  versao: number;
  escopo: Escopo;
  vigencia_inicio: string | null;
  /** Inclusive. Nula = vigente. */
  vigencia_fim: string | null;
  /** Vale a partir da data deste marco do processo (inclusive), além da vigência por data. Ex.: Selic desde o ajuizamento. */
  inicio_no_marco?: TipoMarco | null;
  /** Vale até a véspera deste marco. Ex.: fase pré-judicial, até o dia anterior ao ajuizamento. */
  fim_no_marco?: TipoMarco | null;
  fundamento: string;
  correcao_indice: CodigoIndice | "nenhuma";
  correcao_pro_rata: boolean;
  indice_editavel: boolean;
  juros_tipo: TipoJuros;
  juros_valor: string | number | null;
  juros_pro_rata: boolean;
  teto: "nenhum" | "selic";
};

/** Valores mensais em % (texto, para não passar por float): { IPCA: { "2024-09": "0.44" } }. */
export type TabelaIndices = Partial<Record<CodigoSerie, Record<string, string>>>;

/** Regras de consistência do regime (o banco confere de novo). */
export function validarRegime(r: Pick<Regime, "correcao_indice" | "juros_tipo" | "juros_valor">): string | null {
  if (r.juros_tipo === "selic_englobando_correcao_e_juros" && r.correcao_indice !== "nenhuma") return "selic_com_indice";
  const precisaValor = r.juros_tipo === "percentual_ao_mes" || r.juros_tipo === "percentual_fixo_ao_ano_simples";
  if (precisaValor) {
    const v = Number(r.juros_valor);
    if (r.juros_valor === null || r.juros_valor === "" || !Number.isFinite(v) || v <= 0 || v > 100) return "juros_valor_invalido";
  }
  return null;
}

export function descreverCorrecao(indice: CodigoIndice | "nenhuma", proRata: boolean): string {
  if (indice === "nenhuma") return "Sem correção monetária";
  return `${NOMES_SERIE[indice]}${proRata ? " (pro rata por dias corridos)" : " (mês a mês)"}`;
}

export function descreverJuros(r: Pick<Regime, "juros_tipo" | "juros_valor" | "juros_pro_rata" | "teto">): string {
  const valor = r.juros_valor === null ? "" : String(r.juros_valor).replace(".", ",");
  const base =
    r.juros_tipo === "percentual_ao_mes" ? `${valor}% ao mês, simples`
    : r.juros_tipo === "percentual_fixo_ao_ano_simples" ? `${valor}% ao ano, simples`
    : NOMES_JUROS[r.juros_tipo];
  const extras = [r.juros_tipo !== "nenhum" && r.juros_pro_rata ? "pro rata por dias corridos" : null, r.teto === "selic" ? "limitado à Selic do período" : null].filter(Boolean);
  return extras.length ? `${base} (${extras.join("; ")})` : base;
}

/** Vigência por extenso, com marcos: "do ajuizamento até 29/08/2024", "até a véspera do ajuizamento". */
export function descreverVigencia(r: Pick<Regime, "vigencia_inicio" | "vigencia_fim" | "inicio_no_marco" | "fim_no_marco">): string {
  const marco = (m: TipoMarco) => NOMES_MARCO[m].replace(/ \(.*\)$/, "").toLowerCase();
  const ini = [r.vigencia_inicio ? `desde ${dataBr(r.vigencia_inicio)}` : null, r.inicio_no_marco ? `a partir do ${marco(r.inicio_no_marco)}` : null].filter(Boolean).join(" e ");
  const fim = [r.vigencia_fim ? `até ${dataBr(r.vigencia_fim)}` : null, r.fim_no_marco ? `até a véspera do ${marco(r.fim_no_marco)}` : null].filter(Boolean).join(" e ");
  return [ini || "sem início", fim || "até hoje"].join(", ");
}
