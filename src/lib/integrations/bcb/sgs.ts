/**
 * Integração com o SGS (Sistema Gerenciador de Séries Temporais) do Banco Central.
 * API pública, sem chave: https://api.bcb.gov.br/dados/serie/bcdata.sgs.{codigo}/dados?formato=json&dataInicial=..&dataFinal=..
 * Usada SÓ pelo job de índices: o cálculo nunca chama a API em tempo real (lê o cache no banco).
 */
import type { ChamarRpc } from "@/lib/captura/job";
import type { CodigoSerie } from "@/lib/calculos/base";

/** Códigos conferidos em 09/11/2026 (P-005): API do SGS + lista de índices da Calculadora do Cidadão. */
export const SERIES_SGS: Record<CodigoSerie, number> = {
  IPCA: 433,
  IPCA_E: 10764,
  IPCA_15: 7478,
  INPC: 188,
  IGP_M: 28655, // a Calculadora usa a 28655 (mais casas decimais) e não a antiga 189
  TR: 7811,
  SELIC: 4390,
  TAXA_LEGAL: 29543,
};

/** Séries cujo valor do mês corrente é parcial (acumulado até hoje): só gravar meses fechados. */
const SO_MES_FECHADO: CodigoSerie[] = ["SELIC"];

export type ValorMensal = { mes: string; valor: string };

const br = (iso: string) => iso.split("-").reverse().join("/");

export function urlSgs(codigo: number, de: string, ate: string): string {
  return `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${codigo}/dados?formato=json&dataInicial=${br(de)}&dataFinal=${br(ate)}`;
}

/** Valida e converte a resposta. Qualquer coisa fora do formato esperado é erro (nunca grava lixo). */
export function lerRespostaSgs(json: unknown, serie: CodigoSerie, mesCorrente: string): ValorMensal[] {
  if (!Array.isArray(json)) throw new Error("Resposta do SGS fora do formato (esperava uma lista).");
  const out = new Map<string, string>();
  for (const item of json) {
    const data = (item as { data?: unknown }).data, valor = (item as { valor?: unknown }).valor;
    if (typeof data !== "string" || !/^01\/\d{2}\/\d{4}$/.test(data)) throw new Error(`Data inesperada no SGS: ${String(data).slice(0, 20)}`);
    if (typeof valor !== "string" || !/^-?\d{1,4}(\.\d{1,10})?$/.test(valor)) throw new Error(`Valor inesperado no SGS: ${String(valor).slice(0, 20)}`);
    const mes = `${data.slice(6)}-${data.slice(3, 5)}`;
    if (mes > mesCorrente) continue;
    if (mes === mesCorrente && SO_MES_FECHADO.includes(serie)) continue;
    out.set(mes, valor);
  }
  return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([mes, valor]) => ({ mes: `${mes}-01`, valor }));
}

export type DepsIndices = { fetch: typeof fetch; rpc: ChamarRpc; hoje: string; meses?: number };
export type ResumoSerie = { serie: CodigoSerie; ok: boolean; gravados: number; erro?: string };

/** Busca os últimos meses de cada série e grava no cache (cobre revisões da fonte). Uma série com erro não para as outras. */
export async function atualizarIndices(deps: DepsIndices): Promise<ResumoSerie[]> {
  const meses = deps.meses ?? 24;
  const [a, m] = deps.hoje.split("-").map(Number);
  const inicio = new Date(Date.UTC(a, m - 1 - meses, 1)).toISOString().slice(0, 10);
  const mesCorrente = deps.hoje.slice(0, 7);
  const resumo: ResumoSerie[] = [];
  for (const [serie, codigo] of Object.entries(SERIES_SGS) as [CodigoSerie, number][]) {
    try {
      const resp = await deps.fetch(urlSgs(codigo, inicio, deps.hoje), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000), cache: "no-store" });
      if (!resp.ok) throw new Error(`SGS respondeu ${resp.status}`);
      const valores = lerRespostaSgs(await resp.json(), serie, mesCorrente);
      if (!valores.length) throw new Error("SGS não devolveu nenhum valor no período");
      const gravados = await deps.rpc<number>("indices_gravar", { p_serie: serie, p_valores: valores });
      resumo.push({ serie, ok: true, gravados });
    } catch (e) {
      const erro = e instanceof Error ? e.message : String(e);
      await deps.rpc("indices_registrar_erro", { p_serie: serie, p_erro: erro }).catch(() => undefined);
      resumo.push({ serie, ok: false, gravados: 0, erro });
    }
  }
  return resumo;
}
