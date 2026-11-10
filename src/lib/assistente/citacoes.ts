import type { Fonte } from "./tipos";

/**
 * Transforma a resposta da IA em pedaços para a tela. Link só vira link se for EXATAMENTE um dos links que as
 * ferramentas devolveram nesta resposta (a IA não consegue inventar destino). Link desconhecido vira texto simples.
 */
export type Pedaco = { tipo: "texto"; texto: string } | { tipo: "link"; texto: string; href: string };

const LINK = /\[([^\]\n]{1,300})\]\(([^)\s]{1,300})\)/g;

export function segmentarLinha(linha: string, fontes: Fonte[]): Pedaco[] {
  const permitidos = new Set(fontes.map((f) => f.link));
  const pedacos: Pedaco[] = [];
  let ultimo = 0;
  for (const m of linha.matchAll(LINK)) {
    if (m.index > ultimo) pedacos.push({ tipo: "texto", texto: linha.slice(ultimo, m.index) });
    const [, texto, href] = m;
    pedacos.push(permitidos.has(href) ? { tipo: "link", texto, href } : { tipo: "texto", texto });
    ultimo = m.index + m[0].length;
  }
  if (ultimo < linha.length) pedacos.push({ tipo: "texto", texto: linha.slice(ultimo) });
  return pedacos.filter((p) => p.texto.length > 0);
}

/** Fontes de fato citadas no texto (na ordem em que aparecem). */
export function fontesCitadas(texto: string, fontes: Fonte[]): Fonte[] {
  const porLink = new Map(fontes.map((f) => [f.link, f]));
  const vistas = new Map<string, Fonte>();
  for (const m of texto.matchAll(LINK)) {
    const f = porLink.get(m[2]);
    if (f && !vistas.has(f.link)) vistas.set(f.link, f);
  }
  return [...vistas.values()];
}
