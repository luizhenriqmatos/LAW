import type { ChamarRpc } from "@/lib/captura/job";
import { bytesDeBytea, byteaDeBytes } from "./bytea";
import { montarPdfFinal } from "./pdf";
import { Conclusao, DadosFinais } from "./tipos";

export type ResultadoFinalizacao = { ok: true; hashFinal: string } | { ok: false; motivo: string };

/**
 * Último passo do envelope (todos assinaram): monta original + manifesto e manda o banco guardar.
 * Quem calcula e registra o hash do PDF final é o banco, sobre os bytes guardados.
 * Pode ser repetido sem risco: se já concluiu, devolve o hash que já existe.
 */
export async function finalizarEnvelope(rpc: ChamarRpc, envelopeId: string): Promise<ResultadoFinalizacao> {
  const d = DadosFinais.parse(await rpc("assinatura_dados_finais", { p_envelope: envelopeId }));
  if (!d.ok) {
    // Já concluído? O banco responde com o hash existente (concluir é idempotente).
    const c = Conclusao.parse(await rpc("assinatura_concluir", { p_envelope: envelopeId, p_pdf_final: null }));
    return c.ok ? { ok: true, hashFinal: c.hash_final } : { ok: false, motivo: c.motivo };
  }
  const final = await montarPdfFinal(bytesDeBytea(d.original), {
    titulo: d.titulo,
    nomeArquivo: d.nome_arquivo,
    escritorio: d.escritorio_nome,
    envelopeId,
    hashOriginal: d.hash_original,
    criadoEm: d.criado_em,
    signatarios: d.signatarios.map((s) => ({ ordem: s.ordem, nome: s.nome, email: s.email, cpf: s.cpf, assinadoEm: s.assinado_em, ip: s.ip, userAgent: s.user_agent })),
  });
  const c = Conclusao.parse(await rpc("assinatura_concluir", { p_envelope: envelopeId, p_pdf_final: byteaDeBytes(final) }));
  return c.ok ? { ok: true, hashFinal: c.hash_final } : { ok: false, motivo: c.motivo };
}
