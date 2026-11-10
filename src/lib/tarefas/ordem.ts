/**
 * Regra de ordem do quadro (mesma do banco, `mover_tarefa`): ao mover, a tarefa entra na coluna de destino
 * no índice pedido (0 = topo) e cada coluna é renumerada 1..n. A tela usa isto para mostrar o resultado na hora;
 * quem manda é o banco.
 */
export type ItemOrdenavel = { id: string; colunaId: string; posicao: number };

export function reordenar<T extends ItemOrdenavel>(itens: readonly T[], id: string, colunaId: string, indice: number): T[] {
  const alvo = itens.find((i) => i.id === id);
  if (!alvo) return [...itens];
  const porColuna = new Map<string, T[]>();
  for (const i of [...itens].sort((a, b) => a.posicao - b.posicao)) {
    if (i.id === id) continue;
    const lista = porColuna.get(i.colunaId) ?? [];
    lista.push(i);
    porColuna.set(i.colunaId, lista);
  }
  const destino = porColuna.get(colunaId) ?? [];
  const pos = Math.max(0, Math.min(Number.isFinite(indice) ? Math.trunc(indice) : 0, destino.length));
  destino.splice(pos, 0, { ...alvo, colunaId });
  porColuna.set(colunaId, destino);
  const saida: T[] = [];
  for (const lista of porColuna.values()) lista.forEach((i, n) => saida.push({ ...i, posicao: n + 1 }));
  return saida;
}

/** Itens de uma coluna na ordem salva. */
export function daColuna<T extends ItemOrdenavel>(itens: readonly T[], colunaId: string): T[] {
  return itens.filter((i) => i.colunaId === colunaId).sort((a, b) => a.posicao - b.posicao);
}

export type ItemChecklist = { id: string; texto: string; feito: boolean };

export function progressoChecklist(c: readonly ItemChecklist[]): { feitos: number; total: number } {
  return { feitos: c.filter((i) => i.feito).length, total: c.length };
}

/** "urgente, cliente x ,URGENTE" -> ["urgente","cliente x"] (sem repetir, ignorando maiúsculas; máx. 15 de 30 letras). */
export function lerEtiquetas(texto: string): string[] {
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const bruto of texto.split(",")) {
    const e = bruto.trim().slice(0, 30);
    if (!e || vistos.has(e.toLowerCase())) continue;
    vistos.add(e.toLowerCase());
    saida.push(e);
  }
  return saida.slice(0, 15);
}
