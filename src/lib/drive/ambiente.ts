import "server-only";
import { after } from "next/server";
import { apiGoogleDrive } from "@/lib/integrations/google/drive-api";
import { chaveDoAmbiente } from "@/lib/integrations/google/cripto";
import { configGoogle, renovarAcesso } from "@/lib/integrations/google/oauth";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";
import { processarFilaDrive } from "./sync";
import type { DepsDrive } from "./token";

/** Mesmas credenciais do Google Agenda (um app só no Google Cloud); sem elas o Drive fica desligado e o LAW segue normal. */
export function driveConfigurado(): boolean {
  if (!configGoogle() || !servicoConfigurado()) return false;
  try {
    chaveDoAmbiente();
    return true;
  } catch {
    return false;
  }
}

export function depsDriveDoAmbiente(): DepsDrive {
  const cfg = configGoogle();
  if (!cfg) throw new Error("Google não configurado.");
  return {
    rpc: rpcServico(),
    api: apiGoogleDrive(),
    renovar: async (refresh) => {
      const t = await renovarAcesso(cfg, refresh);
      return { accessToken: t.accessToken, expiraEm: t.expiraEm };
    },
    chave: chaveDoAmbiente(),
  };
}

/**
 * Chamar depois de confirmar/renomear cliente ou processo. Roda DEPOIS da resposta (ninguém espera o Google).
 * Falha aqui nunca derruba a ação: o item fica na fila e o cron diário repete.
 */
export function agendarSincronizacaoDrive() {
  if (!driveConfigurado()) return;
  after(async () => {
    try {
      await processarFilaDrive(depsDriveDoAmbiente());
    } catch (e) {
      console.error("Sincronização com o Drive falhou:", e instanceof Error ? e.message : e);
    }
  });
}
