import { createHash } from "node:crypto";

const ENTIDADES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ordm: "º", ordf: "ª", sect: "§", deg: "°",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  atilde: "ã", otilde: "õ", Atilde: "Ã", Otilde: "Õ", acirc: "â", ecirc: "ê", ocirc: "ô", Acirc: "Â", Ecirc: "Ê", Ocirc: "Ô",
  agrave: "à", Agrave: "À", ccedil: "ç", Ccedil: "Ç", uuml: "ü", Uuml: "Ü", ndash: "–", mdash: "—", hellip: "…",
  laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
};

function decodificarEntidades(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (inteira, corpo: string) => {
    if (corpo[0] === "#") {
      const cod = corpo[1].toLowerCase() === "x" ? parseInt(corpo.slice(2), 16) : parseInt(corpo.slice(1), 10);
      return Number.isFinite(cod) && cod > 0 && cod < 0x110000 ? String.fromCodePoint(cod) : "";
    }
    return ENTIDADES[corpo] ?? inteira;
  });
}

/**
 * Converte o HTML da comunicação em texto puro, seguro para exibir: remove script/style, todas as tags e atributos.
 * O texto do DJEN chega como HTML; nunca renderizar o original na tela.
 */
export function htmlParaTexto(html: string | null | undefined): string {
  let s = String(html ?? "");
  s = s.replace(/<(script|style|head)[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n");
  s = s.replace(/<[^>]*>/g, " ");
  s = decodificarEntidades(s);
  s = s.replace(/<[^>]*>/g, " "); // tags que estavam codificadas como &lt;...&gt;
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .trim();
}

/** Forma usada só para comparar textos: minúsculas, sem acento, espaços colapsados. */
export function normalizarParaComparar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Hash de deduplicação: tribunal + número do processo + data de disponibilização + texto normalizado. */
export function hashPublicacao(p: { tribunal: string; numeroCnj: string | null; dataDisponibilizacao: string; texto: string }): string {
  const chave = [p.tribunal.toUpperCase(), p.numeroCnj ?? "", p.dataDisponibilizacao, normalizarParaComparar(p.texto)].join("|");
  return createHash("sha256").update(chave, "utf8").digest("hex");
}
