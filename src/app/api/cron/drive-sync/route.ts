import { timingSafeEqual } from "node:crypto";
import { depsDriveDoAmbiente, driveConfigurado } from "@/lib/drive/ambiente";
import { processarFilaDrive } from "@/lib/drive/sync";

/**
 * Rede de segurança diária da criação de pastas no Drive (Vercel Cron). O caminho normal é imediato (depois de
 * confirmar/renomear); este roda o que ficou na fila (falha temporária, limite do Google, etc.).
 * PENDENCIA P-030: plano gratuito da Vercel limita cron a 1x por dia.
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
  if (!driveConfigurado()) return Response.json({ erro: "Google não configurado" }, { status: 503 });
  const deps = depsDriveDoAmbiente();
  const total = { itens: 0, criadas: 0, renomeadas: 0, movidas: 0, desvinculadas: 0, ignoradas: 0, falhas: 0, conexoesParadas: 0 };
  for (let volta = 0; volta < 10; volta++) {
    const r = await processarFilaDrive({ ...deps, limite: 50 });
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += r[k];
    if (r.itens < 50) break;
  }
  return Response.json(total);
}
