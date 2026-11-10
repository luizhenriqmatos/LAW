import "server-only";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "./config";
import type { ChamarRpc } from "@/lib/captura/job";

/**
 * Cliente com a chave service_role: ignora RLS. Uso EXCLUSIVO do job de captura no servidor.
 * Nunca importar em componente de cliente. A chave não tem prefixo NEXT_PUBLIC_, então não vai para o navegador.
 * PENDENCIA P-015: sem SUPABASE_SERVICE_ROLE_KEY o job não roda (e avisa).
 */
export function servicoConfigurado(): boolean {
  return SUPABASE_URL.length > 0 && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export function rpcServico(): ChamarRpc {
  const cliente = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return async <T,>(funcao: string, args: Record<string, unknown>) => {
    const { data, error } = await cliente.rpc(funcao, args);
    if (error) throw new Error(`Banco recusou ${funcao}: ${error.message}`);
    return data as T;
  };
}
