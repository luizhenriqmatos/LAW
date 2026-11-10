import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { carregarCalendario } from "@/lib/prazos/servidor";
import type { EntradaCalendario } from "@/lib/prazos/contagem";
import type { CtxRascunho } from "./rascunhos";
import { ContextoAssistente, ErroAssistente, lerErroRpc, rpcDoCliente } from "./tipos";

/**
 * Contexto das ferramentas a partir da SESSÃO do usuário (cliente Supabase com o token dele).
 * Nunca usar o cliente de serviço aqui: a Lia tem exatamente as permissões de quem pergunta.
 */
export async function montarCtx(supabase: SupabaseClient, escritorioId: string): Promise<CtxRascunho> {
  const rpc = rpcDoCliente(supabase);
  const { data, error } = await rpc("assistente_contexto", { p_escritorio: escritorioId });
  if (error) throw new ErroAssistente(lerErroRpc(error).codigo, "Não foi possível carregar o contexto.");
  const contexto = ContextoAssistente.parse(data);
  let calendario: Promise<EntradaCalendario[]> | null = null;
  return {
    rpc, escritorioId, contexto,
    carregarCalendario: () => (calendario ??= carregarCalendario(supabase, escritorioId)),
  };
}
