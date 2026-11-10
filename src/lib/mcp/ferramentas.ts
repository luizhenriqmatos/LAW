import { FERRAMENTAS, type CtxFerramenta, type ResultadoFerramenta } from "@/lib/assistente/ferramentas";
import type { TipoRascunho } from "@/lib/assistente/tipos";
import type { Escopo } from "@/lib/oauth/config";
import { executarEscrita } from "./escrita";

/**
 * Ferramentas expostas pelo conector MCP: as MESMAS do Prompt 11.
 *  - Leitura (law.read): buscar_* , marcadas readOnlyHint.
 *  - Escrita (law.write): criar_* / gerar_minuta, marcadas destructiveHint para o assistente pedir aprovação a cada chamada.
 */
export type AnotacoesMcp = { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
export type FerramentaMcp = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: AnotacoesMcp;
  escopo: Escopo;
  executar: (ctx: CtxFerramenta, entrada: unknown) => Promise<ResultadoFerramenta>;
};

const TITULOS: Record<string, string> = {
  buscar_processos: "Buscar processos", buscar_clientes: "Buscar clientes", buscar_prazos: "Listar prazos",
  buscar_tarefas: "Listar tarefas", buscar_lancamentos: "Buscar lançamentos financeiros", buscar_publicacoes: "Buscar publicações",
};

const leitura: FerramentaMcp[] = FERRAMENTAS.filter((f) => f.tipo === "leitura").map((f) => ({
  name: f.definicao.name,
  title: TITULOS[f.definicao.name] ?? f.definicao.name,
  description: `${f.definicao.description} Só leitura. Cada item traz "link" para abrir no LAW.`,
  inputSchema: f.definicao.input_schema,
  annotations: { title: TITULOS[f.definicao.name] ?? f.definicao.name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  escopo: "law.read",
  executar: (ctx, entrada) => f.executar(ctx, entrada),
}));

// PENDENCIA P-072: a aprovação a cada gravação depende do assistente respeitar destructiveHint (conferir ao vivo).
const ESCRITA: { nome: string; titulo: string; tipo: TipoRascunho; de: string; descricao: string }[] = [
  { nome: "criar_lancamento", titulo: "Criar lançamento financeiro", tipo: "lancamento", de: "preparar_lancamento",
    descricao: "GRAVA um lançamento (receita ou despesa) no financeiro do LAW. Para '3 parcelas de R$ 1.000' use parcelas=3 e valor_parcela_reais=1000; o LAW faz a conta em centavos e acha o cliente pelo nome." },
  { nome: "criar_tarefa", titulo: "Criar tarefa", tipo: "tarefa", de: "preparar_tarefa",
    descricao: "GRAVA uma tarefa no quadro do LAW (responsável vazio = o próprio usuário; data AAAA-MM-DD)." },
  { nome: "criar_prazo", titulo: "Criar prazo", tipo: "prazo", de: "preparar_prazo",
    descricao: "GRAVA um prazo processual. A data final é calculada pelo LAW pelo calendário forense e devolvida na resposta; confira no sistema oficial do tribunal." },
  { nome: "gerar_minuta", titulo: "Gerar minuta de contrato", tipo: "minuta", de: "preparar_minuta",
    descricao: "GRAVA uma minuta a partir de um MODELO cadastrado pelo escritório. Nasce NÃO REVISADA. Não invente valores de campos." },
];

const escrita: FerramentaMcp[] = ESCRITA.map((e) => {
  const base = FERRAMENTAS.find((f) => f.definicao.name === e.de)!;
  return {
    name: e.nome,
    title: e.titulo,
    description: `${e.descricao} Peça a confirmação do usuário antes de chamar.`,
    inputSchema: base.definicao.input_schema,
    annotations: { title: e.titulo, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    escopo: "law.write",
    executar: (ctx, entrada) => executarEscrita(e.tipo, entrada, ctx),
  };
});

export const FERRAMENTAS_MCP: FerramentaMcp[] = [...leitura, ...escrita];

export const ferramentasDoEscopo = (escopos: readonly string[]) => FERRAMENTAS_MCP.filter((f) => escopos.includes(f.escopo));
