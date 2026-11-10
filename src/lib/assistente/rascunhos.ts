import Decimal from "decimal.js";
import { z } from "zod";
import { formatarCentavos, paraCentavos } from "@/lib/dinheiro";
import { dividirEmParcelas, MAX_PARCELAS, somarMeses, vencimentosMensais } from "@/lib/financeiro/parcelas";
import { CATEGORIAS, TIPOS } from "@/lib/financeiro/rotulos";
import { formatarCnj } from "@/lib/integrations/fontes/cnj";
import { AVISO_PRAZO, calcularPrazo, entradasDoTribunal, ErroContagem, type EntradaCalendario } from "@/lib/prazos/contagem";
import { normalizarNome } from "@/lib/triagem/similaridade";
import { camposManuais, montarMinuta, valoresAutomaticos } from "./minuta";
import { ErroAssistente, lerErroRpc, MODULO_DO_TIPO, type ContextoAssistente, type Rpc, type TipoRascunho } from "./tipos";

/**
 * Rascunhos de ação da Lia. Tudo aqui é código determinístico: a IA só manda a INTENÇÃO (cliente pelo nome,
 * "3 parcelas de 1.000"); o LAW acha o cliente no banco, faz a conta em centavos, calcula a data do prazo pelo
 * módulo de contagem e monta a minuta pelo modelo. Nada é gravado aqui: o rascunho só vira dado no Confirmar.
 */
export type CtxRascunho = {
  rpc: Rpc;
  escritorioId: string;
  contexto: ContextoAssistente;
  carregarCalendario: () => Promise<EntradaCalendario[]>;
};

export type Rascunho = {
  tipo: TipoRascunho;
  /** Exatamente o que a função de gravação recebe (sem o campo _exibir). */
  dados: Record<string, unknown>;
  /** Só para mostrar no cartão (nomes, parcelas, passos da contagem, prévia da minuta). */
  exibir: Record<string, unknown>;
  resumo: string;
  avisos: string[];
  /** O que volta para a IA: nunca CPF/CNPJ nem texto de minuta. */
  paraIa: Record<string, unknown>;
};

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const ehUuid = (v: string) => z.uuid().safeParse(v).success;
const br = (iso: string) => iso.split("-").reverse().join("/");

function exigirModulo(ctx: CtxRascunho, tipo: TipoRascunho) {
  const modulo = MODULO_DO_TIPO[tipo];
  if (!ctx.contexto.modulos.includes(modulo)) {
    throw new ErroAssistente("sem_permissao", `O usuário não tem acesso à tela ${modulo}. Recuse e explique que ele não tem permissão.`, [modulo]);
  }
}

async function chamar<T>(ctx: CtxRascunho, funcao: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await ctx.rpc(funcao, args);
  if (error) {
    const { codigo, modulos } = lerErroRpc(error);
    throw new ErroAssistente(codigo, codigo === "sem_permissao" ? "O usuário não tem permissão para esses dados." : `Falha ao consultar (${codigo}).`, modulos);
  }
  return data as T;
}

// ---------------------------------------------------------------------------------------------------------------
// Achar cliente / processo / pessoa da equipe a partir do que a IA mandou (nome, número ou id)
// ---------------------------------------------------------------------------------------------------------------
type Opcao = { id: string; nome: string };
export type Escolha = { unico: Opcao | null; candidatos: Opcao[] };

/** Id exato; senão nome igual (sem acento/caixa); senão todas as palavras do termo contidas no nome. */
export function escolherPorNome(opcoes: Opcao[], termo: string): Escolha {
  const t = termo.trim();
  if (ehUuid(t)) {
    const o = opcoes.find((x) => x.id === t);
    return { unico: o ?? null, candidatos: o ? [o] : [] };
  }
  const n = normalizarNome(t);
  if (!n) return { unico: null, candidatos: [] };
  const iguais = opcoes.filter((o) => normalizarNome(o.nome) === n);
  if (iguais.length === 1) return { unico: iguais[0], candidatos: iguais };
  const palavras = n.split(" ");
  const contem = iguais.length > 1 ? iguais : opcoes.filter((o) => {
    const nome = ` ${normalizarNome(o.nome)} `;
    return palavras.every((p) => nome.includes(` ${p} `) || nome.includes(` ${p}`));
  });
  return { unico: contem.length === 1 ? contem[0] : null, candidatos: contem.slice(0, 8) };
}

