import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dataBrasilia } from "@/lib/integrations/fontes/datas";
import type { EntradaCalendario } from "./contagem";

/** Hoje no calendário de Brasília (fora do componente, para a página não chamar relógio direto). */
export const hojeBrasilia = (agora = new Date()) => dataBrasilia(agora);

type LinhaCalendario = {
  data: string; data_fim: string | null; escopo: EntradaCalendario["escopo"]; tribunal: string | null; uf: string | null;
  tipo: EntradaCalendario["tipo"]; descricao: string;
};

/** Calendário forense do escritório: linhas globais + as do escritório (a RLS já filtra). */
export async function carregarCalendario(supabase: SupabaseClient, escritorioId: string): Promise<EntradaCalendario[]> {
  const { data, error } = await supabase
    .from("calendario_forense")
    .select("data, data_fim, escopo, tribunal, uf, tipo, descricao")
    .or(`escritorio_id.is.null,escritorio_id.eq.${escritorioId}`)
    .limit(5000);
  if (error) throw new Error("Não foi possível carregar o calendário forense.");
  return ((data ?? []) as LinhaCalendario[]).map((r) => ({
    data: r.data, dataFim: r.data_fim, escopo: r.escopo, tribunal: r.tribunal, uf: r.uf, tipo: r.tipo, descricao: r.descricao,
  }));
}
