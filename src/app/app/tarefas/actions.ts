"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { agendarSincronizacao } from "@/lib/agenda/ambiente";
import { exigirDono, exigirModulo } from "@/lib/contexto";
import { caminhoSeguro, codigoDeErro } from "@/lib/erros";
import { lerEtiquetas, type ItemChecklist } from "@/lib/tarefas/ordem";

const uuid = z.uuid();
const QUADRO = "/app/tarefas";
const opcional = (s: z.ZodType<string>) => z.union([s, z.literal("")]).transform((v) => v || null);

function voltar(destino: string, aviso: string): never {
  revalidatePath("/app/tarefas", "layout");
  revalidatePath("/app/agenda", "layout");
  const seguro = caminhoSeguro(destino, QUADRO).replace(/([?&])aviso=[^&]*&?/g, "$1").replace(/[?&]$/, "");
  redirect(`${seguro}${seguro.includes("?") ? "&" : "?"}aviso=${encodeURIComponent(aviso)}`);
}

const esquemaTarefa = z.object({
  titulo: z.string().trim().min(1, "Dê um título.").max(160),
  descricao: z.string().max(4000).default(""),
  responsavel: opcional(uuid),
  data: opcional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  processo: opcional(uuid),
  cliente: opcional(uuid),
  etiquetas: z.string().max(600).default(""),
});

/** Cria o cartão. Com data, ele já nasce na Agenda (e no Google, se o responsável conectou). */
export async function criarTarefa(dados: FormData) {
  const bruto = Object.fromEntries(dados.entries());
  const r = esquemaTarefa.safeParse(bruto);
  const coluna = uuid.or(z.literal("")).safeParse(bruto.coluna ?? "");
  if (!r.success || !coluna.success) voltar(QUADRO, "erro_dados_invalidos");
  const { supabase, vinculo } = await exigirModulo("tarefas");
  const t = r.data;
  const { error } = await supabase.rpc("tarefa_criar", {
    p_escritorio: vinculo.escritorioId, p_coluna: coluna.data || null, p_titulo: t.titulo, p_descricao: t.descricao,
    p_responsavel: t.responsavel, p_data: t.data, p_processo: t.processo, p_cliente: t.cliente, p_etiquetas: lerEtiquetas(t.etiquetas),
  });
  if (!error) agendarSincronizacao();
  voltar(QUADRO, error ? `erro_${codigoDeErro(error)}` : "tarefa_criada");
}

export async function salvarTarefa(id: string, dados: FormData) {
  const destino = `${QUADRO}/${id}`;
  if (!uuid.safeParse(id).success) voltar(QUADRO, "erro_tarefa_invalida");
  const r = esquemaTarefa.safeParse(Object.fromEntries(dados.entries()));
  if (!r.success) voltar(destino, "erro_dados_invalidos");
  const { supabase } = await exigirModulo("tarefas");
  const t = r.data;
  const { error } = await supabase.rpc("tarefa_atualizar", {
    p_tarefa: id,
    p_dados: {
      titulo: t.titulo, descricao: t.descricao, responsavel_id: t.responsavel, data: t.data,
      processo_id: t.processo, cliente_id: t.cliente, etiquetas: lerEtiquetas(t.etiquetas),
    },
  });
  if (!error) agendarSincronizacao();
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "tarefa_salva");
}

/** Chamado pelo arrastar-e-soltar e pelos botões de mover. Devolve o resultado (sem redirecionar) para a tela reagir. */
export async function moverTarefa(id: string, colunaId: string, indice: number): Promise<{ ok: boolean; erro?: string }> {
  if (!uuid.safeParse(id).success || !uuid.safeParse(colunaId).success || !Number.isInteger(indice)) {
    return { ok: false, erro: "dados_invalidos" };
  }
  const { supabase } = await exigirModulo("tarefas");
  const { error } = await supabase.rpc("mover_tarefa", { p_tarefa: id, p_coluna: colunaId, p_indice: indice });
  if (error) return { ok: false, erro: codigoDeErro(error) };
  agendarSincronizacao(); // mover para "Feito" muda o evento no Google (✔)
  revalidatePath("/app/tarefas", "layout");
  revalidatePath("/app/agenda", "layout");
  return { ok: true };
}

/** Mesma ação, vinda do formulário da página do cartão. */
export async function moverTarefaForm(id: string, dados: FormData) {
  const coluna = String(dados.get("coluna") ?? "");
  const r = await moverTarefa(id, coluna, 0);
  voltar(`${QUADRO}/${id}`, r.ok ? "tarefa_salva" : `erro_${r.erro}`);
}

