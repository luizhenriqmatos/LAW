/**
 * Campos do cartão de rascunho a partir do que a Lia preparou (o que o Confirmar envia se ninguém editar).
 * Usado pelo cartão na tela e pelo conector MCP, que confirma sem cartão (a aprovação é feita no próprio assistente).
 */
type Tipo = "lancamento" | "tarefa" | "prazo" | "minuta";

const txt = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const reaisTexto = (c: unknown) => (typeof c === "number" ? (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "");

export function formularioDoRascunho(tipo: Tipo, d: Record<string, unknown>): Record<string, string> {
  if (tipo === "lancamento") {
    return {
      tipo: txt(d.tipo), categoria: txt(d.categoria), descricao: txt(d.descricao), cliente_id: txt(d.cliente_id), processo_id: txt(d.processo_id),
      valor_total: reaisTexto(d.valor_centavos), parcelas: txt(d.parcelas), primeiro_vencimento: txt(d.primeiro_vencimento), data_competencia: txt(d.data_competencia),
    };
  }
  if (tipo === "tarefa") {
    return {
      titulo: txt(d.titulo), descricao: txt(d.descricao), data: txt(d.data), responsavel_id: txt(d.responsavel_id), coluna_id: txt(d.coluna_id),
      processo_id: txt(d.processo_id), cliente_id: txt(d.cliente_id), etiquetas: Array.isArray(d.etiquetas) ? d.etiquetas.join(", ") : "",
    };
  }
  if (tipo === "prazo") return { descricao: txt(d.descricao), responsavel_id: txt(d.responsavel_id), esperada: txt(d.data_final) };
  const campos = (d.campos ?? {}) as Record<string, string>;
  const manuais = ((d._exibir as Record<string, unknown> | undefined)?.campos_manuais ?? Object.keys(campos)) as string[];
  return { titulo: txt(d.titulo), ...Object.fromEntries(manuais.map((c) => [`campo_${c}`, campos[c] ?? ""])) };
}
