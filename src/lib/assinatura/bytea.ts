/**
 * O Postgres entrega bytea como texto hexadecimal "\x2550..." (pela API) ou como bytes (no teste com PGlite).
 * E recebe bytea como o mesmo texto.
 */
export function bytesDeBytea(valor: unknown): Uint8Array {
  if (valor instanceof Uint8Array) return valor;
  if (typeof valor === "string" && /^\\x([0-9a-fA-F]{2})*$/.test(valor)) return Uint8Array.from(Buffer.from(valor.slice(2), "hex"));
  throw new Error("Valor bytea inválido.");
}

export function byteaDeBytes(bytes: Uint8Array): string {
  return `\\x${Buffer.from(bytes).toString("hex")}`;
}
