"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { exigirModulo } from "@/lib/contexto";
import { caminhoSeguro, codigoDeErro, mensagemDeErro } from "@/lib/erros";
import { responder, type MensagemHistorico } from "@/lib/assistente/motor";
import { dadosParaConfirmar } from "@/lib/assistente/rascunhos";
import { montarCtx } from "@/lib/assistente/servidor";
import { ErroAssistente, type TipoRascunho } from "@/lib/assistente/tipos";
import { servicoIaAssistente } from "@/lib/integrations/ia";

const BASE = "/app/assistente";
const uuid = z.uuid();

function voltar(destino: string, aviso: string): never {
  revalidatePath(BASE, "layout");
  const seguro = caminhoSeguro(destino, BASE);
  const alvo = (seguro.startsWith(BASE) ? seguro : BASE).replace(/([?&])aviso=[^&]*&?/g, "$1").replace(/[?&]$/, "");
  redirect(`${alvo}${alvo.includes("?") ? "&" : "?"}aviso=${encodeURIComponent(aviso)}`);
}

export type EstadoPergunta = { erro?: string } | undefined;

const esquemaPergunta = z.object({
  texto: z.string().trim().min(1, mensagemDeErro("pergunta_invalida")).max(4000, mensagemDeErro("pergunta_invalida")),
  conversa: z.union([uuid, z.literal("")]).optional().transform((v) => v || null),
});

/**
 * Pergunta à Lia. Grava a pergunta, roda o laço de ferramentas COM O LOGIN DO USUÁRIO e grava a resposta.
 * As ferramentas de escrita só criam rascunhos pendentes; nada de lançamento/tarefa/prazo/minuta nasce aqui.
 */
export async function perguntar(_: EstadoPergunta, dados: FormData): Promise<EstadoPergunta> {
  const r = esquemaPergunta.safeParse({ texto: dados.get("texto") ?? "", conversa: dados.get("conversa") ?? "" });
  if (!r.success) return { erro: r.error.issues[0].message };
  const { supabase, vinculo } = await exigirModulo("assistente");
  const ia = servicoIaAssistente();
  if (!ia) return { erro: mensagemDeErro("assistente_nao_configurada") }; // PENDENCIA P-055

  let conversaId = r.data.conversa;
  let historico: MensagemHistorico[] = [];
  if (conversaId) {
    const { data: msgs, error } = await supabase.from("assistente_mensagem").select("papel, texto")
      .eq("conversa_id", conversaId).order("criado_em", { ascending: false }).limit(12);
    if (error) return { erro: mensagemDeErro(error) };
    historico = ((msgs ?? []) as MensagemHistorico[]).reverse();
  } else {
    const { data: id, error } = await supabase.rpc("assistente_conversa_criar", { p_escritorio: vinculo.escritorioId, p_titulo: r.data.texto });
    if (error || !id) return { erro: mensagemDeErro(error) };
    conversaId = String(id);
  }

  const { error: erroPergunta } = await supabase.rpc("assistente_mensagem_registrar", { p_conversa: conversaId, p_papel: "usuario", p_texto: r.data.texto });
  if (erroPergunta) return { erro: mensagemDeErro(erroPergunta) };

  let resposta;
  try {
    const ctx = await montarCtx(supabase, vinculo.escritorioId);
    resposta = await responder({ ia, ctx: { ...ctx, conversaId }, historico, pergunta: r.data.texto });
  } catch (e) {
    const texto = e instanceof ErroAssistente ? mensagemDeErro(e.codigo) : "Não consegui responder agora. Tente de novo em instantes.";
    await supabase.rpc("assistente_mensagem_registrar", { p_conversa: conversaId, p_papel: "assistente", p_texto: texto, p_modelo: ia.modelo });
    redirect(`${BASE}/${conversaId}`);
  }
  const { error: erroResposta } = await supabase.rpc("assistente_mensagem_registrar", {
    p_conversa: conversaId, p_papel: "assistente", p_texto: resposta.texto, p_fontes: resposta.fontes,
    p_ferramentas: resposta.ferramentas, p_sem_permissao: resposta.semPermissao, p_modelo: ia.modelo, p_rascunhos: resposta.rascunhos,
  });
  if (erroResposta) return { erro: mensagemDeErro(erroResposta) };
  revalidatePath(BASE, "layout");
  redirect(`${BASE}/${conversaId}#fim`);
}

