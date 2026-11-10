import { z } from "zod";
import { exigirModulo } from "@/lib/contexto";
import { gerarCsv, type LinhaParcela } from "@/lib/financeiro/csv";
import { lerFiltros, paraParcelas } from "@/lib/financeiro/filtros";
import { hojeBrasilia } from "@/lib/prazos/servidor";

/** Exporta as parcelas (uma linha por parcela) com os mesmos filtros da lista. Exige a permissão "financeiro". */
export async function GET(request: Request) {
  const { supabase, vinculo } = await exigirModulo("financeiro");
  const url = new URL(request.url);
  const f = lerFiltros(Object.fromEntries(url.searchParams.entries()));
  const filtros: Record<string, unknown> = paraParcelas(f);
  // O extrato por cliente/processo manda o id na URL; ids inválidos são ignorados.
  const cliente = z.uuid().safeParse(url.searchParams.get("cliente"));
  const processo = z.uuid().safeParse(url.searchParams.get("processo"));
  if (cliente.success) filtros.cliente_id = cliente.data;
  if (processo.success) filtros.processo_id = processo.data;
  const hoje = hojeBrasilia();
  const { data, error } = await supabase.rpc("financeiro_parcelas", { p_escritorio: vinculo.escritorioId, p_filtros: filtros, p_hoje: hoje });
  if (error) return new Response("Não foi possível gerar o arquivo.", { status: 500 });
  const itens = ((data as { itens: LinhaParcela[] } | null)?.itens ?? []).filter((p) => p);
  return new Response(gerarCsv(itens, hoje), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="financeiro-${hoje}.csv"`,
      "cache-control": "no-store",
    },
  });
}
