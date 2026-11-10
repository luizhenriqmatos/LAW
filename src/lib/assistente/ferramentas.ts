import { z } from "zod";
import type { DefinicaoFerramenta } from "@/lib/integrations/ia";
import { PREPARADORES, type CtxRascunho } from "./rascunhos";
import { ErroAssistente, Fonte, lerErroRpc, type TipoRascunho } from "./tipos";

/**
 * Ferramentas da Lia.
 *  - LEITURA: executam direto, chamando funções do banco com o login do usuário (RLS).
 *  - ESCRITA ("preparar_*"): NUNCA gravam. Montam um RASCUNHO DE AÇÃO que aparece num cartão com
 *    Confirmar / Editar / Descartar. Só o Confirmar do usuário grava (assistente_rascunho_confirmar).
 *
 * PENDENCIA P-067: o resultado das ferramentas vai à API da Anthropic (fora do Brasil). Já fica de fora: CPF/CNPJ, e-mail,
 * telefone e, em segredo de justiça, partes, título e texto de publicação. Falta contrato de tratamento de dados e aviso nos termos.
 */
export type CtxFerramenta = CtxRascunho & { conversaId: string };

export type ResultadoFerramenta =
  | { ok: true; paraIa: unknown; fontes: Fonte[]; rascunhoId?: string; itens?: number }
  | { ok: false; codigo: string; mensagem: string; semPermissao: string[] };

type Ferramenta = {
  definicao: DefinicaoFerramenta;
  tipo: "leitura" | "escrita";
  /** Módulos que liberam a ferramenta (basta um). Usado no aviso fixo de "sem permissão". */
  modulos: string[];
  executar: (ctx: CtxFerramenta, entrada: unknown) => Promise<ResultadoFerramenta>;
};

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const termo = z.string().trim().max(200).optional();
const limite = z.number().int().min(1).max(20).optional();
const dia = z.string().regex(DIA).optional();

const propTermo = { type: "string", description: "Texto para procurar (nome, número do processo, palavra). Vazio = os mais recentes." };
const propLimite = { type: "integer", minimum: 1, maximum: 20, description: "Quantos itens (padrão 10)." };
const propDia = (d: string) => ({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: `${d} (AAAA-MM-DD)` });

/** Uma ferramenta de leitura = uma função do banco `assistente_buscar_*`. */
function leitura(nome: string, descricao: string, modulos: string[], propriedades: Record<string, unknown>,
  esquema: z.ZodType<Record<string, unknown>>, funcao: string, args: (e: Record<string, unknown>, ctx: CtxFerramenta) => Record<string, unknown>): Ferramenta {
  return {
    tipo: "leitura",
    modulos,
    definicao: { name: nome, description: descricao, input_schema: { type: "object", properties: propriedades, additionalProperties: false } },
    async executar(ctx, entrada) {
      const r = esquema.safeParse(entrada ?? {});
      if (!r.success) return { ok: false, codigo: "entrada_invalida", mensagem: r.error.issues[0]?.message ?? "Entrada inválida.", semPermissao: [] };
      const { data, error } = await ctx.rpc(funcao, { p_escritorio: ctx.escritorioId, ...args(r.data, ctx) });
      if (error) {
        const { codigo, modulos: recusados } = lerErroRpc(error);
        if (codigo === "sem_permissao") {
          return {
            ok: false, codigo, semPermissao: recusados.length ? recusados : modulos,
            mensagem: "O usuário NÃO tem permissão para estes dados. Responda que ele não tem acesso a essa informação e não tente outra ferramenta para obtê-la.",
          };
        }
        return { ok: false, codigo, mensagem: `A consulta falhou (${codigo}).`, semPermissao: [] };
      }
      const resultado = z.object({ itens: z.array(z.record(z.string(), z.unknown())) }).loose().safeParse(data);
      if (!resultado.success) return { ok: false, codigo: "falha", mensagem: "Resposta inesperada do banco.", semPermissao: [] };
      const fontes = resultado.data.itens.map((i) => Fonte.safeParse({ ref: i.ref, rotulo: i.rotulo, link: i.link })).flatMap((f) => (f.success ? [f.data] : []));
      return { ok: true, paraIa: data, fontes, itens: resultado.data.itens.length };
    },
  };
}

