"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { exigirEscritorio, exigirModulo } from "@/lib/contexto";
import { caminhoSeguro, codigoDeErro } from "@/lib/erros";
import { calcularPrazo, entradasDoTribunal, ErroContagem } from "@/lib/prazos/contagem";
import { carregarCalendario } from "@/lib/prazos/servidor";

const uuid = z.uuid();
const LISTA = "/app/prazos";

function voltar(destino: string, aviso: string): never {
  revalidatePath("/app/prazos", "layout");
  revalidatePath("/app/processos", "layout");
  const seguro = caminhoSeguro(destino, LISTA);
  const alvo = seguro.startsWith("/app/") ? seguro.replace(/[?&]aviso=[^&]*/g, "") : LISTA;
  redirect(`${alvo}${alvo.includes("?") ? "&" : "?"}aviso=${encodeURIComponent(aviso)}`);
}

const esquema = z.object({
  processo: uuid,
  publicacao: uuid.optional(),
  descricao: z.string().trim().min(3, "Descreva o prazo.").max(200),
  dias: z.coerce.number().int().min(1).max(365),
  tipo: z.enum(["util", "corrido"]),
  responsavel: uuid,
  disp: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  esperada: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Confirmação do prazo. A data NÃO vem do navegador: é recalculada aqui pelo módulo de contagem.
 * `esperada` é a data que o usuário viu e conferiu; se o cálculo agora der outra, não grava.
 */
export async function confirmarPrazo(dados: FormData) {
  const bruto = Object.fromEntries(dados.entries());
  const voltaPara = caminhoSeguro(String(bruto.voltar ?? ""), LISTA);
  const r = esquema.safeParse({ ...bruto, publicacao: bruto.publicacao || undefined });
  if (!r.success) voltar(voltaPara, "erro_raciocinio_invalido");
  const d = r.data;

  const { supabase, vinculo } = await exigirModulo("prazos");
  const { data: proc } = await supabase.from("processo").select("id, tribunal, status").eq("id", d.processo).eq("escritorio_id", vinculo.escritorioId).maybeSingle();
  if (!proc) voltar(voltaPara, "erro_nao_encontrado");
  if (proc.status !== "confirmado") voltar(voltaPara, "erro_processo_nao_confirmado");

  let disponibilizacao = d.disp;
  if (d.publicacao) {
    const { data: pub } = await supabase.from("publicacao").select("data_disponibilizacao, processo_id").eq("id", d.publicacao).eq("escritorio_id", vinculo.escritorioId).maybeSingle();
    if (!pub || pub.processo_id !== d.processo) voltar(voltaPara, "erro_publicacao_invalida");
    disponibilizacao = pub.data_disponibilizacao; // a data oficial é a da publicação, não a do formulário
  }

  const calendario = entradasDoTribunal(await carregarCalendario(supabase, vinculo.escritorioId), proc.tribunal);
  let resultado;
  try {
    resultado = calcularPrazo({ disponibilizacao, dias: d.dias, tipo: d.tipo, calendario });
  } catch (e) {
    if (e instanceof ErroContagem) voltar(voltaPara, "erro_raciocinio_invalido");
    throw e;
  }
  if (resultado.dataFinal !== d.esperada) voltar(voltaPara, "erro_prazo_mudou");

  const { data: id, error } = await supabase.rpc("criar_prazo", {
    p_processo: d.processo, p_publicacao: d.publicacao ?? null, p_descricao: d.descricao, p_dias: d.dias, p_tipo: d.tipo,
    p_responsavel: d.responsavel, p_disponibilizacao: resultado.disponibilizacao, p_data_publicacao: resultado.publicacao,
    p_inicio: resultado.inicioContagem, p_data_final: resultado.dataFinal,
    p_raciocinio: { passos: resultado.passos, diasPulados: resultado.diasPulados, aviso: resultado.aviso, calculadoEm: "servidor" },
  });
  if (error || !id) voltar(voltaPara, `erro_${codigoDeErro(error)}`);
  voltar(`/app/processos/${d.processo}`, "prazo_criado");
}

export async function alterarStatusPrazo(prazoId: string, status: "aberto" | "cumprido" | "cancelado", destino: string) {
  if (!uuid.safeParse(prazoId).success) voltar(destino, "erro_nao_encontrado");
  const { supabase } = await exigirModulo("prazos");
  const { error } = await supabase.rpc("alterar_status_prazo", { p_prazo: prazoId, p_status: status });
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "prazo_atualizado");
}

export async function alterarResponsavelPrazo(prazoId: string, destino: string, dados: FormData) {
  const resp = String(dados.get("responsavel") ?? "");
  if (!uuid.safeParse(prazoId).success || !uuid.safeParse(resp).success) voltar(destino, "erro_nao_encontrado");
  const { supabase } = await exigirModulo("prazos");
  const { error } = await supabase.rpc("alterar_responsavel_prazo", { p_prazo: prazoId, p_responsavel: resp });
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "prazo_atualizado");
}

export async function dispensarPrazo(publicacaoId: string, destino: string) {
  if (!uuid.safeParse(publicacaoId).success) voltar(destino, "erro_nao_encontrado");
  const { supabase } = await exigirModulo("prazos");
  const { error } = await supabase.rpc("dispensar_prazo_publicacao", { p_publicacao: publicacaoId });
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "sem_prazo");
}

// ---- Calendário forense (só o dono)

const esquemaCalendario = z.object({
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Informe a data."),
  data_fim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).transform((v) => v || null),
  escopo: z.enum(["estadual", "municipal", "tribunal"]),
  tribunal: z.string().trim().toUpperCase().max(10),
  uf: z.string().trim().toUpperCase().max(2),
  tipo: z.enum(["feriado", "suspensao"]),
  descricao: z.string().trim().min(3).max(120),
});

export async function adicionarAoCalendario(dados: FormData) {
  const destino = `${LISTA}/calendario`;
  const r = esquemaCalendario.safeParse(Object.fromEntries(dados.entries()));
  if (!r.success) voltar(destino, "erro_check constraint");
  const { supabase, vinculo } = await exigirEscritorio();
  const c = r.data;
  const { error } = await supabase.rpc("calendario_adicionar", {
    p_escritorio: vinculo.escritorioId, p_data: c.data, p_data_fim: c.data_fim, p_escopo: c.escopo,
    p_tribunal: c.tribunal || null, p_uf: c.uf || null, p_tipo: c.tipo, p_descricao: c.descricao,
  });
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "calendario_salvo");
}

export async function removerDoCalendario(id: string) {
  const destino = `${LISTA}/calendario`;
  if (!uuid.safeParse(id).success) voltar(destino, "erro_nao_encontrado");
  const { supabase } = await exigirEscritorio();
  const { error } = await supabase.rpc("calendario_remover", { p_id: id });
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "calendario_salvo");
}

export async function marcarAvisosLidos() {
  const { supabase } = await exigirEscritorio();
  await supabase.rpc("marcar_notificacoes_lidas", { p_ids: null });
  voltar("/app/avisos", "avisos_lidos");
}