export async function apagarTarefa(id: string) {
  if (!uuid.safeParse(id).success) voltar(QUADRO, "erro_tarefa_invalida");
  const { supabase } = await exigirModulo("tarefas");
  const { error } = await supabase.rpc("apagar_tarefa", { p_tarefa: id });
  if (!error) agendarSincronizacao();
  voltar(error ? `${QUADRO}/${id}` : QUADRO, error ? `erro_${codigoDeErro(error)}` : "tarefa_apagada");
}

export async function comentarTarefa(id: string, dados: FormData) {
  const destino = `${QUADRO}/${id}`;
  const r = z.string().trim().min(1).max(2000).safeParse(dados.get("texto"));
  if (!uuid.safeParse(id).success || !r.success) voltar(destino, "erro_dados_invalidos");
  const { supabase } = await exigirModulo("tarefas");
  const { error } = await supabase.rpc("comentar_tarefa", { p_tarefa: id, p_texto: r.data });
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "comentario_ok");
}

// ---- Checklist: lê, muda e grava a lista inteira (o banco valida tamanho e formato)

async function mudarChecklist(id: string, mudar: (lista: ItemChecklist[]) => ItemChecklist[]) {
  const destino = `${QUADRO}/${id}`;
  if (!uuid.safeParse(id).success) voltar(QUADRO, "erro_tarefa_invalida");
  const { supabase } = await exigirModulo("tarefas");
  const { data } = await supabase.from("tarefa").select("checklist").eq("id", id).maybeSingle();
  if (!data) voltar(QUADRO, "erro_tarefa_invalida");
  const nova = mudar((data.checklist ?? []) as ItemChecklist[]);
  const { error } = await supabase.rpc("tarefa_atualizar", { p_tarefa: id, p_dados: { checklist: nova } });
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "tarefa_salva");
}

export async function adicionarItemChecklist(id: string, dados: FormData) {
  const texto = String(dados.get("texto") ?? "").trim().slice(0, 200);
  if (!texto) voltar(`${QUADRO}/${id}`, "erro_dados_invalidos");
  return mudarChecklist(id, (l) => [...l, { id: randomUUID(), texto, feito: false }]);
}
export async function alternarItemChecklist(id: string, item: string) {
  return mudarChecklist(id, (l) => l.map((i) => (i.id === item ? { ...i, feito: !i.feito } : i)));
}
export async function removerItemChecklist(id: string, item: string) {
  return mudarChecklist(id, (l) => l.filter((i) => i.id !== item));
}

// ---- Colunas (só o dono)

const COLUNAS = `${QUADRO}/colunas`;

export async function criarColuna(dados: FormData) {
  const r = z.string().trim().min(1).max(40).safeParse(dados.get("nome"));
  if (!r.success) voltar(COLUNAS, "erro_dados_invalidos");
  const { supabase, vinculo } = await exigirDono();
  const { error } = await supabase.rpc("coluna_criar", { p_escritorio: vinculo.escritorioId, p_nome: r.data });
  voltar(COLUNAS, error ? `erro_${codigoDeErro(error)}` : "colunas_salvas");
}
export async function renomearColuna(id: string, dados: FormData) {
  const r = z.string().trim().min(1).max(40).safeParse(dados.get("nome"));
  if (!uuid.safeParse(id).success || !r.success) voltar(COLUNAS, "erro_dados_invalidos");
  const { supabase } = await exigirDono();
  const { error } = await supabase.rpc("coluna_renomear", { p_coluna: id, p_nome: r.data });
  voltar(COLUNAS, error ? `erro_${codigoDeErro(error)}` : "colunas_salvas");
}
export async function moverColuna(id: string, direcao: -1 | 1) {
  if (!uuid.safeParse(id).success) voltar(COLUNAS, "erro_dados_invalidos");
  const { supabase } = await exigirDono();
  const { error } = await supabase.rpc("coluna_mover", { p_coluna: id, p_direcao: direcao });
  voltar(COLUNAS, error ? `erro_${codigoDeErro(error)}` : "colunas_salvas");
}
export async function removerColuna(id: string) {
  if (!uuid.safeParse(id).success) voltar(COLUNAS, "erro_dados_invalidos");
  const { supabase } = await exigirDono();
  const { error } = await supabase.rpc("coluna_remover", { p_coluna: id });
  voltar(COLUNAS, error ? `erro_${codigoDeErro(error)}` : "colunas_salvas");
}
