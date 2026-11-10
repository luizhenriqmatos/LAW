import { createHmac, timingSafeEqual } from "node:crypto";

/** Confere o cabeçalho X-Hub-Signature-256 da Meta: "sha256=" + HMAC-SHA256(corpo bruto, segredo do app). */
export function assinaturaValida(corpoBruto: string, cabecalho: string | null, segredoApp: string): boolean {
  if (!cabecalho || !segredoApp) return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(cabecalho.trim());
  if (!m) return false;
  const esperado = createHmac("sha256", segredoApp).update(corpoBruto, "utf8").digest();
  const recebido = Buffer.from(m[1], "hex");
  return recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
}

export function assinar(corpoBruto: string, segredoApp: string): string {
  return "sha256=" + createHmac("sha256", segredoApp).update(corpoBruto, "utf8").digest("hex");
}

/** Verificação do webhook (GET): devolve o desafio só se o token bater. */
export function desafioDeVerificacao(p: { modo: string | null; token: string | null; desafio: string | null }, tokenEsperado: string): string | null {
  if (p.modo !== "subscribe" || !p.token || !p.desafio || !tokenEsperado) return null;
  const a = Buffer.from(p.token);
  const b = Buffer.from(tokenEsperado);
  return a.length === b.length && timingSafeEqual(a, b) ? p.desafio : null;
}