/** Uma ferramenta de escrita = monta o rascunho e o guarda como PENDENTE. Não grava o lançamento/tarefa/prazo/minuta. */
function escrita(nome: string, descricao: string, tipo: TipoRascunho, modulo: string, propriedades: Record<string, unknown>, obrigatorias: string[]): Ferramenta {
  return {
    tipo: "escrita",
    modulos: [modulo],
    definicao: { name: nome, description: descricao, input_schema: { type: "object", properties: propriedades, required: obrigatorias, additionalProperties: false } },
    async executar(ctx, entrada) {
      try {
        const r = await PREPARADORES[tipo](entrada, ctx);
        const { data, error } = await ctx.rpc("assistente_rascunho_criar", {
          p_conversa: ctx.conversaId, p_tipo: tipo, p_dados: { ...r.dados, _exibir: r.exibir }, p_resumo: r.resumo, p_avisos: r.avisos,
        });
        if (error) {
          const { codigo, modulos } = lerErroRpc(error);
          return { ok: false, codigo, mensagem: codigo === "sem_permissao" ? "O usuário não tem permissão para isso. Recuse." : `Não foi possível preparar (${codigo}).`, semPermissao: codigo === "sem_permissao" ? (modulos.length ? modulos : [modulo]) : [] };
        }
        return {
          ok: true, fontes: [], rascunhoId: String(data),
          paraIa: { ...r.paraIa, rascunho_preparado: true, gravado: false, instrucao: "NADA foi gravado. Diga ao usuário para conferir o cartão e clicar em Confirmar (ou Editar/Descartar)." },
        };
      } catch (e) {
        if (e instanceof ErroAssistente) return { ok: false, codigo: e.codigo, mensagem: e.message, semPermissao: e.semPermissao };
        if (e instanceof z.ZodError) return { ok: false, codigo: "entrada_invalida", mensagem: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), semPermissao: [] };
        throw e;
      }
    },
  };
}

// Período relativo a hoje (Brasília): o assistente externo nem sempre sabe a data de hoje.
const PERIODOS = ["hoje", "semana", "proximos_7_dias", "mes"] as const;
type Periodo = (typeof PERIODOS)[number];
const propPeriodo = { type: "string", enum: PERIODOS, description: "Atalho de datas: hoje, semana (segunda a domingo desta semana), proximos_7_dias ou mes (este mês). Tem prioridade sobre de/ate." };

