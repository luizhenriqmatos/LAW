import { z } from "zod";
import { CATEGORIAS, SITUACOES_LANCAMENTO, TIPOS } from "./rotulos";

/**
 * Filtros da lista de lançamentos e do CSV. Vêm da URL, então tudo é validado: valor fora do esperado é ignorado
 * (nunca vira consulta). Os mesmos nomes servem à tela e à exportação.
 */
const vazio = (v: unknown) => (v === "" || v === undefined ? undefined : v);
const dia = z.preprocess(vazio, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined));
const uuid = z.preprocess(vazio, z.uuid().optional().catch(undefined));

const esquema = z.object({
  tipo: z.preprocess(vazio, z.enum(Object.keys(TIPOS) as [string, ...string[]]).optional().catch(undefined)),
  categoria: z.preprocess(vazio, z.enum(Object.keys(CATEGORIAS) as [string, ...string[]]).optional().catch(undefined)),
  situacao: z.preprocess(vazio, z.enum(Object.keys(SITUACOES_LANCAMENTO) as [string, ...string[]]).optional().catch(undefined)),
  cliente: uuid,
  processo: uuid,
  de: dia,
  ate: dia,
  busca: z.preprocess(vazio, z.string().trim().min(1).max(100).optional().catch(undefined)),
  pagina: z.preprocess(vazio, z.coerce.number().int().min(1).max(10000).optional().catch(undefined)),
});

export type FiltrosFinanceiro = z.infer<typeof esquema>;
export const POR_PAGINA = 50;

type Parametros = Record<string, string | string[] | undefined>;

export function lerFiltros(sp: Parametros): FiltrosFinanceiro {
  const plano = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  return esquema.parse(plano);
}

const limpo = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Filtros para `financeiro_lancamentos`. */
export function paraLancamentos(f: FiltrosFinanceiro) {
  return limpo({
    tipo: f.tipo, categoria: f.categoria, situacao: f.situacao, cliente_id: f.cliente, processo_id: f.processo,
    de: f.de, ate: f.ate, busca: f.busca, limite: POR_PAGINA, deslocamento: ((f.pagina ?? 1) - 1) * POR_PAGINA,
  });
}

const SITUACAO_PARCELA: Record<string, string> = { aberto: "em_aberto", atrasado: "atrasada", quitado: "paga", cancelado: "cancelada" };

/** Filtros para `financeiro_parcelas` (CSV): as parcelas dos lançamentos que a lista mostra. Período = competência. */
export function paraParcelas(f: FiltrosFinanceiro) {
  return limpo({
    tipo: f.tipo, categoria: f.categoria, situacao: f.situacao ? SITUACAO_PARCELA[f.situacao] : undefined,
    cliente_id: f.cliente, processo_id: f.processo, comp_de: f.de, comp_ate: f.ate, busca: f.busca, limite: 5000,
  });
}

/** Volta para a URL (links de paginação e de exportação). */
export function paraQuery(f: FiltrosFinanceiro, extra: Record<string, string | number | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}
