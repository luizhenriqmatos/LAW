import { bytesDeBytea } from "@/lib/assinatura/bytea";
import { DocumentoParaAssinar } from "@/lib/assinatura/tipos";
import { agenteAtual, ipAtual } from "@/lib/portal/sessao";
import { hashDoToken, tokenComFormatoValido } from "@/lib/portal/token";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

/** Entrega o PDF para leitura. É isto que registra a "visualização" do documento como evidência. */
export async function GET(_: Request, ctx: RouteContext<"/assinar/[token]/documento">) {
  const { token } = await ctx.params;
  if (!tokenComFormatoValido(token) || !servicoConfigurado()) return new Response("Não encontrado", { status: 404 });
  const r = DocumentoParaAssinar.parse(
    await rpcServico()("assinatura_documento_para_assinar", { p_token_hash: hashDoToken(token), p_ip: await ipAtual(), p_user_agent: await agenteAtual() }),
  );
  if (!r.ok) return new Response("Não encontrado", { status: 404 });
  return new Response(Buffer.from(bytesDeBytea(r.pdf)), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="documento.pdf"',
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "frame-ancestors 'self'",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
