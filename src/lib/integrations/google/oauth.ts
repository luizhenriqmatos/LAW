import { ErroGoogle } from "./erro";

/** Escopo mínimo: criar calendários secundários e mexer só nos eventos deles. Não lê a agenda pessoal. */
export const ESCOPO_GOOGLE = "https://www.googleapis.com/auth/calendar.app.created";

/** Escopo do Drive: o LAW só enxerga arquivos e pastas que ELE criou (nunca o resto do Drive do escritório). */
// PENDENCIA P-033: Drive API e escopo drive.file precisam estar ativos no Google Cloud.
export const ESCOPO_DRIVE = "https://www.googleapis.com/auth/drive.file";

/** Para que serve a conexão em andamento. Um único endereço de retorno (callback) atende os dois. */
export type PropositoGoogle = "agenda" | "drive";

/** Cookie (só HTTP, 10 min) com o state anti-CSRF, o escritório e o propósito (agenda|drive) da conexão em andamento. */
export const COOKIE_ESTADO = "google_oauth_estado";

const URL_AUTORIZACAO = "https://accounts.google.com/o/oauth2/v2/auth";
const URL_TOKEN = "https://oauth2.googleapis.com/token";
const URL_REVOGAR = "https://oauth2.googleapis.com/revoke";

export type ConfigGoogle = { clientId: string; clientSecret: string; redirectUri: string };
export type Fetch = typeof fetch;

/** PENDENCIA P-026: sem credenciais OAuth do Google Cloud a conexão fica desligada (o resto do LAW funciona). */
export function configGoogle(urlBase: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): ConfigGoogle | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret || !urlBase) return null;
  return { clientId, clientSecret, redirectUri: `${urlBase.replace(/\/+$/, "")}/api/google/callback` };
}

export function urlAutorizacao(cfg: ConfigGoogle, state: string, escopo: string = ESCOPO_GOOGLE): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: escopo,
    access_type: "offline", // devolve o refresh token
    prompt: "consent", // garante o refresh token mesmo em reconexão
    include_granted_scopes: "false",
    state,
  });
  return `${URL_AUTORIZACAO}?${p.toString()}`;
}

export type Tokens = { accessToken: string; refreshToken: string | null; expiraEm: Date; escopo: string };

async function pedirToken(corpo: Record<string, string>, f: Fetch, agora: Date): Promise<Tokens> {
  let res: Response;
  try {
    res = await f(URL_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(corpo).toString(),
    });
  } catch {
    throw new ErroGoogle("indisponivel", "Sem resposta do Google.");
  }
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string;
  };
  if (!res.ok || !json.access_token) {
    if (json.error === "invalid_grant" || json.error === "invalid_client" || json.error === "unauthorized_client") {
      throw new ErroGoogle("revogado", "O Google recusou o acesso (revogado ou expirado).");
    }
    throw new ErroGoogle(res.status >= 500 ? "indisponivel" : "outro", `Google recusou o pedido de token (${res.status}).`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiraEm: new Date(agora.getTime() + (json.expires_in ?? 3600) * 1000),
    escopo: json.scope ?? "",
  };
}

export function trocarCodigo(cfg: ConfigGoogle, code: string, f: Fetch = fetch, agora = new Date()) {
  return pedirToken(
    { code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code" },
    f, agora,
  );
}

export function renovarAcesso(cfg: ConfigGoogle, refreshToken: string, f: Fetch = fetch, agora = new Date()) {
  return pedirToken(
    { refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "refresh_token" },
    f, agora,
  );
}

/** Ao desconectar: pede ao Google para invalidar o token. Melhor esforço (nunca quebra a desconexão). */
export async function revogarToken(token: string, f: Fetch = fetch): Promise<boolean> {
  try {
    const res = await f(URL_REVOGAR, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}
