import { timingSafeEqual } from "node:crypto";
import { dispararCapturaGeral } from "@/lib/captura/disparar";

/**
 * Captura diária de publicações (Vercel Cron, ver vercel.json: 07:00 UTC = 04:00 em Brasília).
 * A função roda em gru1 (São Paulo): o DJEN recusa acesso de fora do Brasil.
 * Só aceita chamada com Authorization: Bearer <CRON_SECRET> (a Vercel envia automaticamente).
 */
export const maxDuration = 300;

function autorizado(cabecalho: string | null): boolean {
  const segredo = process.env.CRON_SECRET;
  if (!segredo || !cabecalho) return false;
  const a = Buffer.from(cabecalho);
  const b = Buffer.from(`Bearer ${segredo}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!autorizado(request.headers.get("authorization"))) {
    return Response.json({ erro: "não autorizado" }, { status: 401 });
  }
  const resumos = await dispararCapturaGeral("agendada");
  if (!resumos) {
    return Response.json({ erro: "captura não configurada (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 503 });
  }
  // Só contagens: nada de texto de publicação na resposta.
  return Response.json({
    escritorios: resumos.length,
    sucesso: resumos.filter((r) => r.status === "sucesso").length,
    parcial: resumos.filter((r) => r.status === "parcial").length,
    erro: resumos.filter((r) => r.status === "erro").length,
    novas: resumos.reduce((s, r) => s + r.novas, 0),
  });
}
