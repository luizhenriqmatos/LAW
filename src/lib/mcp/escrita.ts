import { z } from "zod";
import type { CtxFerramenta, ResultadoFerramenta } from "@/lib/assistente/ferramentas";
import { formularioDoRascunho } from "@/lib/assistente/formulario";
import { dadosParaConfirmar, PREPARADORES } from "@/lib/assistente/rascunhos";
import { ErroAssistente, lerErroRpc, type TipoRascunho } from "@/lib/assistente/tipos";

/**
 * Escrita pelo conector. A aprovação acontece NO ASSISTENTE (Claude pede confirmação antes de chamar ferramenta
 * marcada como destrutiva). Aqui o caminho é o mesmo da Lia, sem atalho:
 *   prepara (regras em código) -> rascunho (origem 'mcp', no audit_log) -> confirma pelas funções das telas.
 * Se algo falhar no meio, o rascunho é descartado: nada fica pela metade.
 */
export async function executarEscrita(tipo: TipoRascunho, entrada: unknown, ctx: CtxFerramenta): Promise<ResultadoFerramenta> {
  let rascunhoId: string | null = null;
  try {
    const r = await PREPARADORES[tipo](entrada, ctx);
    if (tipo === "lancamento" && r.dados.tipo === "receita" && !r.dados.cliente_id) {
      const nomes = ((r.exibir.candidatos_cliente ?? []) as { nome: string }[]).map((c) => c.nome);
      return { ok: false, codigo: "cliente_ambiguo", semPermissao: [], mensagem: `Mais de um cliente com esse nome: ${nomes.join("; ")}. Pergunte ao usuário qual é e chame de novo com o nome completo. Nada foi gravado.` };
    }
    const criado = await ctx.rpc("assistente_rascunho_criar", {
      p_conversa: ctx.conversaId, p_tipo: tipo, p_dados: { ...r.dados, _exibir: r.exibir }, p_resumo: r.resumo, p_avisos: r.avisos,
    });
    if (criado.error) throw criado.error;
    rascunhoId = String(criado.data);
    const final = await dadosParaConfirmar(tipo, r.dados, formularioDoRascunho(tipo, { ...r.dados, _exibir: r.exibir }), ctx);
    const conf = await ctx.rpc("assistente_rascunho_confirmar", { p_rascunho: rascunhoId, p_dados: final });
    if (conf.error) throw conf.error;
    const res = conf.data as { id: string; link: string };
    return { ok: true, fontes: [], rascunhoId, paraIa: { gravado: true, resumo: r.resumo, avisos: r.avisos, id: res.id, link: res.link } };
  } catch (e) {
    if (rascunhoId) await ctx.rpc("assistente_rascunho_descartar", { p_rascunho: rascunhoId });
    if (e instanceof ErroAssistente) return { ok: false, codigo: e.codigo, mensagem: `${e.message} Nada foi gravado.`, semPermissao: e.semPermissao };
    if (e instanceof z.ZodError) return { ok: false, codigo: "entrada_invalida", mensagem: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), semPermissao: [] };
    if (e && typeof e === "object" && "message" in e) {
      const { codigo, modulos } = lerErroRpc(e as { message: string; details?: string | null });
      return { ok: false, codigo, mensagem: codigo === "sem_permissao" ? "O usuário não tem permissão para isso. Nada foi gravado." : `Não foi possível gravar (${codigo}). Nada foi gravado.`, semPermissao: modulos };
    }
    throw e;
  }
}
