import { NextResponse } from "next/server";
import { z } from "zod";
import { obterContexto } from "@/lib/contexto";

/** Baixa a minuta em texto. RLS: só quem tem Documentos lê a tabela minuta. */
export async function GET(_: Request, ctx: RouteContext<"/app/assistente/minutas/[id]/texto">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return new NextResponse("Não encontrado", { status: 404 });
  const { supabase, modulos } = await obterContexto();
  if (!modulos.includes("assistente") || !modulos.includes("documentos")) return new NextResponse("Sem permissão", { status: 403 });
  const { data } = await supabase.from("minuta").select("titulo, texto, status").eq("id", id).maybeSingle();
  if (!data) return new NextResponse("Não encontrado", { status: 404 });
  const aviso = data.status === "revisado" ? "" : "[MINUTA NÃO REVISADA — confira antes de usar]\n\n";
  const nome = data.titulo.normalize("NFD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "minuta";
  return new NextResponse(aviso + data.texto, {
    headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${nome}.txt"`, "cache-control": "no-store" },
  });
}
