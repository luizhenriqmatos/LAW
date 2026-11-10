"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { EstadoFormulario } from "@/components/formulario";
import { ErroCalculo, validarRegime } from "@/lib/calculos/base";
import type { Demonstrativo, TipoCalculo } from "@/lib/calculos/calculos";
import { lerFormulario } from "@/lib/calculos/formulario";
import { gerarPdf } from "@/lib/calculos/pdf";
import { carregarRegimes, executarCalculo, type ProcessoOpcao } from "@/lib/calculos/servidor";
import { exigirDono, exigirModulo } from "@/lib/contexto";
import { depsDriveDoAmbiente, driveConfigurado } from "@/lib/drive/ambiente";
import { enviarArquivo } from "@/lib/drive/arquivos";
import { codigoDeErro, mensagemDeErro } from "@/lib/erros";
import { atualizarIndices } from "@/lib/integrations/bcb/sgs";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

/**
 * Ações da tela Cálculos. Camada 2 (rota) aqui; a camada 3 (banco) confere de novo em cada função.
 * O motor roda no servidor: o navegador nunca envia o resultado, só os parâmetros.
 */
const CALCULOS = "/app/calculos";
const uuid = z.uuid();
const TIPOS: TipoCalculo[] = ["atualizacao", "art523", "honorarios", "trabalhista"];

function voltar(destino: string, aviso: string): never {
  revalidatePath(CALCULOS, "layout");
  redirect(`${destino}${destino.includes("?") ? "&" : "?"}aviso=${encodeURIComponent(aviso)}`);
}

async function processoDoEscritorio(supabase: Awaited<ReturnType<typeof exigirModulo>>["supabase"], esc: string, id: string | null): Promise<ProcessoOpcao | null> {
  if (!id) return null;
  const { data } = await supabase.rpc("calculo_opcoes", { p_escritorio: esc });
  return ((data ?? []) as ProcessoOpcao[]).find((p) => p.id === id) ?? null;
}

export async function salvarCalculo(_: EstadoFormulario, fd: FormData): Promise<EstadoFormulario> {
  const tipo = String(fd.get("tipo")) as TipoCalculo;
  if (!TIPOS.includes(tipo)) return { erro: "Tipo de cálculo inválido." };
  const id = uuid.safeParse(fd.get("id")).success ? String(fd.get("id")) : null;
  const origem = uuid.safeParse(fd.get("origem")).success ? String(fd.get("origem")) : null;
  const { supabase, vinculo } = await exigirModulo("calculos");

  const regimes = await carregarRegimes(supabase);
  const escopo = tipo === "trabalhista" ? "trabalhista" : "civel";
  const padrao = regimes.filter((r) => r.escritorio_id === null && r.ativo && r.escopo === escopo).map((r) => r.id);
  const lido = lerFormulario(tipo, fd, padrao, regimes.map((r) => r.id));
  if ("erro" in lido) return { erro: lido.erro };

  const processo = await processoDoEscritorio(supabase, vinculo.escritorioId, lido.processoId);
  if (lido.processoId && !processo) return { erro: mensagemDeErro("processo_invalido") };
  const hoje = hojeBrasilia();
  let calculado;
  try {
    calculado = await executarCalculo(supabase, vinculo.escritorioId, tipo, lido.parametros, { titulo: lido.titulo, processo, partes: lido.partes, dataCalculo: hoje });
  } catch (e) {
    if (e instanceof ErroCalculo) return { erro: e.message };
    throw e;
  }
  const { data, error } = await supabase.rpc("calculo_salvar", {
    p_escritorio: vinculo.escritorioId,
    p_id: id,
    p_dados: {
      tipo, titulo: lido.titulo, partes: lido.partes, processo_id: lido.processoId, origem_id: origem,
      parametros: { ...lido.parametros, modoRegimes: lido.modoRegimes },
      regimes: calculado.regimes, resultado: calculado.demonstrativo, total_centavos: calculado.demonstrativo.totalCentavos,
      data_calculo: hoje, marcos: calculado.marcos,
    },
  });
  if (error) return { erro: mensagemDeErro(error) };
  voltar(`${CALCULOS}/${data as string}`, id ? "calculo_atualizado" : "calculo_salvo");
}

type LinhaCalculo = {
  id: string; tipo: TipoCalculo; titulo: string; partes: string | null; processo_id: string | null; parametros: Record<string, unknown>;
  regimes: string[]; resultado: Demonstrativo; total_centavos: number; data_calculo: string;
};
async function lerCalculo(id: string) {
  const ctx = await exigirModulo("calculos");
  const { data } = await ctx.supabase.from("calculo").select("id, tipo, titulo, partes, processo_id, parametros, regimes, resultado, total_centavos, data_calculo").eq("id", id).maybeSingle();
  return { ...ctx, calculo: data as LinhaCalculo | null };
}

