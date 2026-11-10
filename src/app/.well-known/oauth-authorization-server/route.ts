import { NextResponse } from "next/server";
import { CORS, metadadosServidor, urlBase } from "@/lib/oauth/config";

// RFC 8414.
export const dynamic = "force-dynamic";
export function GET() {
  const base = urlBase();
  if (!base) return NextResponse.json({ error: "nao_configurado" }, { status: 503, headers: CORS });
  return NextResponse.json(metadadosServidor(base), { headers: { ...CORS, "Cache-Control": "public, max-age=300" } });
}
export const OPTIONS = () => new Response(null, { status: 204, headers: CORS });
