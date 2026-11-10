import { obterContexto } from "@/lib/contexto";
import { montarZip, type ArquivoAssinado } from "@/lib/conta/zip";

export const maxDuration = 120;

type Tabelas = Record<string, Record<string, unknown>[]>;

/**
 * Baixa tudo: ZIP com CSV de todas as tabelas do escritório + PDFs dos documentos assinados.
 * Só o dono (o banco recusa os outros). Disponível sempre, e é o que o dono usa nos 30 dias de encerramento.
 * A resposta vai em pedaços (stream) para não esbarrar no limite de 4,5 MB de resposta única da Vercel.
 */
export async function GET() {
  const { supabase, vinculo } = await obterContexto().then((c) => {
    if (!c.vinculo) throw new Response("Sem escritório.", { status: 404 });
    return { supabase: c.supabase, vinculo: c.vinculo };
  });
  if (vinculo.papel !== "dono") return new Response("Só o dono pode exportar.", { status: 403 });

  const [tab, ass] = await Promise.all([
    supabase.rpc("conta_exportar", { p_escritorio: vinculo.escritorioId }),
    supabase.rpc("conta_exportar_assinaturas", { p_escritorio: vinculo.escritorioId }),
  ]);
  if (tab.error || ass.error) return new Response("Não foi possível montar a exportação. Tente de novo.", { status: 500 });
  const assinaturas = ass.data as Tabelas;

  const arquivos: ArquivoAssinado[] = [];
  for (const env of assinaturas.assinatura_envelope ?? []) {
    const { data, error } = await supabase.rpc("conta_exportar_arquivo", { p_escritorio: vinculo.escritorioId, p_envelope: env.id as string });
    if (error) return new Response("Não foi possível ler um dos documentos assinados. Tente de novo.", { status: 500 });
    const a = data as { nome_arquivo: string; original: string; final: string | null } | null;
    if (!a) continue;
    arquivos.push({
      envelopeId: env.id as string, titulo: String(env.titulo ?? "documento"), nomeArquivo: a.nome_arquivo,
      original: Buffer.from(a.original, "base64"), final: a.final ? Buffer.from(a.final, "base64") : null,
    });
  }

  const zip = montarZip({ escritorio: vinculo.escritorioNome, geradoEm: new Date(), tabelas: tab.data as Tabelas, assinaturas, arquivos });
  const PEDACO = 512 * 1024;
  let pos = 0;
  const corpo = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pos >= zip.length) return c.close();
      c.enqueue(zip.subarray(pos, pos + PEDACO));
      pos += PEDACO;
    },
  });
  const dia = new Date().toISOString().slice(0, 10);
  return new Response(corpo, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="law-exportacao-${dia}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
