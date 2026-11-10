import { z } from "zod";
import { baixarArquivo } from "@/lib/drive/arquivos";
import { depsDriveDoAmbiente, driveConfigurado } from "@/lib/drive/ambiente";
import { obterDocumento } from "@/lib/portal/servidor";

const uuid = z.uuid();

/** Nome seguro para o cabeçalho: sem aspas, barras nem quebras de linha. */
function nomeParaDownload(nome: string): string {
  return nome.replace(/[\r\n"\\/]/g, "_").slice(0, 150) || "documento";
}

function recusar(status: number, texto: string) {
  return new Response(texto, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function GET(_: Request, ctx: RouteContext<"/portal/processos/[id]/documentos/[docId]">) {
  const { id, docId } = await ctx.params;
  if (!uuid.safeParse(id).success || !uuid.safeParse(docId).success) return recusar(404, "Documento não encontrado.");

  // O banco confere sessão, liberação, segredo de justiça e se o documento ainda está compartilhado.
  const doc = await obterDocumento(id, docId);
  if (!doc) return recusar(404, "Documento não encontrado.");
  if (!driveConfigurado()) return recusar(503, "O download não está disponível agora. Fale com o seu advogado.");

  const r = await baixarArquivo(depsDriveDoAmbiente(), doc.escritorio_id, doc.arquivo_drive_id);
  if (!r.ok) {
    return recusar(r.codigo === "arquivo_grande" ? 413 : 503, r.codigo === "arquivo_grande"
      ? "Este arquivo é grande demais para baixar por aqui. Peça ao seu advogado."
      : "Não foi possível baixar agora. Tente de novo em alguns minutos.");
  }
  return new Response(r.dados.corpo, {
    headers: {
      "content-type": r.dados.mime || "application/octet-stream",
      // Sempre como download e sem "adivinhar" o tipo: um arquivo nunca roda como página dentro do portal.
      "content-disposition": `attachment; filename="${nomeParaDownload(doc.nome)}"; filename*=UTF-8''${encodeURIComponent(doc.nome)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      ...(r.dados.tamanho !== null ? { "content-length": String(r.dados.tamanho) } : {}),
    },
  });
}
