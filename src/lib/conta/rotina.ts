import type { ChamarRpc } from "@/lib/captura/job";
import type { ServicoEmail } from "@/lib/integrations/email";
import { montarAviso, type Pendencia } from "./avisos";

export type ResultadoRotina = { excluidas: string[]; avisos: { escritorio: string; tipo: string; enviado: boolean }[]; falhas: string[] };

/**
 * Rotina diária do encerramento. `agora` vem de fora (relógio simulado nos testes).
 * 1) apaga as contas cujo prazo de 30 dias venceu; 2) envia os avisos que faltam (pedido, 7 dias, exclusão).
 * Aviso só é marcado como enviado se o e-mail saiu; senão tenta de novo no dia seguinte.
 * Uma conta com problema não impede as outras.
 */
export async function rodarRotinaEncerramento(rpc: ChamarRpc, email: ServicoEmail, agora: Date, apenasEscritorio?: string): Promise<ResultadoRotina> {
  const r: ResultadoRotina = { excluidas: [], avisos: [], falhas: [] };
  const quando = agora.toISOString();

  // Com `apenasEscritorio` (aviso imediato logo após o pedido) não exclui nada e só olha aquela conta.
  for (const id of apenasEscritorio ? [] : await rpc<string[]>("conta_vencidas", { p_agora: quando })) {
    try {
      await rpc("conta_excluir", { p_escritorio: id, p_agora: quando });
      r.excluidas.push(id);
    } catch (e) {
      r.falhas.push(`excluir ${id}: ${e instanceof Error ? e.message : "erro"}`);
    }
  }

  const pendencias = (await rpc<Pendencia[]>("conta_pendencias", { p_agora: quando })).filter((p) => !apenasEscritorio || p.escritorio_id === apenasEscritorio);
  for (const p of pendencias) {
    try {
      const { assunto, texto } = montarAviso(p);
      let enviado = p.destinatarios.length > 0;
      for (const para of p.destinatarios) {
        const x = await email.enviarAviso({ para, assunto, texto });
        if (!x.enviado) enviado = false;
      }
      if (enviado) await rpc("conta_marcar_aviso", { p_escritorio: p.escritorio_id, p_tipo: p.tipo, p_agora: quando });
      r.avisos.push({ escritorio: p.escritorio_id, tipo: p.tipo, enviado });
    } catch (e) {
      r.falhas.push(`aviso ${p.tipo} ${p.escritorio_id}: ${e instanceof Error ? e.message : "erro"}`);
    }
  }
  return r;
}
