import { NextResponse } from "next/server";
import { CORS } from "@/lib/oauth/config";
import { revogarToken } from "@/lib/oauth/endpoints";
import { depsOAuthDoAmbiente } from "@/lib/mcp/ambiente";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const deps = depsOAuthDoAmbiente();
  if (!deps) return NextResponse.json({ error: "temporarily_unavailable" }, { status: 503, headers: CORS });
  return revogarToken(req, deps);
}
export const OPTIONS = () => new Response(null, { status: 204, headers: CORS });
