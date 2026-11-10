import type { SupabaseClient } from "@supabase/supabase-js";

export type OpcaoMembro = { id: string; nome: string };
export type OpcaoProcesso = { id: string; numero_cnj: string; titulo: string | null };
export type OpcaoCliente = { id: string; nome: string };

/** Listas dos seletores (responsável, processo, cliente). Processo e cliente: só os CONFIRMADOS. A RLS já filtra por permissão. */
export async function carregarOpcoes(supabase: SupabaseClient, escritorioId: string) {
  const [resp, proc, cli] = await Promise.all([
    supabase.rpc("responsaveis_tarefa", { p_escritorio: escritorioId }),
    supabase.from("processo").select("id, numero_cnj, titulo").eq("escritorio_id", escritorioId).eq("status", "confirmado").order("numero_cnj").limit(500),
    supabase.from("cliente").select("id, nome").eq("escritorio_id", escritorioId).eq("status", "confirmado").order("nome").limit(500),
  ]);
  const membros = ((resp.data ?? []) as { id: string; nome: string; email: string }[]).map((m) => ({ id: m.id, nome: m.nome?.trim() || m.email }));
  return {
    membros: membros as OpcaoMembro[],
    processos: (proc.data ?? []) as OpcaoProcesso[],
    clientes: (cli.data ?? []) as OpcaoCliente[],
  };
}

export const campo = "h-10 w-full rounded-xl border bg-white px-3 text-sm";
