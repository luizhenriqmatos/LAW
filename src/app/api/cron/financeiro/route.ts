import { timingSafeEqual } from "node:crypto";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

/**
 * Job diário: parcela aberta e vencida vira "atrasada" (Vercel Cron). Quem lê as telas já vê o atraso pela data,
 * então este job só deixa o status gravado igual ao que se vê.
 * PENDENCIA P-030: plano gratuito da Vercel limita cron a 1x por dia.
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
  try {
    const marcadas = await rpcServico()<number>("parcelas_marcar_atrasadas", { p_hoje: hojeBrasilia() });
    return Response.json({ marcadas });
  } catch {
    return Response.json({ erro: "falha ao marcar parcelas" }, { status: 500 });
  }
}
