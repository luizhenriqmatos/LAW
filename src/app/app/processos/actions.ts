"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { EstadoFormulario } from "@/components/formulario";
import { agendarSincronizacaoDrive } from "@/lib/drive/ambiente";
import { exigirModulo } from "@/lib/contexto";
import { caminhoSeguro, codigoDeErro, mensagemDeErro } from "@/lib/erros";
import { esquemaCliente, esquemaProcesso } from "@/lib/validacao";

/**
 * Ações da triagem. Toda gravação passa por função do banco que confere a permissão "processos"
 * (camada 3); aqui conferimos de novo a rota (camada 2) e validamos a entrada.
 */

const TRIAGEM = "/app/processos/triagem";
const id = z.uuid();

async function rpc(funcao: string, args: Record<string, unknown>) {
  const { supabase } = await exigirModulo("processos");
  return supabase.rpc(funcao, args);
}

/** Volta para a tela com um aviso (código conhecido; nunca texto livre na URL). */
function voltar(destino: string, aviso: string): never {
  revalidatePath("/app/processos", "layout");
  // O destino vem do formulário: só aceita telas do próprio módulo.
  const seguro = caminhoSeguro(destino, TRIAGEM);
  const alvo = seguro.startsWith("/app/processos") ? seguro.replace(/[?&]aviso=[^&]*/g, "") : TRIAGEM;
  redirect(`${alvo}${alvo.includes("?") ? "&" : "?"}aviso=${encodeURIComponent(aviso)}`);
}

async function executar(destino: string, funcao: string, args: Record<string, unknown>, avisoOk: string): Promise<never> {
  const { error } = await rpc(funcao, args);
  if (error) voltar(destino, `erro_${codigoDeErro(error)}`);
  agendarSincronizacaoDrive(); // pastas do Drive (confirmar/mesclar/descartar mexem nelas); depois da resposta, sem travar
  voltar(destino, avisoOk);
}

function idsMarcados(dados: FormData): string[] {
  return dados.getAll("ids").map(String).filter((v) => id.safeParse(v).success).slice(0, 200);
}

function exigirId(valor: string, destino: string): string {
  if (!id.safeParse(valor).success) voltar(destino, "erro_nao_encontrado");
  return valor;
}

// ---------------------------------------------------------------- Processos

export async function confirmarProcessosEmLote(dados: FormData) {
  const ids = idsMarcados(dados);
  const destino = `${TRIAGEM}?aba=processos`;
  if (!ids.length) voltar(destino, "erro_nada_selecionado");
  await executar(destino, "confirmar_processos", { p_ids: ids }, "processos_confirmados");
}

export async function confirmarProcesso(processoId: string, _: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  if (!id.safeParse(processoId).success) return { erro: mensagemDeErro("nao_encontrado") };
  const r = esquemaProcesso.safeParse({
    titulo: String(dados.get("titulo") ?? ""),
    area: String(dados.get("area") ?? ""),
    classe: String(dados.get("classe") ?? ""),
    orgao_julgador: String(dados.get("orgao_julgador") ?? ""),
    segredo_justica: dados.get("segredo_justica") === "on",
  });
  if (!r.success) return { erro: r.error.issues[0].message };
  const { error } = await rpc("confirmar_processo", { p_processo: processoId, p_dados: r.data });
  if (error) return { erro: mensagemDeErro(error) };
  agendarSincronizacaoDrive();
  voltar(`/app/processos/${processoId}`, "processo_confirmado");
}

export async function descartarProcesso(processoId: string, destino: string) {
  await executar(destino, "descartar_processo", { p_processo: exigirId(processoId, destino) }, "processo_descartado_ok");
}

export async function restaurarProcesso(processoId: string, destino: string) {
  await executar(destino, "restaurar_processo", { p_processo: exigirId(processoId, destino) }, "restaurado");
}

// ---------------------------------------------------------------- Clientes

export async function confirmarClientesEmLote(dados: FormData) {
  const ids = idsMarcados(dados);
  const destino = `${TRIAGEM}?aba=clientes`;
  if (!ids.length) voltar(destino, "erro_nada_selecionado");
  await executar(destino, "confirmar_clientes", { p_ids: ids }, "clientes_confirmados");
}

export async function confirmarCliente(clienteId: string, _: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  if (!id.safeParse(clienteId).success) return { erro: mensagemDeErro("nao_encontrado") };
  const r = esquemaCliente.safeParse({
    nome: String(dados.get("nome") ?? ""),
    documento: String(dados.get("documento") ?? ""),
    email: String(dados.get("email") ?? ""),
    telefone: String(dados.get("telefone") ?? ""),
  });
  if (!r.success) return { erro: r.error.issues[0].message };
  const { error } = await rpc("confirmar_cliente", { p_cliente: clienteId, p_dados: r.data });
  if (error) return { erro: mensagemDeErro(error) };
  agendarSincronizacaoDrive();
  voltar(`${TRIAGEM}?aba=clientes`, "cliente_confirmado");
}

export async function mesclarCliente(clienteId: string, destinoId: string, destino: string) {
  await executar(destino, "mesclar_cliente", { p_cliente: exigirId(clienteId, destino), p_destino: exigirId(destinoId, destino) }, "cliente_mesclado");
}

/** Renomeia cliente confirmado. A pasta dele (e só ela) no Drive é renomeada em seguida, sem apagar nada. */
export async function renomearCliente(clienteId: string, destino: string, dados: FormData) {
  const nome = z.string().trim().min(2).max(200).safeParse(String(dados.get("nome") ?? ""));
  if (!nome.success) voltar(destino, "erro_nome_invalido");
  await executar(destino, "cliente_renomear", { p_cliente: exigirId(clienteId, destino), p_nome: nome.data }, "cliente_renomeado");
}

export async function descartarCliente(clienteId: string, destino: string) {
  await executar(destino, "descartar_cliente", { p_cliente: exigirId(clienteId, destino) }, "descartado");
}

export async function restaurarCliente(clienteId: string, destino: string) {
  await executar(destino, "restaurar_cliente", { p_cliente: exigirId(clienteId, destino) }, "restaurado");
}

// ---------------------------------------------------------------- Publicações sem processo

export async function vincularPublicacao(publicacaoId: string, processoId: string) {
  const destino = `${TRIAGEM}?aba=publicacoes`;
  await executar(destino, "vincular_publicacao", { p_publicacao: exigirId(publicacaoId, destino), p_processo: exigirId(processoId, destino) }, "publicacao_ligada");
}

export async function descartarPublicacao(publicacaoId: string) {
  const destino = `${TRIAGEM}?aba=publicacoes`;
  await executar(destino, "descartar_publicacao", { p_publicacao: exigirId(publicacaoId, destino) }, "descartado");
}

export async function restaurarPublicacao(publicacaoId: string) {
  const destino = `${TRIAGEM}?aba=publicacoes`;
  await executar(destino, "restaurar_publicacao", { p_publicacao: exigirId(publicacaoId, destino) }, "restaurado");
}
