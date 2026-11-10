import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Cifra tokens do Google antes de gravar no banco (AES-256-GCM: cifra e ainda detecta adulteração).
 * Formato guardado: v1:<iv>:<tag>:<texto cifrado>, tudo em base64.
 * A chave (GOOGLE_TOKEN_KEY, 32 bytes em base64) fica só no ambiente do servidor.
 * PENDENCIA P-029: migrar para o Supabase Vault quando o projeto Supabase existir.
 */
export function chaveDoAmbiente(valor = process.env.GOOGLE_TOKEN_KEY): Buffer {
  const chave = Buffer.from(valor ?? "", "base64");
  if (chave.length !== 32) throw new Error("GOOGLE_TOKEN_KEY ausente ou inválida (precisa de 32 bytes em base64).");
  return chave;
}

export function cifrar(texto: string, chave: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chave, iv);
  const cifrado = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), cifrado.toString("base64")].join(":");
}

export function decifrar(valor: string, chave: Buffer): string {
  const [versao, iv, tag, cifrado] = valor.split(":");
  if (versao !== "v1" || !iv || !tag || !cifrado) throw new Error("Token cifrado em formato desconhecido.");
  const d = createDecipheriv("aes-256-gcm", chave, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(cifrado, "base64")), d.final()]).toString("utf8");
}
