"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { EstadoFormulario } from "@/components/formulario";
import { exigirDono, exigirModulo } from "@/lib/contexto";
import { listarArquivos } from "@/lib/drive/arquivos";
import { depsDriveDoAmbiente, driveConfigurado } from "@/lib/drive/ambiente";
import { codigoDeErro, mensagemDeErro } from "@/lib/erros";
import { servicoEmail } from "@/lib/integrations/email";
import { servicoIa } from "@/lib/integrations/ia";
import { gerarResumo } from "@/lib/portal/gerar";
import type { Movimento } from "@/lib/portal/linguagem";
import { fecharResumo, verificarResumo } from "@/lib/portal/resumo";
import { hashDoToken, ipDaRequisicao, novoToken, VALIDADE_LINK_MINUTOS } from "@/lib/portal/token";
import { servicoConfigurado } from "@/lib/supabase/servico";

const uuid = z.uuid();
const RAIZ = "/app/portal-cliente";

async function origem() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

function voltar(processoId: string | null, aviso: string): never {
  revalidatePath(RAIZ, "layout");
  const base = processoId ? `${RAIZ}/processos/${processoId}` : RAIZ;
  redirect(`${base}?aviso=${encodeURIComponent(aviso)}`);
}

const marcado = (d: FormData, nome: string) => d.get(nome) === "on";

async function chamar(processoId: string | null, funcao: string, args: Record<string, unknown>, ok: string): Promise<never> {
  const { supabase } = await exigirModulo("portal_cliente");
  const { error } = await supabase.rpc(funcao, args);
  if (error) voltar(processoId, `erro_${codigoDeErro(error)}`);
  voltar(processoId, ok);
}

export async function liberarCliente(processoId: string, clienteId: string, dados: FormData) {
  if (!uuid.safeParse(processoId).success || !uuid.safeParse(clienteId).success) voltar(null, "erro_dados_invalidos");
  const situacao = String(dados.get("situacao") ?? "").slice(0, 280);
  const titulo = String(dados.get("titulo") ?? "").slice(0, 120);
  await chamar(processoId, "portal_liberar", {
    p_processo: processoId, p_cliente: clienteId,
    p_movimentacoes: marcado(dados, "movimentacoes"), p_resumo: marcado(dados, "resumo"),
    p_compromissos: marcado(dados, "compromissos"), p_documentos: marcado(dados, "documentos"),
    p_situacao: situacao, p_titulo: titulo,
  }, "portal_liberado");
}

export async function revogarLiberacao(processoId: string, liberacaoId: string) {
  if (!uuid.safeParse(liberacaoId).success) voltar(processoId, "erro_dados_invalidos");
  await chamar(processoId, "portal_revogar", { p_liberacao: liberacaoId }, "portal_revogado");
}

export async function visibilidadeCompromisso(processoId: string, compromissoId: string, visivel: boolean) {
  if (!uuid.safeParse(compromissoId).success) voltar(processoId, "erro_dados_invalidos");
  await chamar(processoId, "portal_compromisso_visivel", { p_compromisso: compromissoId, p_visivel: visivel }, "portal_compromisso");
}

export async function configurarModo(dados: FormData) {
  const { supabase, vinculo } = await exigirDono();
  const modo = String(dados.get("modo"));
  const { error } = await supabase.rpc("portal_configurar", { p_escritorio: vinculo.escritorioId, p_modo: modo });
  voltar(null, error ? `erro_${codigoDeErro(error)}` : "portal_configurado");
}

/** Gera o resumo com a IA. O banco decide se vira rascunho ou se publica direto (modo do escritório, sem alerta). */
export async function gerarResumoIa(processoId: string) {
  if (!uuid.safeParse(processoId).success) voltar(null, "erro_dados_invalidos");
  const { supabase } = await exigirModulo("portal_cliente");
  // Processo em segredo de justiça: o banco recusa aqui e a IA nem é chamada.
  const { data, error } = await supabase.rpc("portal_movimentos_para_resumo", { p_processo: processoId });
  if (error) voltar(processoId, `erro_${codigoDeErro(error)}`);
  const base = data as { classe: string | null; movimentos: Movimento[] };
  const r = await gerarResumo(servicoIa(), { classe: base.classe, movimentos: base.movimentos });
  if (!r.ok) voltar(processoId, `erro_${r.codigo}`);
  const { data: gravado, error: erroGravar } = await supabase.rpc("portal_resumo_salvar", {
    p_processo: processoId, p_texto: r.texto, p_origem: "ia", p_modelo: r.modelo, p_base_hash: r.baseHash, p_alertas: r.alertas,
  });
  if (erroGravar) voltar(processoId, `erro_${codigoDeErro(erroGravar)}`);
  voltar(processoId, (gravado as { status: string }).status === "publicado" ? "portal_resumo_publicado" : "portal_resumo_rascunho");
}

