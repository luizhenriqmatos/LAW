import { timingSafeEqual } from "node:crypto";
import { rodarRotinaEncerramento } from "@/lib/conta/rotina";
import { servicoEmail } from "@/lib/integrations/email";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

/**
 * Rotina diária do encerramento de contas: exclui as que passaram de 30 dias e manda os avisos (pedido, 7 dias, exclusão).
 * PENDENCIA P-030: plano gratuito da Vercel limita cron a 1x por dia (o prazo de 30 dias é cumprido com até 1 dia de folga).
 */
export const maxDuration = 120;

function autorizado(cabecalho: string | null): boolean {
  const segredo = process.env.CRON_SECRET;
  if (!segredo || !cabecalho) return false;
  const a = Buffer.from(cabecalho), b = Buffer.from(`Bearer ${segredo}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!autorizado(request.headers.get("authorization"))) return Response.json({ erro: "não autorizado" }, { status: 401 });
  if (!servicoConfigurado()) return Response.json({ erro: "Supabase de serviço não configurado" }, { status: 503 });
  const r = await rodarRotinaEncerramento(rpcServico(), servicoEmail(), new Date());
  return Response.json({ excluidas: r.excluidas.length, avisos: r.avisos, falhas: r.falhas.length }, { status: r.falhas.length ? 500 : 200 });
}
