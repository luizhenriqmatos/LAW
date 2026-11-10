import { NextResponse } from "next/server";
import { CORS, metadadosRecurso, urlBase } from "@/lib/oauth/config";

// RFC 9728. Também respondido em /.well-known/oauth-protected-resource/api/mcp (variante com o caminho do recurso).
export const dynamic = "force-dynamic";
export function GET() {
  const base = urlBase();
  if (!base) return NextResponse.json({ error: "nao_configurado" }, { status: 503, headers: CORS });
  return NextResponse.json(metadadosRecurso(base), { headers: { ...CORS, "Cache-Control": "public, max-age=300" } });
}
export const OPTIONS = () => new Response(null, { status: 204, headers: CORS });
