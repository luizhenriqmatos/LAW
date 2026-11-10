import { timingSafeEqual } from "node:crypto";
import { atualizarIndices } from "@/lib/integrations/bcb/sgs";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

/**
 * Atualiza o cache de índices (SGS do Banco Central). Roda nos dias 2, 12 e 26 de cada mês (vercel.json):
 * Taxa Legal sai no 1º dia útil; IPCA e INPC por volta do dia 10; IGP-M no fim do mês.
 * Busca os últimos 24 meses de cada série, para pegar também revisões da fonte.
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
  const resumo = await atualizarIndices({ fetch, rpc: rpcServico(), hoje: hojeBrasilia() });
  return Response.json({ resumo }, { status: resumo.every((r) => r.ok) ? 200 : 207 });
}
