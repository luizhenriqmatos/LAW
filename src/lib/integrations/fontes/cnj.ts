/**
 * Número único de processo (Resolução CNJ 65/2008): NNNNNNN-DD.AAAA.J.TR.OOOO
 *  N = sequencial, DD = dígito verificador, AAAA = ano, J = segmento da Justiça, TR = tribunal, OOOO = origem.
 * Dígito verificador: módulo 97 (ISO 7064). O número inteiro NNNNNNNAAAAJTROOOODD deixa resto 1 na divisão por 97.
 */

/** Com máscara (separadores opcionais) ou 20 dígitos seguidos. Os grupos de captura não importam: validamos depois. */
const PADRAO_CNJ = /(?<![\d.-])(\d{7})-?(\d{2})\.?(\d{4})\.?(\d)\.?(\d{2})\.?(\d{4})(?![\d])/g;

/** Só os 20 dígitos, na ordem NNNNNNN DD AAAA J TR OOOO. Devolve null se não tiver 20 dígitos. */
export function somenteDigitosCnj(valor: string | null | undefined): string | null {
  const d = String(valor ?? "").replace(/\D/g, "");
  return d.length === 20 ? d : null;
}

/** Calcula o dígito verificador (DD) a partir do restante do número. */
export function calcularDigitoCnj(sequencial: string, ano: string, segmento: string, tribunal: string, origem: string): string {
  const base = BigInt(`${sequencial}${ano}${segmento}${tribunal}${origem}00`);
  const dd = BigInt(98) - (base % BigInt(97));
  return dd.toString().padStart(2, "0");
}

/** true se o número (com ou sem máscara) tem 20 dígitos e o dígito verificador confere. */
export function cnjValido(valor: string | null | undefined): boolean {
  const d = somenteDigitosCnj(valor);
  if (!d) return false;
  const n = d.slice(0, 7), dd = d.slice(7, 9), resto = d.slice(9);
  return BigInt(`${n}${resto}${dd}`) % BigInt(97) === BigInt(1);
}

/** Formata 20 dígitos como NNNNNNN-DD.AAAA.J.TR.OOOO. */
export function formatarCnj(valor: string): string {
  const d = somenteDigitosCnj(valor);
  if (!d) return valor;
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16, 20)}`;
}

/** Todos os números CNJ VÁLIDOS citados no texto, sem repetição, só dígitos, na ordem em que aparecem. */
export function extrairNumerosCnj(texto: string | null | undefined): string[] {
  const achados: string[] = [];
  for (const m of String(texto ?? "").matchAll(PADRAO_CNJ)) {
    const d = m.slice(1, 7).join("");
    if (cnjValido(d) && !achados.includes(d)) achados.push(d);
  }
  return achados;
}

/** Código da UF usado pela Justiça Estadual (TR) — Resolução CNJ 65/2008, anexo. */
const UF_POR_TR: Record<string, string> = {
  "01": "ac", "02": "al", "03": "ap", "04": "am", "05": "ba", "06": "ce", "07": "dft", "08": "es", "09": "go",
  "10": "ma", "11": "mt", "12": "ms", "13": "mg", "14": "pa", "15": "pb", "16": "pr", "17": "pe", "18": "pi",
  "19": "rj", "20": "rn", "21": "rs", "22": "ro", "23": "rr", "24": "sc", "25": "se", "26": "sp", "27": "to",
};

/**
 * Sigla do tribunal no DataJud (ex.: "tjba", "trt5", "trf1") a partir do número CNJ.
 * Devolve null quando o segmento não tem índice conhecido na API pública.
 */
export function tribunalDataJud(valor: string): string | null {
  const d = somenteDigitosCnj(valor);
  if (!d) return null;
  const j = d.slice(13, 14);
  const tr = d.slice(14, 16);
  const n = Number(tr);
  switch (j) {
    case "3": return "stj";
    case "4": return n >= 1 && n <= 6 ? `trf${n}` : null;
    case "5": return tr === "00" ? "tst" : n >= 1 && n <= 24 ? `trt${n}` : null;
    case "6": {
      if (tr === "00") return "tse";
      const uf = UF_POR_TR[tr];
      return uf ? `tre-${uf === "dft" ? "df" : uf}` : null;
    }
    case "7": return "stm";
    case "8": {
      const uf = UF_POR_TR[tr];
      return uf ? `tj${uf}` : null;
    }
    case "9": return ({ "13": "tjmmg", "21": "tjmrs", "26": "tjmsp" } as Record<string, string>)[tr] ?? null;
    default: return null; // 1 = STF, 2 = CNJ: fora da API pública do DataJud
  }
}
