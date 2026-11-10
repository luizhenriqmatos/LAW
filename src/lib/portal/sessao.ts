import "server-only";
import { cookies, headers } from "next/headers";
import { hashDoToken, ipDaRequisicao, tokenComFormatoValido } from "./token";

/** Cookie da sessão do portal: só o servidor lê (httpOnly), só por HTTPS em produção, só nas rotas /portal. */
export const COOKIE_PORTAL = "portal_sessao";

export async function guardarSessao(token: string, expiraEm: Date) {
  (await cookies()).set(COOKIE_PORTAL, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/portal",
    expires: expiraEm,
  });
}

export async function esquecerSessao() {
  (await cookies()).delete({ name: COOKIE_PORTAL, path: "/portal" });
}

/** Hash da sessão do cookie (o token em si nunca vai ao banco). null = sem cookie ou cookie com formato estranho. */
export async function hashDaSessao(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE_PORTAL)?.value;
  return tokenComFormatoValido(token) ? hashDoToken(token) : null;
}

export async function ipAtual(): Promise<string | null> {
  return ipDaRequisicao(await headers());
}

export async function agenteAtual(): Promise<string | null> {
  return (await headers()).get("user-agent");
}
