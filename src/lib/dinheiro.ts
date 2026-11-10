/** Converte "1.500,50" / "1500.5" / "R$ 1.500" em centavos (inteiro). Nunca usa float para o resultado final. */
export function paraCentavos(valor: string): number | null {
  const limpo = valor.replace(/[^\d,.-]/g, "");
  if (!limpo) return null;
  let inteiro: string;
  let fracao = "00";
  if (limpo.includes(",")) {
    const [i, f = ""] = limpo.replace(/\./g, "").split(",");
    inteiro = i;
    fracao = (f + "00").slice(0, 2);
  } else if (/\.\d{1,2}$/.test(limpo)) {
    const [i, f] = limpo.split(".");
    inteiro = i;
    fracao = (f + "00").slice(0, 2);
  } else {
    inteiro = limpo.replace(/\./g, "");
  }
  if (!/^-?\d+$/.test(inteiro || "0") || !/^\d{2}$/.test(fracao)) return null;
  const negativo = inteiro.startsWith("-");
  const abs = Number(inteiro.replace("-", "") || "0") * 100 + Number(fracao);
  return negativo ? -abs : abs;
}

export function formatarCentavos(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