/** Resumo escrito (ou reescrito) pelo advogado: sempre nasce como rascunho. */
export async function salvarResumoManual(processoId: string, dados: FormData) {
  const texto = String(dados.get("texto") ?? "").trim();
  if (texto.length < 10) voltar(processoId, "erro_resumo_invalido");
  await chamar(processoId, "portal_resumo_salvar", {
    p_processo: processoId, p_texto: fecharResumo(texto), p_origem: "advogado", p_modelo: null, p_base_hash: null,
    p_alertas: verificarResumo(texto, []).filter((a) => !a.includes("não aparece nas movimentações")),
  }, "portal_resumo_rascunho");
}

export async function editarResumo(processoId: string, resumoId: string, dados: FormData) {
  if (!uuid.safeParse(resumoId).success) voltar(processoId, "erro_dados_invalidos");
  const texto = String(dados.get("texto") ?? "").trim();
  if (texto.length < 10) voltar(processoId, "erro_resumo_invalido");
  await chamar(processoId, "portal_resumo_editar", { p_resumo: resumoId, p_texto: fecharResumo(texto) }, "portal_resumo_editado");
}

export async function publicarResumo(processoId: string, resumoId: string) {
  if (!uuid.safeParse(resumoId).success) voltar(processoId, "erro_dados_invalidos");
  await chamar(processoId, "portal_resumo_publicar", { p_resumo: resumoId }, "portal_resumo_publicado");
}

export async function encerrarResumo(processoId: string, resumoId: string) {
  if (!uuid.safeParse(resumoId).success) voltar(processoId, "erro_dados_invalidos");
  await chamar(processoId, "portal_resumo_encerrar", { p_resumo: resumoId }, "portal_resumo_encerrado");
}

/** Só compartilha arquivo que está de fato na pasta do processo no Drive do escritório (e não pasta). */
export async function compartilharDocumento(processoId: string, dados: FormData) {
  const arquivoId = String(dados.get("arquivo") ?? "");
  if (!uuid.safeParse(processoId).success || arquivoId.length < 5 || arquivoId.length > 200) voltar(processoId, "erro_dados_invalidos");
  const { supabase } = await exigirModulo("portal_cliente");
  if (!driveConfigurado()) voltar(processoId, "erro_drive_nao_configurado");
  const { data: pasta, error } = await supabase.rpc("portal_pasta_processo", { p_processo: processoId });
  if (error) voltar(processoId, `erro_${codigoDeErro(error)}`);
  const p = pasta as { escritorio_id: string; drive_id: string } | null;
  if (!p) voltar(processoId, "erro_drive_sem_pasta");
  const lista = await listarArquivos(depsDriveDoAmbiente(), p.escritorio_id, p.drive_id);
  if (!lista.ok) voltar(processoId, `erro_${lista.codigo}`);
  const arquivo = lista.dados.find((a) => a.id === arquivoId && !a.pasta);
  if (!arquivo) voltar(processoId, "erro_documento_portal_invalido");
  await chamar(processoId, "portal_documento_compartilhar", {
    p_processo: processoId, p_arquivo: arquivo.id, p_nome: arquivo.nome, p_mime: null, p_tamanho: arquivo.tamanho,
  }, "portal_documento");
}

export async function revogarDocumento(processoId: string, documentoId: string) {
  if (!uuid.safeParse(documentoId).success) voltar(processoId, "erro_dados_invalidos");
  await chamar(processoId, "portal_documento_revogar", { p_documento: documentoId }, "portal_documento_revogado");
}

/**
 * "Enviar acesso" para UM cliente, por clique do advogado (nunca em lote). Se o e-mail do LAW ainda não está configurado
 * (PENDENCIA P-016), a tela mostra o link para o advogado repassar, igual ao convite da equipe.
 */
export async function enviarAcesso(clienteId: string, ...formulario: [EstadoFormulario, FormData]): Promise<EstadoFormulario> {
  void formulario; // assinatura de useActionState; o clique não leva dados
  if (!uuid.safeParse(clienteId).success) return { erro: mensagemDeErro("dados_invalidos") };
  const { supabase } = await exigirModulo("portal_cliente");
  if (!servicoConfigurado()) return { erro: "O portal ainda não está disponível neste LAW (falta a chave de serviço do Supabase)." };
  const token = novoToken();
  const { data, error } = await supabase.rpc("portal_link_advogado", {
    p_cliente: clienteId, p_token_hash: hashDoToken(token), p_ip: ipDaRequisicao(await headers()),
  });
  if (error) return { erro: mensagemDeErro(error) };
  const r = data as { email: string; escritorio: string };
  const link = `${await origem()}/portal/acesso/${token}`;
  const envio = await servicoEmail().enviarLinkPortal({ para: r.email, escritorios: [r.escritorio], link, validadeMinutos: VALIDADE_LINK_MINUTOS });
  if (envio.enviado) return { ok: `Link enviado para ${r.email}. Ele vale por ${VALIDADE_LINK_MINUTOS} minutos e só pode ser usado uma vez.` };
  return { ok: `O e-mail NÃO foi enviado (${envio.motivo}). Copie o link e passe ao cliente por um canal seguro. Ele vale ${VALIDADE_LINK_MINUTOS} minutos e só pode ser usado uma vez.`, link };
}