/** Duplica sem recalcular: a cópia guarda os mesmos parâmetros e o mesmo resultado (reproduzível). */
export async function duplicarCalculo(id: string) {
  if (!uuid.safeParse(id).success) voltar(CALCULOS, "erro_dados_invalidos");
  const { supabase, vinculo, calculo } = await lerCalculo(id);
  if (!calculo) voltar(CALCULOS, "erro_nao_encontrado");
  const { data: marcos } = await supabase.from("marco_processual").select("tipo, data").eq("calculo_id", id);
  const titulo = `${calculo.titulo.slice(0, 150)} (cópia)`;
  const { data, error } = await supabase.rpc("calculo_salvar", {
    p_escritorio: vinculo.escritorioId, p_id: null,
    p_dados: {
      tipo: calculo.tipo, titulo, partes: calculo.partes, processo_id: calculo.processo_id, origem_id: calculo.id, parametros: calculo.parametros,
      regimes: calculo.regimes, resultado: { ...calculo.resultado, titulo }, total_centavos: calculo.total_centavos, data_calculo: calculo.data_calculo, marcos: marcos ?? [],
    },
  });
  if (error) voltar(`${CALCULOS}/${id}`, `erro_${codigoDeErro(error)}`);
  voltar(`${CALCULOS}/${data as string}/editar`, "calculo_duplicado");
}

export async function excluirCalculo(id: string) {
  if (!uuid.safeParse(id).success) voltar(CALCULOS, "erro_dados_invalidos");
  const { supabase } = await exigirModulo("calculos");
  const { error } = await supabase.rpc("calculo_excluir", { p_id: id });
  voltar(error ? `${CALCULOS}/${id}` : CALCULOS, error ? `erro_${codigoDeErro(error)}` : "calculo_excluido");
}

/** Gera o PDF e salva na pasta do processo no Google Drive (Prompt 6). */
export async function salvarPdfNoDrive(id: string) {
  if (!uuid.safeParse(id).success) voltar(CALCULOS, "erro_dados_invalidos");
  const destino = `${CALCULOS}/${id}`;
  const { supabase, vinculo, calculo } = await lerCalculo(id);
  if (!calculo) voltar(CALCULOS, "erro_nao_encontrado");
  if (!calculo.processo_id) voltar(destino, "erro_calculo_sem_processo");
  if (!driveConfigurado() || !servicoConfigurado()) voltar(destino, "erro_drive_nao_configurado");
  // Quem pode enviar à pasta: quem tem Processos ou Documentos (o banco confere).
  const { data: pasta, error } = await supabase.rpc("drive_pasta_de", { p_tipo: "processo", p_ref: calculo.processo_id });
  if (error) voltar(destino, `erro_${codigoDeErro(error)}`);
  const p = pasta as { escritorio_id: string; drive_id: string } | null;
  if (!p) voltar(destino, "erro_drive_sem_pasta");
  const pdf = await gerarPdf(calculo.resultado, { escritorio: vinculo.escritorioNome, geradoEm: dataHoraAgora() });
  const nome = `Calculo - ${calculo.titulo} - ${calculo.data_calculo.split("-").reverse().join("-")}.pdf`;
  const r = await enviarArquivo(depsDriveDoAmbiente(), p.escritorio_id, p.drive_id, { nome, tipo: "application/pdf", dados: pdf });
  if (!r.ok) voltar(destino, `erro_${r.codigo}`);
  await supabase.rpc("calculo_registrar_pdf", { p_id: id, p_drive_id: r.dados.id });
  voltar(destino, "pdf_no_drive");
}

