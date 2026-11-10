import { z } from "zod";
import { bytesDeBytea } from "@/lib/assinatura/bytea";
import { exigirModulo } from "@/lib/contexto";

/** Baixa o PDF original ou o final. O banco confere a permissão (módulo Assinaturas) por dentro. */
export async function GET(_: Request, ctx: RouteContext<"/app/assinaturas/[id]/arquivo/[qual]">) {
  const { id, qual } = await ctx.params;
  if (!z.uuid().safeParse(id).success || (qual !== "original" && qual !== "final")) return new Response("Não encontrado", { status: 404 });
  const { supabase } = await exigirModulo("assinaturas");
  const { data, error } = await supabase.rpc("assinatura_baixar", { p_envelope: id, p_qual: qual });
  const r = data as { ok: boolean; nome_arquivo?: string; pdf?: unknown } | null;
  if (error || !r?.ok || !r.pdf) return new Response("Não encontrado", { status: 404 });
  const base = (r.nome_arquivo ?? "documento.pdf").replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "_").slice(0, 80) || "documento";
  return new Response(Buffer.from(bytesDeBytea(r.pdf)), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${base}${qual === "final" ? "-assinado" : ""}.pdf"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
