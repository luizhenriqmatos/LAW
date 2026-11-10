"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { EstadoFormulario } from "@/components/formulario";
import { exigirModulo } from "@/lib/contexto";
import { paraCentavos } from "@/lib/dinheiro";
import { caminhoSeguro, codigoDeErro, mensagemDeErro } from "@/lib/erros";
import { MAX_PARCELAS } from "@/lib/financeiro/parcelas";
import { CATEGORIAS, FORMAS, TIPOS } from "@/lib/financeiro/rotulos";

/**
 * Ações do financeiro. Toda gravação passa por função do banco que confere a permissão "financeiro" (camada 3);
 * aqui conferimos a rota (camada 2) e validamos a entrada. Valores sempre em centavos.
 */
const FINANCEIRO = "/app/financeiro";
const uuid = z.uuid();
const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const opcional = <T extends z.ZodType>(s: T) => z.union([s, z.literal("")]).transform((v) => (v === "" ? null : v));

function voltar(destino: string, aviso: string): never {
  revalidatePath("/app/financeiro", "layout");
  revalidatePath("/app/processos", "layout");
  const seguro = caminhoSeguro(destino, FINANCEIRO);
  const alvo = seguro.startsWith(FINANCEIRO) || seguro.startsWith("/app/processos") ? seguro : FINANCEIRO;
  const limpo = alvo.replace(/([?&])aviso=[^&]*&?/g, "$1").replace(/[?&]$/, "");
  redirect(`${limpo}${limpo.includes("?") ? "&" : "?"}aviso=${encodeURIComponent(aviso)}`);
}

const valorEmCentavos = z.string().transform((v, ctx) => {
  const c = paraCentavos(v);
  if (c === null || c <= 0) {
    ctx.addIssue({ code: "custom", message: mensagemDeErro("valor_invalido") });
    return z.NEVER;
  }
  return c;
});

const esquemaLancamento = z.object({
  tipo: z.enum(Object.keys(TIPOS) as [string, ...string[]]),
  categoria: z.enum(Object.keys(CATEGORIAS) as [string, ...string[]]),
  cliente: opcional(uuid),
  processo: opcional(uuid),
  descricao: z.string().trim().min(2, mensagemDeErro("descricao_invalida")).max(200, mensagemDeErro("descricao_invalida")),
  valor: valorEmCentavos,
  parcelas: z.coerce.number().int().min(1, mensagemDeErro("parcelas_invalidas")).max(MAX_PARCELAS, mensagemDeErro("parcelas_invalidas")),
  primeiro_vencimento: dia.refine(Boolean, mensagemDeErro("vencimento_invalido")),
  competencia: z.union([dia, z.literal("")]).transform((v) => v || null),
});

export async function criarLancamento(_: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  const r = esquemaLancamento.safeParse(Object.fromEntries(dados.entries()));
  if (!r.success) return { erro: r.error.issues[0].message };
  const d = r.data;
  if (d.tipo === "receita" && !d.cliente) return { erro: mensagemDeErro("cliente_obrigatorio") };
  const { supabase, vinculo } = await exigirModulo("financeiro");
  const { data, error } = await supabase.rpc("lancamento_criar", {
    p_escritorio: vinculo.escritorioId,
    p_dados: {
      tipo: d.tipo, categoria: d.categoria, cliente_id: d.cliente, processo_id: d.processo, descricao: d.descricao,
      valor_centavos: d.valor, parcelas: d.parcelas, primeiro_vencimento: d.primeiro_vencimento, data_competencia: d.competencia,
    },
  });
  if (error) return { erro: mensagemDeErro(error) };
  voltar(`${FINANCEIRO}/lancamentos/${data as string}`, "lancamento_criado");
}

async function executar(destino: string, funcao: string, args: Record<string, unknown>, avisoOk: string): Promise<never> {
  const { supabase } = await exigirModulo("financeiro");
  const { error } = await supabase.rpc(funcao, args);
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : avisoOk);
}

const esquemaPagamento = z.object({
  valor: valorEmCentavos,
  data: z.union([dia, z.literal("")]).transform((v) => v || null),
  forma: z.union([z.enum(Object.keys(FORMAS) as [string, ...string[]]), z.literal("")]).transform((v) => v || null),
});

export async function registrarPagamento(parcelaId: string, destino: string, dados: FormData) {
  const r = esquemaPagamento.safeParse(Object.fromEntries(dados.entries()));
  if (!uuid.safeParse(parcelaId).success || !r.success) voltar(destino, !r.success && r.error.issues[0].message === mensagemDeErro("valor_invalido") ? "erro_valor_invalido" : "erro_dados_invalidos");
  const p = r.data!;
  await executar(destino, "pagamento_registrar", { p_parcela: parcelaId, p_valor: p.valor, p_data: p.data, p_forma: p.forma }, "pagamento_registrado");
}

export async function estornarPagamento(pagamentoId: string, destino: string) {
  if (!uuid.safeParse(pagamentoId).success) voltar(destino, "erro_dados_invalidos");
  await executar(destino, "pagamento_estornar", { p_pagamento: pagamentoId }, "pagamento_estornado");
}

export async function cancelarParcela(parcelaId: string, destino: string) {
  if (!uuid.safeParse(parcelaId).success) voltar(destino, "erro_dados_invalidos");
  await executar(destino, "parcela_cancelar", { p_parcela: parcelaId }, "parcela_cancelada_ok");
}

export async function cancelarLancamento(lancamentoId: string, destino: string) {
  if (!uuid.safeParse(lancamentoId).success) voltar(destino, "erro_dados_invalidos");
  await executar(destino, "lancamento_cancelar", { p_lancamento: lancamentoId }, "lancamento_cancelado");
}

export async function alterarVencimento(parcelaId: string, destino: string, dados: FormData) {
  const v = dia.safeParse(String(dados.get("vencimento") ?? ""));
  if (!uuid.safeParse(parcelaId).success || !v.success) voltar(destino, "erro_vencimento_invalido");
  await executar(destino, "parcela_alterar_vencimento", { p_parcela: parcelaId, p_vencimento: v.data }, "vencimento_alterado");
}