function dataHoraAgora(): string {
  return new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------------------------------------------
// Regimes personalizados
// ---------------------------------------------------------------------------------------------------------------
const esquemaRegime = z.object({
  nome: z.string().trim().min(3, mensagemDeErro("regime_sem_nome")).max(120, mensagemDeErro("regime_sem_nome")),
  escopo: z.enum(["civel", "trabalhista", "fazenda_pre_expedicao", "fazenda_pos_expedicao"]),
  vigencia_inicio: z.string().refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v)),
  vigencia_fim: z.string().refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v)),
  fundamento: z.string().trim().min(3, mensagemDeErro("fundamento_obrigatorio")).max(2000),
  correcao_indice: z.enum(["IPCA", "IPCA_E", "IPCA_15", "INPC", "IGP_M", "TR", "nenhuma"]),
  juros_tipo: z.enum(["nenhum", "taxa_legal", "percentual_fixo_ao_ano_simples", "percentual_ao_mes", "tr_art39_lei8177", "selic_englobando_correcao_e_juros"]),
  juros_valor: z.string().transform((v) => v.trim().replace(",", ".")),
  teto: z.enum(["nenhum", "selic"]),
  inicio_no_marco: z.union([z.enum(["ajuizamento", "citacao", "transito_em_julgado", "expedicao_requisitorio"]), z.literal("")]),
  fim_no_marco: z.union([z.enum(["ajuizamento", "citacao", "transito_em_julgado", "expedicao_requisitorio"]), z.literal("")]),
});

function lerRegime(fd: FormData): { dados: Record<string, unknown> } | { erro: string } {
  const r = esquemaRegime.safeParse({
    ...Object.fromEntries(["nome", "escopo", "vigencia_inicio", "vigencia_fim", "fundamento", "correcao_indice", "juros_tipo", "juros_valor", "inicio_no_marco", "fim_no_marco"].map((k) => [k, String(fd.get(k) ?? "")])),
    teto: fd.get("teto") === "selic" ? "selic" : "nenhum",
  });
  if (!r.success) return { erro: r.error.issues[0].message || mensagemDeErro("dados_invalidos") };
  const precisaValor = r.data.juros_tipo === "percentual_ao_mes" || r.data.juros_tipo === "percentual_fixo_ao_ano_simples";
  const dados = {
    ...r.data,
    juros_valor: precisaValor ? r.data.juros_valor : null,
    inicio_no_marco: r.data.inicio_no_marco || null,
    fim_no_marco: r.data.fim_no_marco || null,
    correcao_pro_rata: fd.get("correcao_pro_rata") === "on",
    juros_pro_rata: fd.get("juros_pro_rata") === "on",
    indice_editavel: fd.get("indice_editavel") === "on",
  };
  const erro = validarRegime(dados as never);
  if (erro) return { erro: mensagemDeErro(erro) };
  if (dados.vigencia_inicio && dados.vigencia_fim && dados.vigencia_fim < dados.vigencia_inicio) return { erro: mensagemDeErro("vigencia_invalida") };
  return { dados };
}

export async function criarRegime(_: EstadoFormulario, fd: FormData): Promise<EstadoFormulario> {
  const l = lerRegime(fd);
  if ("erro" in l) return { erro: l.erro };
  const { supabase, vinculo } = await exigirModulo("calculos");
  const { error } = await supabase.rpc("regime_criar", { p_escritorio: vinculo.escritorioId, p_dados: l.dados });
  if (error) return { erro: mensagemDeErro(error) };
  voltar(`${CALCULOS}/regimes`, "regime_criado");
}

export async function novaVersaoRegime(_: EstadoFormulario, fd: FormData): Promise<EstadoFormulario> {
  const id = String(fd.get("regime_id") ?? "");
  if (!uuid.safeParse(id).success) return { erro: mensagemDeErro("dados_invalidos") };
  const l = lerRegime(fd);
  if ("erro" in l) return { erro: l.erro };
  const { supabase } = await exigirModulo("calculos");
  const { error } = await supabase.rpc("regime_nova_versao", { p_regime: id, p_dados: l.dados });
  if (error) return { erro: mensagemDeErro(error) };
  voltar(`${CALCULOS}/regimes`, "regime_versionado");
}

export async function arquivarRegime(id: string) {
  if (!uuid.safeParse(id).success) voltar(`${CALCULOS}/regimes`, "erro_dados_invalidos");
  const { supabase } = await exigirModulo("calculos");
  const { error } = await supabase.rpc("regime_arquivar", { p_regime: id });
  voltar(`${CALCULOS}/regimes`, error ? `erro_${codigoDeErro(error)}` : "regime_arquivado");
}

/** Só o dono: busca agora no Banco Central (o job automático roda nos dias 2, 12 e 26). */
export async function atualizarIndicesAgora() {
  await exigirDono();
  if (!servicoConfigurado()) voltar(`${CALCULOS}/indices`, "erro_servico_nao_configurado");
  const r = await atualizarIndices({ fetch, rpc: rpcServico(), hoje: hojeBrasilia() });
  voltar(`${CALCULOS}/indices`, r.every((x) => x.ok) ? "indices_atualizados" : "indices_parciais");
}
