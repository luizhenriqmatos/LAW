import { createHash, createHmac, randomBytes } from "node:crypto";

/** Segredo aleatório (token, código, client_secret): 32 bytes em base64url = 43 caracteres. */
export const novoSegredo = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** O banco só guarda o SHA-256 (hex) de tokens, códigos e segredos. */
export const hashSegredo = (valor: string) => createHash("sha256").update(valor, "utf8").digest("hex");

/** PKCE S256 (RFC 7636): BASE64URL(SHA256(code_verifier)). */
export const desafioPkce = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");

/** code_verifier válido: 43 a 128 caracteres do conjunto [A-Z a-z 0-9 - . _ ~]. */
export const verifierValido = (v: string) => /^[A-Za-z0-9\-._~]{43,128}$/.test(v);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** JWT HS256 (para falar com o banco como o usuário; nunca sai do servidor do LAW). */
export function jwtHs256(payload: Record<string, unknown>, segredo: string): string {
  const corpo = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${corpo}.${createHmac("sha256", segredo).update(corpo).digest("base64url")}`;
}