type ItemProcesso = { id: string; numero_cnj: string; status: string; tribunal: string | null; titulo?: string | null; restrito: boolean };
type ItemCliente = { id: string; nome: string; status: string };

async function acharProcesso(ctx: CtxRascunho, termo: string): Promise<ItemProcesso> {
  const r = await chamar<{ itens: ItemProcesso[] }>(ctx, "assistente_buscar_processos", { p_escritorio: ctx.escritorioId, p_termo: termo, p_limite: 5 });
  const digitos = termo.replace(/\D/g, "");
  const exatos = r.itens.filter((p) => p.id === termo.trim() || p.numero_cnj.replace(/\D/g, "") === digitos);
  const lista = exatos.length ? exatos : r.itens;
  if (lista.length === 0) throw new ErroAssistente("processo_nao_encontrado", `Nenhum processo encontrado para "${termo}". Pergunte o número ao usuário.`);
  if (lista.length > 1) throw new ErroAssistente("processo_ambiguo", `Mais de um processo para "${termo}": ${lista.map((p) => p.numero_cnj).join(", ")}. Pergunte qual.`);
  if (lista[0].status !== "confirmado") throw new ErroAssistente("processo_nao_confirmado", "O processo ainda está na triagem (provisório). Ele precisa ser confirmado antes.");
  return lista[0];
}

async function acharClienteConfirmado(ctx: CtxRascunho, termo: string): Promise<Escolha> {
  const r = await chamar<{ itens: ItemCliente[] }>(ctx, "assistente_buscar_clientes", { p_escritorio: ctx.escritorioId, p_termo: termo, p_limite: 20 });
  return escolherPorNome(r.itens.filter((c) => c.status === "confirmado"), termo);
}

function acharMembro(ctx: CtxRascunho, termo: string | undefined, exigir: "prazos" | "tarefas"): Opcao {
  const elegiveis = ctx.contexto.equipe.filter((m) => m[exigir]);
  const eu = elegiveis.find((m) => m.id === ctx.contexto.meu_membro_id);
  const t = termo?.trim() ?? "";
  if (!t || /^(eu|mim|comigo|me)$/i.test(t)) {
    if (!eu) throw new ErroAssistente("responsavel_invalido", "Informe quem será o responsável.");
    return eu;
  }
  const e = escolherPorNome(elegiveis, t);
  if (!e.unico) {
    throw new ErroAssistente("responsavel_invalido", e.candidatos.length > 1
      ? `Mais de uma pessoa da equipe para "${t}": ${e.candidatos.map((c) => c.nome).join(", ")}. Pergunte qual.`
      : `Ninguém da equipe com acesso a ${exigir} se chama "${t}".`);
  }
  return e.unico;
}

// ---------------------------------------------------------------------------------------------------------------
// Lançamento
// ---------------------------------------------------------------------------------------------------------------
const reais = z.number().positive().max(1_000_000_000);

export const EntradaLancamento = z.object({
  tipo: z.enum(["receita", "despesa"]).default("receita"),
  categoria: z.enum(Object.keys(CATEGORIAS) as [keyof typeof CATEGORIAS, ...(keyof typeof CATEGORIAS)[]]),
  descricao: z.string().trim().max(200).optional(),
  cliente: z.string().trim().min(1).max(200).optional(),
  processo: z.string().trim().min(1).max(60).optional(),
  parcelas: z.number().int().min(1).max(MAX_PARCELAS).default(1),
  valor_parcela_reais: reais.optional(),
  valor_total_reais: reais.optional(),
  primeiro_vencimento: z.string().regex(DIA).optional(),
  data_competencia: z.string().regex(DIA).optional(),
}).refine((e) => (e.valor_parcela_reais === undefined) !== (e.valor_total_reais === undefined), {
  message: "Informe valor_parcela_reais OU valor_total_reais (só um).",
});

/** Reais (número da IA) para centavos exatos. Mais de 2 casas decimais é recusado, nunca arredondado. */
export function reaisParaCentavos(v: number): number {
  const c = new Decimal(v).times(100);
  if (!c.isInteger()) throw new ErroAssistente("valor_invalido", "Valor com mais de 2 casas decimais. Pergunte o valor exato.");
  const n = c.toNumber();
  if (!Number.isSafeInteger(n) || n <= 0) throw new ErroAssistente("valor_invalido", "Valor inválido.");
  return n;
}

