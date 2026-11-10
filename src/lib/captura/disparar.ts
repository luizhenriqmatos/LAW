import "server-only";
import { criarFontes } from "@/lib/integrations/fontes";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";
import { capturarEscritorio, capturarTodos, type Origem, type ResumoCaptura } from "./job";

/** Captura de um escritório agora (ex.: logo após o onboarding). Sem configuração, não faz nada: o status fica "na fila". */
export async function dispararCaptura(escritorioId: string, origem: Origem): Promise<ResumoCaptura | null> {
  if (!servicoConfigurado()) return null; // PENDENCIA P-015
  return capturarEscritorio(escritorioId, origem, { fontes: criarFontes(), rpc: rpcServico() });
}

export async function dispararCapturaGeral(origem: Origem): Promise<ResumoCaptura[] | null> {
  if (!servicoConfigurado()) return null;
  return capturarTodos(origem, { fontes: criarFontes(), rpc: rpcServico() });
}
