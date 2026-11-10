/**
 * Sugestão de mesclagem de clientes: mesmo CPF/CNPJ ou nome muito parecido.
 * Só SUGERE — quem decide é o usuário.
 */
import { soDigitos } from "@/lib/validacao";

/** Mesma regra de public.normalizar_nome(): sem acento, minúsculo, só letras/números. */
export function normalizarNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Palavras que não ajudam a distinguir pessoas/empresas.
const IGNORAR = new Set(["da", "de", "do", "das", "dos", "e", "ltda", "me", "epp", "eireli", "sa", "s", "a", "cia", "filho", "junior", "jr", "neto"]);

/** Palavras que contam para a comparação. */
export function palavrasRelevantes(nome: string): string[] {
  return normalizarNome(nome)
    .split(" ")
    .filter((p) => p && !IGNORAR.has(p));
}

function trigramas(texto: string): Set<string> {
  const t = `  ${texto} `;
  const s = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) s.add(t.slice(i, i + 3));
  return s;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let comum = 0;
  for (const x of a) if (b.has(x)) comum++;
  return (2 * comum) / (a.size + b.size);
}

/** 0 a 1. Considera grafias parecidas (Souza/Sousa) e ignora "da", "de", "Ltda" etc. */
export function similaridadeNomes(a: string, b: string): number {
  const pa = palavrasRelevantes(a);
  const pb = palavrasRelevantes(b);
  if (!pa.length || !pb.length) return 0;
  const ja = pa.join(" ");
  const jb = pb.join(" ");
  if (ja === jb) return 1;
  // Mesmas palavras em outra ordem ("Silva João" x "João Silva").
  const ordenadas = (p: string[]) => [...p].sort().join(" ");
  if (ordenadas(pa) === ordenadas(pb)) return 0.95;
  return dice(trigramas(ja), trigramas(jb));
}

export const LIMIAR_NOME_PARECIDO = 0.75;

export type ClienteComparavel = { id: string; nome: string; documento: string | null };
export type Sugestao<T extends ClienteComparavel> = { cliente: T; motivo: "documento" | "nome"; pontuacao: number };

/** Até `max` clientes confirmados que podem ser a mesma pessoa. Documento igual vem primeiro. */
export function sugerirMesclagem<T extends ClienteComparavel>(
  alvo: { nome: string; documento: string | null },
  confirmados: T[],
  max = 3,
): Sugestao<T>[] {
  const doc = alvo.documento ? soDigitos(alvo.documento) : "";
  const lista: Sugestao<T>[] = [];
  for (const c of confirmados) {
    if (doc && c.documento && soDigitos(c.documento) === doc) {
      lista.push({ cliente: c, motivo: "documento", pontuacao: 1.01 });
      continue;
    }
    const p = similaridadeNomes(alvo.nome, c.nome);
    if (p >= LIMIAR_NOME_PARECIDO) lista.push({ cliente: c, motivo: "nome", pontuacao: p });
  }
  return lista.sort((x, y) => y.pontuacao - x.pontuacao).slice(0, max);
}