type OpcoesFinanceiro = { clientes: Opcao[]; processos: { id: string; numero_cnj: string; titulo: string | null }[] };

export function previaParcelas(totalCentavos: number, n: number, primeiro: string) {
  const valores = dividirEmParcelas(totalCentavos, n);
  const venc = vencimentosMensais(primeiro, n);
  return valores.map((valor, i) => ({ numero: i + 1, valor_centavos: valor, vencimento: venc[i] }));
}

export async function prepararLancamento(bruto: unknown, ctx: CtxRascunho): Promise<Rascunho> {
  exigirModulo(ctx, "lancamento");
  const e = EntradaLancamento.parse(bruto);
  const n = e.parcelas;
  const total = e.valor_total_reais !== undefined ? reaisParaCentavos(e.valor_total_reais) : reaisParaCentavos(e.valor_parcela_reais!) * n;
  if (total < n) throw new ErroAssistente("parcelas_demais", "Valor pequeno demais para tantas parcelas.");
  const avisos: string[] = [];

  const opcoes = await chamar<OpcoesFinanceiro>(ctx, "financeiro_opcoes", { p_escritorio: ctx.escritorioId });
  let cliente: Opcao | null = null;
  let candidatos: Opcao[] = [];
  if (e.cliente) {
    const esc = escolherPorNome(opcoes.clientes, e.cliente);
    if (!esc.unico && esc.candidatos.length === 0) {
      throw new ErroAssistente("cliente_nao_encontrado", `Nenhum cliente confirmado com o nome "${e.cliente}". Diga ao usuário que não encontrou; nada foi preparado.`);
    }
    cliente = esc.unico;
    candidatos = esc.unico ? [] : esc.candidatos;
    if (!cliente) avisos.push(`Há ${candidatos.length} clientes com nome parecido com "${e.cliente}". Escolha o cliente em "Editar".`);
  } else if (e.tipo === "receita") {
    throw new ErroAssistente("cliente_obrigatorio", "Receita precisa de cliente. Pergunte para qual cliente.");
  }

  let processo: { id: string; numero_cnj: string } | null = null;
  if (e.processo) {
    const dig = e.processo.replace(/\D/g, "");
    const achados = opcoes.processos.filter((p) => p.id === e.processo || (dig.length >= 4 && p.numero_cnj.includes(dig)));
    if (achados.length !== 1) throw new ErroAssistente("processo_nao_encontrado", `Processo "${e.processo}" não encontrado entre os confirmados (ou há mais de um). Pergunte o número completo.`);
    processo = achados[0];
  }

  const hoje = ctx.contexto.hoje;
  let primeiro = e.primeiro_vencimento ?? null;
  if (!primeiro) {
    primeiro = somarMeses(hoje, 1);
    avisos.push(`O 1º vencimento não foi informado: sugeri ${br(primeiro)} (daqui a 1 mês). Confira.`);
  }
  if (primeiro < hoje) avisos.push("O 1º vencimento já passou: a parcela nasce como atrasada.");
  const descricao = e.descricao && e.descricao.length >= 2 ? e.descricao : `${CATEGORIAS[e.categoria]}${cliente ? ` — ${cliente.nome}` : ""}`;
  const parcelas = previaParcelas(total, n, primeiro);

  const dados = {
    tipo: e.tipo, categoria: e.categoria, descricao, valor_centavos: total, parcelas: n, primeiro_vencimento: primeiro,
    data_competencia: e.data_competencia ?? null, cliente_id: cliente?.id ?? null, processo_id: processo?.id ?? null,
  };
  const valorParcela = parcelas.every((p) => p.valor_centavos === parcelas[0].valor_centavos)
    ? `${n} ${n === 1 ? "parcela" : "parcelas"} de ${formatarCentavos(parcelas[0].valor_centavos)}`
    : `${n} parcelas (a 1ª de ${formatarCentavos(parcelas[0].valor_centavos)})`;
  const resumo = `${TIPOS[e.tipo]} · ${CATEGORIAS[e.categoria]} · ${valorParcela}, total ${formatarCentavos(total)}`
    + `${cliente ? ` · ${cliente.nome}` : ""} · 1º vencimento ${br(primeiro)}`;
  return {
    tipo: "lancamento", dados, avisos, resumo,
    exibir: { cliente_nome: cliente?.nome ?? null, candidatos_cliente: candidatos, processo_numero: processo ? formatarCnj(processo.numero_cnj) : null, parcelas },
    paraIa: { resumo, avisos, valor_total_centavos: total, parcelas: parcelas.map((p) => ({ numero: p.numero, valor: formatarCentavos(p.valor_centavos), vencimento: p.vencimento })) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Tarefa
// ---------------------------------------------------------------------------------------------------------------
export const EntradaTarefa = z.object({
  titulo: z.string().trim().min(1).max(160),
  descricao: z.string().trim().max(4000).optional(),
  data: z.string().regex(DIA).optional(),
  responsavel: z.string().trim().max(200).optional(),
  processo: z.string().trim().max(60).optional(),
  cliente: z.string().trim().max(200).optional(),
  coluna: z.string().trim().max(40).optional(),
  etiquetas: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
});

export async function prepararTarefa(bruto: unknown, ctx: CtxRascunho): Promise<Rascunho> {
  exigirModulo(ctx, "tarefa");
  const e = EntradaTarefa.parse(bruto);
  const avisos: string[] = [];
  const responsavel = acharMembro(ctx, e.responsavel, "tarefas");
  const colunas = ctx.contexto.colunas;
  if (!colunas.length) throw new ErroAssistente("coluna_invalida", "O quadro de tarefas não tem colunas.");
  const coluna = e.coluna ? escolherPorNome(colunas, e.coluna).unico : colunas[0];
  if (!coluna) throw new ErroAssistente("coluna_invalida", `Não existe a coluna "${e.coluna}". Colunas: ${colunas.map((c) => c.nome).join(", ")}.`);
  const processo = e.processo ? await acharProcesso(ctx, e.processo) : null;
  let cliente: Opcao | null = null;
  if (e.cliente) {
    const esc = await acharClienteConfirmado(ctx, e.cliente);
    if (!esc.unico) throw new ErroAssistente("cliente_nao_encontrado", esc.candidatos.length > 1
      ? `Mais de um cliente para "${e.cliente}": ${esc.candidatos.map((c) => c.nome).join(", ")}. Pergunte qual.`
      : `Nenhum cliente confirmado com o nome "${e.cliente}".`);
    cliente = esc.unico;
  }
  if (e.data && e.data < ctx.contexto.hoje) avisos.push("A data informada já passou.");
  const dados = {
    coluna_id: coluna.id, titulo: e.titulo, descricao: e.descricao ?? "", responsavel_id: responsavel.id, data: e.data ?? null,
    processo_id: processo?.id ?? null, cliente_id: cliente?.id ?? null, etiquetas: e.etiquetas ?? [],
  };
  const resumo = `Tarefa "${e.titulo}" para ${responsavel.nome}${e.data ? ` em ${br(e.data)}` : " (sem data)"} · coluna ${coluna.nome}`
    + `${processo ? ` · processo ${formatarCnj(processo.numero_cnj)}` : ""}${cliente ? ` · ${cliente.nome}` : ""}`;
  return {
    tipo: "tarefa", dados, avisos, resumo,
    exibir: { responsavel_nome: responsavel.nome, coluna_nome: coluna.nome, processo_numero: processo ? formatarCnj(processo.numero_cnj) : null, cliente_nome: cliente?.nome ?? null },
    paraIa: { resumo, avisos },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Prazo (a data é SEMPRE do módulo de contagem; a IA não manda data final)
// ---------------------------------------------------------------------------------------------------------------
export const EntradaPrazo = z.object({
  processo: z.string().trim().min(4).max(60),
  descricao: z.string().trim().min(3).max(200),
  dias: z.number().int().min(1).max(365),
  tipo_contagem: z.enum(["util", "corrido"]).default("util"),
  data_disponibilizacao: z.string().regex(DIA).optional(),
  publicacao_id: z.uuid().optional(),
  responsavel: z.string().trim().max(200).optional(),
}).refine((e) => e.data_disponibilizacao || e.publicacao_id, { message: "Informe data_disponibilizacao ou publicacao_id." });

type ItemPublicacao = { id: string; data_disponibilizacao: string; processo_id: string | null };

async function calcular(ctx: CtxRascunho, tribunal: string | null, disponibilizacao: string, dias: number, tipo: "util" | "corrido") {
  const calendario = entradasDoTribunal(await ctx.carregarCalendario(), tribunal);
  try {
    return calcularPrazo({ disponibilizacao, dias, tipo, calendario });
  } catch (err) {
    if (err instanceof ErroContagem) throw new ErroAssistente("raciocinio_invalido", err.message);
    throw err;
  }
}

export async function prepararPrazo(bruto: unknown, ctx: CtxRascunho): Promise<Rascunho> {
  exigirModulo(ctx, "prazo");
  const e = EntradaPrazo.parse(bruto);
  const processo = await acharProcesso(ctx, e.processo);
  const responsavel = acharMembro(ctx, e.responsavel, "prazos");
  let disponibilizacao = e.data_disponibilizacao ?? null;
  if (e.publicacao_id) {
    const r = await chamar<{ itens: ItemPublicacao[] }>(ctx, "assistente_buscar_publicacoes", { p_escritorio: ctx.escritorioId, p_termo: processo.numero_cnj, p_limite: 20 });
    const pub = r.itens.find((p) => p.id === e.publicacao_id);
    if (!pub || pub.processo_id !== processo.id) throw new ErroAssistente("publicacao_invalida", "Essa publicação não está ligada a este processo.");
    disponibilizacao = pub.data_disponibilizacao; // a data oficial é a da publicação
  }
  const c = await calcular(ctx, processo.tribunal, disponibilizacao!, e.dias, e.tipo_contagem);
  const avisos = [AVISO_PRAZO];
  if (c.dataFinal < ctx.contexto.hoje) avisos.push("Pelo cálculo, este prazo JÁ VENCEU. Confira antes de confirmar.");
  const dados = {
    processo_id: processo.id, publicacao_id: e.publicacao_id ?? null, descricao: e.descricao, dias: e.dias, tipo_contagem: e.tipo_contagem,
    responsavel_id: responsavel.id, data_disponibilizacao: c.disponibilizacao, data_publicacao: c.publicacao,
    inicio_contagem: c.inicioContagem, data_final: c.dataFinal,
  };
  const resumo = `Prazo "${e.descricao}" · ${e.dias} dias ${e.tipo_contagem === "util" ? "úteis" : "corridos"} · vence ${br(c.dataFinal)}`
    + ` · processo ${formatarCnj(processo.numero_cnj)} · responsável ${responsavel.nome}`;
  return {
    tipo: "prazo", dados, avisos, resumo,
    exibir: { processo_numero: formatarCnj(processo.numero_cnj), tribunal: processo.tribunal, responsavel_nome: responsavel.nome, passos: c.passos, dias_pulados: c.diasPulados },
    paraIa: { resumo, avisos, data_final: c.dataFinal, observacao: "Data calculada pelo LAW (não pela IA)." },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Minuta de contrato (sempre a partir de modelo cadastrado pelo escritório)
// ---------------------------------------------------------------------------------------------------------------
export const EntradaMinuta = z.object({
  modelo: z.string().trim().min(1).max(120),
  cliente: z.string().trim().max(200).optional(),
  processo: z.string().trim().max(60).optional(),
  titulo: z.string().trim().min(2).max(200).optional(),
  campos: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.string().max(2000)).optional(),
});

async function montar(ctx: CtxRascunho, modeloTexto: string, clienteId: string | null, processoId: string | null, campos: Record<string, string>) {
  const bruto = await chamar<Record<string, unknown>>(ctx, "assistente_dados_minuta", { p_escritorio: ctx.escritorioId, p_cliente: clienteId, p_processo: processoId });
  return montarMinuta(modeloTexto, valoresAutomaticos(bruto, ctx.contexto.hoje), campos);
}

export async function prepararMinuta(bruto: unknown, ctx: CtxRascunho): Promise<Rascunho> {
  exigirModulo(ctx, "minuta");
  const e = EntradaMinuta.parse(bruto);
  const modelos = ctx.contexto.modelos;
  if (!modelos.length) throw new ErroAssistente("sem_modelo", "O escritório ainda não cadastrou modelos de contrato. Diga isso ao usuário (Lia > Modelos de contrato).");
  const escolhido = escolherPorNome(modelos, e.modelo).unico;
  const modelo = escolhido ? modelos.find((x) => x.id === escolhido.id) : undefined;
  if (!modelo) throw new ErroAssistente("modelo_nao_encontrado", `Modelo "${e.modelo}" não encontrado. Modelos: ${modelos.map((m) => m.nome).join("; ")}.`);
  let cliente: Opcao | null = null;
  if (e.cliente) {
    const esc = await acharClienteConfirmado(ctx, e.cliente);
    if (!esc.unico) throw new ErroAssistente("cliente_nao_encontrado", esc.candidatos.length > 1
      ? `Mais de um cliente para "${e.cliente}": ${esc.candidatos.map((c) => c.nome).join(", ")}. Pergunte qual.`
      : `Nenhum cliente confirmado com o nome "${e.cliente}".`);
    cliente = esc.unico;
  }
  const processo = e.processo ? await acharProcesso(ctx, e.processo) : null;
  const manuais = camposManuais(modelo.texto);
  const campos = Object.fromEntries(Object.entries(e.campos ?? {}).filter(([k]) => manuais.includes(k)));
  const m = await montar(ctx, modelo.texto, cliente?.id ?? null, processo?.id ?? null, campos);
  const titulo = e.titulo ?? `${modelo.nome}${cliente ? ` — ${cliente.nome}` : ""}`;
  const avisos = ["Minuta gerada a partir do modelo do escritório: nasce como NÃO REVISADA."];
  if (m.faltando.length) avisos.push(`Campos sem valor: ${m.faltando.join(", ")}. Preencha em "Editar" ou depois na minuta.`);
  const dados = { modelo_id: modelo.id, cliente_id: cliente?.id ?? null, processo_id: processo?.id ?? null, titulo, campos };
  const resumo = `Minuta "${titulo}" do modelo "${modelo.nome}"${m.faltando.length ? ` · ${m.faltando.length} campo(s) a preencher` : ""}`;
  return {
    tipo: "minuta", dados, avisos, resumo,
    exibir: { modelo_nome: modelo.nome, cliente_nome: cliente?.nome ?? null, processo_numero: processo ? formatarCnj(processo.numero_cnj) : null, campos_manuais: manuais, previa: m.texto, faltando: m.faltando },
    paraIa: { resumo, avisos, campos_faltando: m.faltando },
  };
}

export const PREPARADORES: Record<TipoRascunho, (bruto: unknown, ctx: CtxRascunho) => Promise<Rascunho>> = {
  lancamento: prepararLancamento,
  tarefa: prepararTarefa,
  prazo: prepararPrazo,
  minuta: prepararMinuta,
};

// ---------------------------------------------------------------------------------------------------------------
// Confirmação: o que o usuário viu/editou no cartão vira os dados FINAIS, validados de novo no servidor.
// ---------------------------------------------------------------------------------------------------------------
const opcionalUuid = z.union([z.uuid(), z.literal("")]).optional().transform((v) => v || null);
const opcionalDia = z.union([z.string().regex(DIA), z.literal("")]).optional().transform((v) => v || null);

const FormLancamento = z.object({
  tipo: z.enum(["receita", "despesa"]),
  categoria: z.enum(Object.keys(CATEGORIAS) as [string, ...string[]]),
  descricao: z.string().trim().min(2).max(200),
  cliente_id: opcionalUuid,
  processo_id: opcionalUuid,
  valor_total: z.string().max(30),
  parcelas: z.coerce.number().int().min(1).max(MAX_PARCELAS),
  primeiro_vencimento: z.string().regex(DIA),
  data_competencia: opcionalDia,
});
const FormTarefa = z.object({
  titulo: z.string().trim().min(1).max(160),
  descricao: z.string().max(4000).default(""),
  data: opcionalDia,
  responsavel_id: opcionalUuid,
  coluna_id: z.uuid(),
  processo_id: opcionalUuid,
  cliente_id: opcionalUuid,
  etiquetas: z.string().max(400).default(""),
});
const FormPrazo = z.object({
  descricao: z.string().trim().min(3).max(200),
  responsavel_id: z.uuid(),
  esperada: z.string().regex(DIA),
});
const FormMinuta = z.object({ titulo: z.string().trim().min(2).max(200) }).catchall(z.string().max(2000));

const DadosPrazoRascunho = z.object({
  processo_id: z.uuid(), publicacao_id: z.uuid().nullable(), dias: z.number().int(), tipo_contagem: z.enum(["util", "corrido"]),
  data_disponibilizacao: z.string().regex(DIA),
});
const DadosMinutaRascunho = z.object({ modelo_id: z.uuid(), cliente_id: z.uuid().nullable(), processo_id: z.uuid().nullable() });

function invalido(r: { success: boolean; error?: z.ZodError }): never {
  throw new ErroAssistente("dados_invalidos", r.error?.issues[0]?.message ?? "Confira os campos.");
}

/**
 * Monta os dados FINAIS a gravar. `original` = dados do rascunho (o que a Lia preparou); `form` = o cartão.
 * Campos que mudam o cálculo do prazo (processo, dias, data) não são editáveis no cartão: para mudá-los, descarte.
 */
export async function dadosParaConfirmar(tipo: TipoRascunho, original: Record<string, unknown>, form: Record<string, string>, ctx: CtxRascunho) {
  exigirModulo(ctx, tipo);
  if (tipo === "lancamento") {
    const r = FormLancamento.safeParse(form);
    if (!r.success) invalido(r);
    const f = r.data;
    const total = paraCentavos(f.valor_total);
    if (total === null || total <= 0) throw new ErroAssistente("valor_invalido", "Valor inválido.");
    if (total < f.parcelas) throw new ErroAssistente("parcelas_demais", "Valor pequeno demais para tantas parcelas.");
    if (f.tipo === "receita" && !f.cliente_id) throw new ErroAssistente("cliente_obrigatorio", "Receita precisa de um cliente. Escolha o cliente.");
    return {
      tipo: f.tipo, categoria: f.categoria, descricao: f.descricao, valor_centavos: total, parcelas: f.parcelas,
      primeiro_vencimento: f.primeiro_vencimento, data_competencia: f.data_competencia, cliente_id: f.cliente_id, processo_id: f.processo_id,
    };
  }
  if (tipo === "tarefa") {
    const r = FormTarefa.safeParse(form);
    if (!r.success) invalido(r);
    const f = r.data;
    const etiquetas = f.etiquetas.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 10);
    return { coluna_id: f.coluna_id, titulo: f.titulo, descricao: f.descricao, responsavel_id: f.responsavel_id, data: f.data, processo_id: f.processo_id, cliente_id: f.cliente_id, etiquetas };
  }
  if (tipo === "prazo") {
    const r = FormPrazo.safeParse(form);
    if (!r.success) invalido(r);
    const o = DadosPrazoRascunho.parse(original);
    const resp = ctx.contexto.equipe.find((m) => m.id === r.data.responsavel_id && m.prazos);
    if (!resp) throw new ErroAssistente("responsavel_invalido", "Escolha um responsável que tenha acesso aos Prazos.");
    const proc = await acharProcesso(ctx, o.processo_id);
    const c = await calcular(ctx, proc.tribunal, o.data_disponibilizacao, o.dias, o.tipo_contagem);
    // A data que o usuário viu e conferiu. Se o calendário mudou desde o rascunho, não grava.
    if (c.dataFinal !== r.data.esperada) throw new ErroAssistente("prazo_mudou", "O cálculo mudou desde o rascunho (o calendário foi alterado). Peça o prazo de novo.");
    return {
      processo_id: o.processo_id, publicacao_id: o.publicacao_id, descricao: r.data.descricao, dias: o.dias, tipo_contagem: o.tipo_contagem,
      responsavel_id: resp.id, data_disponibilizacao: c.disponibilizacao, data_publicacao: c.publicacao, inicio_contagem: c.inicioContagem,
      data_final: c.dataFinal, raciocinio: { passos: c.passos, diasPulados: c.diasPulados, aviso: c.aviso, calculadoEm: "servidor", origem: "assistente" },
    };
  }
  const r = FormMinuta.safeParse(form);
  if (!r.success) invalido(r);
  const o = DadosMinutaRascunho.parse(original);
  const modelo = ctx.contexto.modelos.find((m) => m.id === o.modelo_id);
  if (!modelo) throw new ErroAssistente("modelo_nao_encontrado", "O modelo foi desativado ou apagado. Peça a minuta de novo.");
  const manuais = camposManuais(modelo.texto);
  const campos: Record<string, string> = {};
  for (const c of manuais) {
    const v = r.data[`campo_${c}`];
    if (typeof v === "string") campos[c] = v;
  }
  const m = await montar(ctx, modelo.texto, o.cliente_id, o.processo_id, campos);
  return { modelo_id: o.modelo_id, cliente_id: o.cliente_id, processo_id: o.processo_id, titulo: r.data.titulo, texto: m.texto };
}