/** O ÚNICO caminho de gravação da Lia: o clique em Confirmar no cartão. */
export async function confirmarRascunho(rascunhoId: string, destino: string, dados: FormData) {
  if (!uuid.safeParse(rascunhoId).success) voltar(destino, "erro_nao_encontrado");
  const { supabase, vinculo } = await exigirModulo("assistente");
  const { data: rascunho } = await supabase.from("assistente_rascunho").select("id, tipo, dados, status").eq("id", rascunhoId).maybeSingle();
  if (!rascunho) voltar(destino, "erro_nao_encontrado");
  if (rascunho.status !== "pendente") voltar(destino, "erro_rascunho_encerrado");

  const form: Record<string, string> = {};
  for (const [k, v] of dados.entries()) if (typeof v === "string") form[k] = v;
  let final: Record<string, unknown>;
  try {
    const ctx = await montarCtx(supabase, vinculo.escritorioId);
    const original = { ...(rascunho.dados as Record<string, unknown>) };
    delete original._exibir; // só para a tela
    final = await dadosParaConfirmar(rascunho.tipo as TipoRascunho, original, form, ctx);
  } catch (e) {
    if (e instanceof ErroAssistente) voltar(destino, `erro_${e.codigo}`);
    throw e;
  }
  const { data: resultado, error } = await supabase.rpc("assistente_rascunho_confirmar", { p_rascunho: rascunhoId, p_dados: final });
  if (error) voltar(destino, `erro_${codigoDeErro(error)}`);
  revalidatePath("/app", "layout");
  const link = (resultado as { link?: string } | null)?.link;
  voltar(destino, link ? `confirmado:${link}` : "confirmado");
}

export async function descartarRascunho(rascunhoId: string, destino: string) {
  if (!uuid.safeParse(rascunhoId).success) voltar(destino, "erro_nao_encontrado");
  const { supabase } = await exigirModulo("assistente");
  const { error } = await supabase.rpc("assistente_rascunho_descartar", { p_rascunho: rascunhoId });
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "descartado");
}

// ---- Modelos de contrato e minutas (quem tem Documentos)

const esquemaModelo = z.object({
  id: z.union([uuid, z.literal("")]).transform((v) => v || null),
  nome: z.string().trim().min(2).max(120),
  descricao: z.string().trim().max(500).default(""),
  texto: z.string().min(20).max(50000),
});

export async function salvarModelo(dados: FormData) {
  const destino = `${BASE}/modelos`;
  const r = esquemaModelo.safeParse(Object.fromEntries(dados.entries()));
  if (!r.success) voltar(destino, r.error.issues[0].path[0] === "texto" ? "erro_texto_modelo_invalido" : "erro_nome_modelo_invalido");
  const { supabase, vinculo, modulos } = await exigirModulo("assistente");
  if (!modulos.includes("documentos")) redirect("/app/sem-acesso?modulo=documentos");
  const { error } = await supabase.rpc("modelo_contrato_salvar", {
    p_escritorio: vinculo.escritorioId, p_id: r.data.id, p_nome: r.data.nome, p_descricao: r.data.descricao, p_texto: r.data.texto,
  });
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "modelo_salvo");
}

export async function ativarModelo(id: string, ativo: boolean) {
  const destino = `${BASE}/modelos`;
  if (!uuid.safeParse(id).success) voltar(destino, "erro_nao_encontrado");
  const { supabase } = await exigirModulo("assistente");
  const { error } = await supabase.rpc("modelo_contrato_ativar", { p_id: id, p_ativo: ativo });
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : ativo ? "modelo_ativado" : "modelo_desativado");
}

export async function marcarMinutaRevisada(id: string) {
  const destino = `${BASE}/minutas/${id}`;
  if (!uuid.safeParse(id).success) voltar(BASE, "erro_nao_encontrado");
  const { supabase } = await exigirModulo("assistente");
  const { error } = await supabase.rpc("minuta_marcar_revisada", { p_id: id });
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "minuta_revisada");
}
