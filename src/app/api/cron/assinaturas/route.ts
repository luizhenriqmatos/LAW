import { timingSafeEqual } from "node:crypto";
import { finalizarEnvelope } from "@/lib/assinatura/finalizar";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

/**
 * Job diário de segurança: envelope em que TODOS já assinaram mas o PDF final não saiu (queda no meio do caminho).
 * Repete a finalização, que é idempotente. Máximo de 20 por execução.
 */
function autorizado(cabecalho: string | null): boolean {
  const segredo = process.env.CRON_SECRET;
  if (!segredo || !cabecalho) return false;
  const a = Buffer.from(cabecalho), b = Buffer.from(`Bearer ${segredo}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!autorizado(request.headers.get("authorization"))) return Response.json({ erro: "não autorizado" }, { status: 401 });
  if (!servicoConfigurado()) return Response.json({ erro: "Supabase de serviço não configurado" }, { status: 503 });
  const rpc = rpcServico();
  let concluidos = 0, falhas = 0;
  for (const id of await rpc<string[]>("assinatura_pendentes_finalizacao", { p_limite: 20 })) {
    try {
      const r = await finalizarEnvelope(rpc, id);
      if (r.ok) concluidos++; else falhas++;
    } catch (e) {
      falhas++;
      console.error("Assinaturas: finalização falhou:", id, e instanceof Error ? e.message : e);
    }
  }
  return Response.json({ concluidos, falhas });
}