function somarDiasIso(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Datas [de, ate] do período, contadas a partir de `hoje` (AAAA-MM-DD). */
export function datasDoPeriodo(periodo: Periodo, hoje: string): { de: string; ate: string } {
  if (periodo === "hoje") return { de: hoje, ate: hoje };
  if (periodo === "proximos_7_dias") return { de: hoje, ate: somarDiasIso(hoje, 6) };
  if (periodo === "mes") {
    const [a, m] = hoje.split("-").map(Number);
    const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
    return { de: `${hoje.slice(0, 7)}-01`, ate: `${hoje.slice(0, 7)}-${String(ultimo).padStart(2, "0")}` };
  }
  const semana = new Date(`${hoje}T12:00:00Z`).getUTCDay(); // 0 = domingo
  const segunda = somarDiasIso(hoje, semana === 0 ? -6 : 1 - semana);
  return { de: segunda, ate: somarDiasIso(segunda, 6) };
}

const intervalo = (e: Record<string, unknown>, ctx: CtxFerramenta) =>
  e.periodo ? datasDoPeriodo(e.periodo as Periodo, ctx.contexto.hoje) : { de: (e.de as string | undefined) ?? null, ate: (e.ate as string | undefined) ?? null };

const AVISO_ESCRITA = "NÃO grava nada: prepara um rascunho que o usuário confirma num cartão.";

export const FERRAMENTAS: Ferramenta[] = [
  leitura("buscar_processos", "Procura processos do escritório por número, parte, título ou classe.", ["processos", "prazos"],
    { termo: propTermo, limite: propLimite }, z.object({ termo, limite }),
    "assistente_buscar_processos", (e) => ({ p_termo: e.termo ?? null, p_limite: e.limite ?? 10 })),
  leitura("buscar_clientes", "Procura clientes do escritório pelo nome. Não traz CPF/CNPJ.", ["processos"],
    { termo: propTermo, limite: propLimite }, z.object({ termo, limite }),
    "assistente_buscar_clientes", (e) => ({ p_termo: e.termo ?? null, p_limite: e.limite ?? 10 })),
  leitura("buscar_prazos", "Lista prazos (por padrão os abertos), ordenados pela data final.", ["prazos"],
    { termo: propTermo, periodo: propPeriodo, de: propDia("Data final a partir de"), ate: propDia("Data final até"),
      status: { type: "string", enum: ["aberto", "cumprido", "cancelado", "todos"] }, limite: propLimite },
    z.object({ termo, periodo: z.enum(PERIODOS).optional(), de: dia, ate: dia, status: z.enum(["aberto", "cumprido", "cancelado", "todos"]).optional(), limite }),
    "assistente_buscar_prazos", (e, ctx) => { const i = intervalo(e, ctx); return { p_termo: e.termo ?? null, p_de: i.de, p_ate: i.ate, p_status: e.status ?? "aberto", p_limite: e.limite ?? 10 }; }),
  leitura("buscar_tarefas", "Lista tarefas do quadro (por padrão as não concluídas).", ["tarefas"],
    { termo: propTermo, periodo: propPeriodo, de: propDia("Data a partir de"), ate: propDia("Data até"), incluir_concluidas: { type: "boolean" }, limite: propLimite },
    z.object({ termo, periodo: z.enum(PERIODOS).optional(), de: dia, ate: dia, incluir_concluidas: z.boolean().optional(), limite }),
    "assistente_buscar_tarefas", (e, ctx) => { const i = intervalo(e, ctx); return { p_termo: e.termo ?? null, p_de: i.de, p_ate: i.ate, p_incluir_concluidas: e.incluir_concluidas ?? false, p_limite: e.limite ?? 10 }; }),
  leitura("buscar_lancamentos", "Lista lançamentos financeiros (receitas e despesas) com parcelas, valores em aberto e atrasados. Valores em centavos.", ["financeiro"],
    { termo: propTermo, cliente_id: { type: "string", description: "Id do cliente (de buscar_clientes)" },
      situacao: { type: "string", enum: ["todos", "em_aberto", "atrasado", "pago", "cancelado"] }, limite: propLimite },
    z.object({ termo, cliente_id: z.uuid().optional(), situacao: z.enum(["todos", "em_aberto", "atrasado", "pago", "cancelado"]).optional(), limite }),
    "assistente_buscar_lancamentos", (e) => ({ p_termo: e.termo ?? null, p_cliente: e.cliente_id ?? null, p_situacao: e.situacao ?? "todos", p_limite: e.limite ?? 10 })),
  leitura("buscar_publicacoes", "Procura publicações/intimações capturadas do diário oficial (DJEN), com um trecho do texto.", ["processos", "prazos"],
    { termo: propTermo, de: propDia("Disponibilizada a partir de"), ate: propDia("Disponibilizada até"), limite: propLimite },
    z.object({ termo, de: dia, ate: dia, limite }),
    "assistente_buscar_publicacoes", (e) => ({ p_termo: e.termo ?? null, p_de: e.de ?? null, p_ate: e.ate ?? null, p_limite: e.limite ?? 10 })),

  escrita("preparar_lancamento", `Prepara um lançamento financeiro (receita ou despesa), parcelado ou não. ${AVISO_ESCRITA} `
    + "Informe valor_parcela_reais (ex.: '3 parcelas de R$ 1.000' = parcelas 3 e valor_parcela_reais 1000) OU valor_total_reais. O LAW faz a conta em centavos e acha o cliente pelo nome.",
    "lancamento", "financeiro", {
      tipo: { type: "string", enum: ["receita", "despesa"] },
      categoria: { type: "string", enum: ["honorarios_contratuais", "exito", "custas", "reembolso", "despesa_fixa", "outros"] },
      descricao: { type: "string" },
      cliente: { type: "string", description: "Nome do cliente como o usuário disse (ou id)." },
      processo: { type: "string", description: "Número do processo (ou id), opcional." },
      parcelas: { type: "integer", minimum: 1, maximum: 120 },
      valor_parcela_reais: { type: "number", description: "Valor de CADA parcela em reais (1000 = R$ 1.000,00)." },
      valor_total_reais: { type: "number", description: "Valor TOTAL em reais." },
      primeiro_vencimento: propDia("1º vencimento; só se o usuário disser"),
      data_competencia: propDia("Competência"),
    }, ["categoria"]),
  escrita("preparar_tarefa", `Prepara uma tarefa no quadro. ${AVISO_ESCRITA}`, "tarefa", "tarefas", {
    titulo: { type: "string" }, descricao: { type: "string" }, data: propDia("Data da tarefa"),
    responsavel: { type: "string", description: "Nome da pessoa da equipe; vazio = o próprio usuário." },
    processo: { type: "string" }, cliente: { type: "string" }, coluna: { type: "string" },
    etiquetas: { type: "array", items: { type: "string" } },
  }, ["titulo"]),
  escrita("preparar_prazo", `Prepara um prazo processual. ${AVISO_ESCRITA} A data final é calculada pelo LAW (calendário forense), nunca informe data final.`,
    "prazo", "prazos", {
      processo: { type: "string", description: "Número do processo (ou id)." },
      descricao: { type: "string" },
      dias: { type: "integer", minimum: 1, maximum: 365 },
      tipo_contagem: { type: "string", enum: ["util", "corrido"] },
      data_disponibilizacao: propDia("Data de disponibilização da publicação no diário"),
      publicacao_id: { type: "string", description: "Id da publicação (de buscar_publicacoes), se o prazo vem dela." },
      responsavel: { type: "string", description: "Nome; vazio = o próprio usuário." },
    }, ["processo", "descricao", "dias"]),
  escrita("preparar_minuta", `Prepara uma minuta de contrato a partir de um MODELO cadastrado pelo escritório (nunca escreva o contrato você mesmo). ${AVISO_ESCRITA}`,
    "minuta", "documentos", {
      modelo: { type: "string", description: "Nome do modelo (lista no contexto)." },
      cliente: { type: "string" }, processo: { type: "string" }, titulo: { type: "string" },
      campos: { type: "object", additionalProperties: { type: "string" }, description: "Valores para os campos {{...}} do modelo que o usuário informou. Não invente valores." },
    }, ["modelo"]),
];

export const ferramentaPorNome = (nome: string) => FERRAMENTAS.find((f) => f.definicao.name === nome);
export const definicoes = () => FERRAMENTAS.map((f) => f.definicao);
