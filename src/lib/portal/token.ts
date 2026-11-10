import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";

/** Quanto tempo o link do e-mail vale. Mesmo valor do default de portal_link.expira_em no banco (que é quem decide). */
export const VALIDADE_LINK_MINUTOS = 30;
/** Quanto tempo a sessão do portal vale. Mesmo valor do default de portal_sessao.expira_em. */
export const VALIDADE_SESSAO_DIAS = 7;

/** Token aleatório de 32 bytes (256 bits), em base64url: 43 caracteres. Só o SHA-256 dele vai para o banco. */
export function novoToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDoToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Barra lixo antes de ir ao banco. Não é a segurança (a segurança é o token ser impossível de adivinhar). */
export function tokenComFormatoValido(token: string | null | undefined): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/**
 * IP de quem chamou. Na Vercel o `x-forwarded-for` é sobrescrito pela própria Vercel, então o primeiro valor é confiável.
 * Fora da Vercel (proxy próprio) quem monta o ambiente precisa garantir o mesmo. Valor que não é IP vira null.
 */
export function ipDaRequisicao(h: { get(nome: string): string | null }): string | null {
  const bruto = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "";
  return isIP(bruto) ? bruto : null;
}
