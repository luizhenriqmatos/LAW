import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { carregarCalendario } from "@/lib/prazos/servidor";
import { entradasDoTribunal } from "@/lib/prazos/contagem";
import { mesAnterior, mesDe, minData, type CodigoSerie, type Regime, type TabelaIndices } from "./base";
import { calcularTrabalhista, type ParametrosTrabalhista } from "./trabalhista";
import {
  calcularArt523, calcularAtualizacao, calcularHonorarios, type Contexto, type Demonstrativo, type ParametrosArt523,
  type ParametrosAtualizacao, type ParametrosHonorarios, type SerieInfo, type TipoCalculo,
} from "./calculos";

export type RegimeLinha = Regime & { escritorio_id: string | null; grupo_id: string; ativo: boolean };
export type ProcessoOpcao = { id: string; numero_cnj: string; titulo: string | null; tribunal: string | null; ativo: string | null; passivo: string | null };

/** Regimes visíveis ao escritório (padrão + personalizados), inclusive versões antigas (para reabrir cálculos antigos). */
export async function carregarRegimes(supabase: SupabaseClient): Promise<RegimeLinha[]> {
  const { data, error } = await supabase
    .from("regime_atualizacao")
    .select("id, escritorio_id, grupo_id, versao, ativo, nome, escopo, vigencia_inicio, vigencia_fim, inicio_no_marco, fim_no_marco, fundamento, correcao_indice, correcao_pro_rata, indice_editavel, juros_tipo, juros_valor, juros_pro_rata, teto")
    .order("escritorio_id", { ascending: true, nullsFirst: true })
    .order("vigencia_inicio", { ascending: true, nullsFirst: true })
    .order("versao", { ascending: false })
    .limit(1000);
  if (error) throw new Error("Não foi possível carregar os regimes.");
  return ((data ?? []) as RegimeLinha[]).map((r) => ({ ...r, juros_valor: r.juros_valor === null ? null : String(r.juros_valor) }));
}

const TODAS: CodigoSerie[] = ["IPCA", "IPCA_E", "IPCA_15", "INPC", "IGP_M", "TR", "SELIC", "TAXA_LEGAL"];

export async function carregarIndices(supabase: SupabaseClient, de: string, ate: string): Promise<{ indices: TabelaIndices; series: SerieInfo[] }> {
  const { data, error } = await supabase.rpc("indices_periodo", { p_series: TODAS, p_de: de, p_ate: ate });
  if (error) throw new Error("Não foi possível carregar os índices.");
  const r = data as { series: SerieInfo[]; valores: TabelaIndices };
  return { indices: r.valores ?? {}, series: r.series ?? [] };
}

/** Situação do cache: último mês de cada série. */
export async function situacaoIndices(supabase: SupabaseClient) {
  const { data } = await supabase.from("indice_serie").select("codigo, sgs, nome, fonte, coletado_em, ultimo_mes, erro, erro_em").order("codigo");
  return (data ?? []) as (SerieInfo & { erro: string | null; erro_em: string | null })[];
}

/**
 * Data final máxima sugerida: a correção usa índices até o mês anterior ao da data final, então com o IPCA (e o INPC)
 * publicados até MM/AAAA, dá para atualizar até o último dia do mês seguinte.
 */
export function dataFinalSugerida(series: { codigo: string; ultimo_mes: string | null }[], hoje: string): string {
  const ult = (c: string) => series.find((s) => s.codigo === c)?.ultimo_mes?.slice(0, 7);
  const limites = ["IPCA", "INPC"].map(ult).filter((x): x is string => !!x);
  if (!limites.length) return hoje;
  const menor = limites.sort()[0];
  const [a, m] = menor.split("-").map(Number);
  const ultimoDiaMesSeguinte = new Date(Date.UTC(a, m + 1, 0)).toISOString().slice(0, 10);
  return minData(hoje, ultimoDiaMesSeguinte);
}

export type Calculado = { demonstrativo: Demonstrativo; regimes: string[]; marcos: { tipo: string; data: string }[] };

/** Roda o cálculo no servidor com os dados do banco (regimes, índices em cache, calendário forense). */
export async function executarCalculo(
  supabase: SupabaseClient,
  escritorioId: string,
  tipo: TipoCalculo,
  parametros: ParametrosAtualizacao | ParametrosArt523 | ParametrosHonorarios | ParametrosTrabalhista,
  base: { titulo: string; processo: ProcessoOpcao | null; partes: string | null; dataCalculo: string },
): Promise<Calculado> {
  const ctxBase = { titulo: base.titulo, processo: base.processo ? { numero_cnj: base.processo.numero_cnj, titulo: base.processo.titulo } : null, partes: base.partes, dataCalculo: base.dataCalculo };
  if (tipo === "honorarios") {
    return { demonstrativo: calcularHonorarios(parametros as ParametrosHonorarios, ctxBase), regimes: [], marcos: [] };
  }
  if (tipo === "trabalhista") {
    const t = parametros as ParametrosTrabalhista;
    const datas = [...t.verbas.map((v) => v.vencimento), ...(t.rescisao ? [t.rescisao.saida] : [])].sort();
    const de = mesAnterior(mesDe(datas[0] ?? t.dataFinal)) + "-01";
    const [regimes, { indices, series }] = await Promise.all([carregarRegimes(supabase), carregarIndices(supabase, de, t.dataFinal)]);
    return {
      demonstrativo: calcularTrabalhista(t, { ...ctxBase, regimes, indices, series }),
      regimes: t.regimeIds,
      marcos: [{ tipo: "ajuizamento", data: t.dataAjuizamento }],
    };
  }
  const p = parametros as ParametrosAtualizacao;
  const de = mesAnterior(mesDe([p.dataBase, p.dataCitacao].filter((x): x is string => !!x).sort()[0])) + "-01";
  const [regimes, { indices, series }] = await Promise.all([carregarRegimes(supabase), carregarIndices(supabase, de, p.dataFinal)]);
  const ctx: Contexto = { ...ctxBase, regimes, indices, series };
  const marcos = [
    { tipo: "vencimento", data: p.dataBase },
    ...(p.dataCitacao ? [{ tipo: "citacao", data: p.dataCitacao }] : []),
    ...(p.dataAjuizamento ? [{ tipo: "ajuizamento", data: p.dataAjuizamento }] : []),
    ...(p.dataTransito ? [{ tipo: "transito_em_julgado", data: p.dataTransito }] : []),
  ];
  if (tipo === "art523") {
    ctx.calendario = entradasDoTribunal(await carregarCalendario(supabase, escritorioId), base.processo?.tribunal);
    const p523 = parametros as ParametrosArt523;
    return { demonstrativo: calcularArt523(p523, ctx), regimes: p.regimeIds, marcos: [...marcos, { tipo: "intimacao", data: p523.dataIntimacao }] };
  }
  return { demonstrativo: calcularAtualizacao(p, ctx), regimes: p.regimeIds, marcos };
}
