import "server-only";
import { after } from "next/server";
import { apiGoogleAgenda } from "@/lib/integrations/google/agenda-api";
import { chaveDoAmbiente } from "@/lib/integrations/google/cripto";
import { configGoogle, renovarAcesso } from "@/lib/integrations/google/oauth";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";
import { processarFila, type DepsSync } from "./sync";

/** Tudo que a sincronização precisa vem do ambiente; sem credenciais do Google ela simplesmente não roda. */
export function googleConfigurado(): boolean {
  if (!configGoogle() || !servicoConfigurado()) return false;
  try {
    chaveDoAmbiente();
    return true;
  } catch {
    return false;
  }
}

export function depsDoAmbiente(): DepsSync {
  const cfg = configGoogle();
  if (!cfg) throw new Error("Google não configurado.");
  return {
    rpc: rpcServico(),
    api: apiGoogleAgenda(),
    renovar: async (refresh) => {
      const t = await renovarAcesso(cfg, refresh);
      return { accessToken: t.accessToken, expiraEm: t.expiraEm };
    },
    chave: chaveDoAmbiente(),
    urlBase: process.env.NEXT_PUBLIC_SITE_URL ?? "",
  };
}

/**
 * Chamar depois de gravar tarefa/prazo/compromisso. Roda DEPOIS da resposta (o usuário não espera o Google).
 * Falha aqui nunca derruba a ação do usuário: o item fica na fila e o cron diário repete.
 */
export function agendarSincronizacao() {
  if (!googleConfigurado()) return;
  after(async () => {
    try {
      await processarFila(depsDoAmbiente());
    } catch (e) {
      console.error("Sincronização com o Google falhou:", e instanceof Error ? e.message : e);
    }
  });
}
