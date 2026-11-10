import { timingSafeEqual } from "node:crypto";
import { servicoEmail } from "@/lib/integrations/email";
import { executarAlertas } from "@/lib/prazos/executar-alertas";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

/**
 * Alertas de prazo (Vercel Cron, ver vercel.json: 10:00 UTC = 07:00 na Bahia/Brasília, sem horário de verão).
 * Só aceita chamada com Authorization: Bearer <CRON_SECRET>. Responde só contagens.
 */
export const maxDuration = 120;

function autorizado(cabecalho: string | null): boolean {
  const segredo = process.env.CRON_SECRET;
  if (!segredo || !cabecalho) return false;
  const a = Buffer.from(cabecalho);
  const b = Buffer.from(`Bearer ${segredo}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!autorizado(request.headers.get("authorization"))) return Response.json({ erro: "não autorizado" }, { status: 401 });
  if (!servicoConfigurado()) return Response.json({ erro: "alertas não configurados (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 503 });
  const resumo = await executarAlertas({ rpc: rpcServico(), email: servicoEmail(), urlBase: process.env.NEXT_PUBLIC_SITE_URL });
  return Response.json(resumo);
}
