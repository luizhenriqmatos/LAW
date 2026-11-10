import type { ServicoIa } from "@/lib/integrations/ia";
import type { Movimento } from "./linguagem";
import { fecharResumo, impressaoDasMovimentacoes, pedidoDeResumo, verificarResumo } from "./resumo";

export type ResultadoGeracao =
  | { ok: true; texto: string; alertas: string[]; baseHash: string; modelo: string }
  | { ok: false; codigo: "ia_nao_configurada" | "sem_movimentacoes" | "ia_falhou" };

/**
 * Pede o resumo à IA e confere o que voltou. NÃO grava nada: quem grava é o banco (portal_resumo_salvar*),
 * que decide entre rascunho e publicação direta. Chamar só com movimentações de processo FORA de segredo:
 * o banco (portal_movimentos_para_resumo / portal_resumos_pendentes) já entrega lista vazia ou erro nesse caso.
 */
export async function gerarResumo(ia: ServicoIa | null, entrada: { classe: string | null; movimentos: Movimento[] }): Promise<ResultadoGeracao> {
  if (!ia) return { ok: false, codigo: "ia_nao_configurada" };
  if (entrada.movimentos.length === 0) return { ok: false, codigo: "sem_movimentacoes" };
  const r = await ia.gerarTexto({ ...pedidoDeResumo(entrada.classe, entrada.movimentos), maxTokens: 500 });
  if (!r.ok) {
    console.error("Resumo do portal: IA falhou:", r.motivo);
    return { ok: false, codigo: "ia_falhou" };
  }
  const texto = fecharResumo(r.texto);
  return {
    ok: true,
    texto,
    alertas: verificarResumo(texto, entrada.movimentos),
    baseHash: impressaoDasMovimentacoes(entrada.movimentos),
    modelo: ia.modelo,
  };
}
