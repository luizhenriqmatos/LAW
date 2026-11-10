import { z } from "zod";
import { CORS, recursoMcp, TEMPO_ACESSO_SEG, TEMPO_REFRESH_SEG } from "./config";
import { desafioPkce, hashSegredo, novoSegredo, verifierValido } from "./cripto";

/**
 * Endpoints OAuth 2.1 do LAW (registro dinâmico, token, revogação). Toda regra de validade (código de uso único,
 * PKCE, cliente, rotação do refresh) está no banco; aqui só lemos a requisição, geramos segredos e respondemos.
 */
// PENDENCIA P-073: registro de cliente aberto e endpoints sem limite por IP.
export type RpcServico = <T>(funcao: string, args: Record<string, unknown>) => Promise<T>;
export type DepsOAuth = { rpc: RpcServico; base: string };

const json = (corpo: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...CORS, ...extra },
  });
const erro = (codigo: string, descricao: string, status = 400) =>
  json({ error: codigo, error_description: descricao }, status, status === 401 ? { "WWW-Authenticate": 'Basic realm="LAW"' } : {});

/** Código de erro do banco dentro da mensagem do cliente de serviço ("Banco recusou f: invalid_grant"). */
const codigoBanco = (e: unknown) => (e instanceof Error ? e.message : String(e)).match(/[a-z_]{4,}$/)?.[0] ?? "";

async function lerCorpo(req: Request): Promise<Record<string, string>> {
  const tipo = req.headers.get("content-type") ?? "";
  if (tipo.includes("application/json")) {
    const j = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    return Object.fromEntries(Object.entries(j ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  return Object.fromEntries(new URLSearchParams(await req.text()));
}

/** client_id/client_secret pelo cabeçalho Basic ou pelo corpo (client_secret_post). */
function credenciais(req: Request, corpo: Record<string, string>): { id: string | null; segredoHash: string | null } {
  const basic = req.headers.get("authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) {
    const [id, segredo] = Buffer.from(basic, "base64").toString("utf8").split(":").map((x) => decodeURIComponent(x ?? ""));
    return { id: id || null, segredoHash: segredo ? hashSegredo(segredo) : null };
  }
  return { id: corpo.client_id || null, segredoHash: corpo.client_secret ? hashSegredo(corpo.client_secret) : null };
}

// ---- RFC 7591: registro dinâmico de cliente

const Registro = z.object({
  redirect_uris: z.array(z.string().max(500)).min(1).max(10),
  client_name: z.string().max(100).optional(),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).default("none"),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
}).loose();

export async function registrarCliente(req: Request, deps: DepsOAuth): Promise<Response> {
  const r = Registro.safeParse(await req.json().catch(() => null));
  if (!r.success) return erro("invalid_client_metadata", "Envie redirect_uris (1 a 10 endereços).");
  const d = r.data;
  if (d.grant_types && !d.grant_types.includes("authorization_code")) return erro("invalid_client_metadata", "grant_types precisa incluir authorization_code.");
  if (d.response_types && d.response_types.some((t) => t !== "code")) return erro("invalid_client_metadata", "Só response_type=code.");
  const segredo = d.token_endpoint_auth_method === "none" ? null : novoSegredo();
  try {
    const c = await deps.rpc<{ client_id: string; escopos: string[]; nome: string; redirect_uris: string[]; metodo_auth: string; criado_em: number }>(
      "oauth_cliente_registrar", { p_nome: d.client_name ?? null, p_redirect_uris: d.redirect_uris, p_metodo: d.token_endpoint_auth_method, p_segredo_hash: segredo ? hashSegredo(segredo) : null });
    return json({
      client_id: c.client_id, ...(segredo ? { client_secret: segredo, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: c.criado_em, client_name: c.nome, redirect_uris: c.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: c.metodo_auth, scope: c.escopos.join(" "),
    }, 201);
  } catch (e) {
    if (codigoBanco(e) === "redirect_uri_invalida") return erro("invalid_redirect_uri", "Endereço de retorno precisa ser https (ou http://localhost).");
    throw e;
  }
}

// ---- Token

function respostaToken(acesso: string, refresh: string, r: { escopos: string[]; expires_in: number; erro?: string }) {
  if (r.erro) return erro("invalid_grant", "Código ou token inválido, vencido ou já usado.");
  return json({ access_token: acesso, token_type: "Bearer", expires_in: r.expires_in, refresh_token: refresh, scope: r.escopos.join(" ") });
}

export async function emitirToken(req: Request, deps: DepsOAuth): Promise<Response> {
  const corpo = await lerCorpo(req);
  const cli = credenciais(req, corpo);
  if (!cli.id) return erro("invalid_client", "Informe client_id.", 401);
  const acesso = novoSegredo();
  const refresh = novoSegredo();
  try {
    if (corpo.grant_type === "authorization_code") {
      if (!corpo.code || !corpo.redirect_uri || !corpo.code_verifier) return erro("invalid_request", "Faltam code, redirect_uri ou code_verifier.");
      if (!verifierValido(corpo.code_verifier)) return erro("invalid_grant", "code_verifier inválido.");
      if (corpo.resource && corpo.resource.replace(/\/+$/, "") !== recursoMcp(deps.base)) return erro("invalid_target", "Recurso desconhecido.");
      const r = await deps.rpc<{ escopos: string[]; expires_in: number; erro?: string }>("oauth_trocar_codigo", {
        p_code_hash: hashSegredo(corpo.code), p_cliente: cli.id, p_redirect_uri: corpo.redirect_uri, p_challenge_calculado: desafioPkce(corpo.code_verifier),
        p_segredo_hash: cli.segredoHash, p_recurso: corpo.resource ? recursoMcp(deps.base) : null,
        p_acesso_hash: hashSegredo(acesso), p_refresh_hash: hashSegredo(refresh), p_acesso_seg: TEMPO_ACESSO_SEG, p_refresh_seg: TEMPO_REFRESH_SEG,
      });
      return respostaToken(acesso, refresh, r);
    }
    if (corpo.grant_type === "refresh_token") {
      if (!corpo.refresh_token) return erro("invalid_request", "Falta refresh_token.");
      const r = await deps.rpc<{ escopos: string[]; expires_in: number; erro?: string }>("oauth_renovar", {
        p_refresh_hash: hashSegredo(corpo.refresh_token), p_cliente: cli.id, p_segredo_hash: cli.segredoHash,
        p_acesso_hash: hashSegredo(acesso), p_refresh_hash_novo: hashSegredo(refresh), p_acesso_seg: TEMPO_ACESSO_SEG, p_refresh_seg: TEMPO_REFRESH_SEG,
      });
      return respostaToken(acesso, refresh, r);
    }
    return erro("unsupported_grant_type", "Use authorization_code ou refresh_token.");
  } catch (e) {
    const c = codigoBanco(e);
    if (c === "invalid_client") return erro("invalid_client", "Cliente inválido.", 401);
    if (c === "invalid_grant") return erro("invalid_grant", "Código ou token inválido, vencido ou já usado.");
    throw e;
  }
}

// ---- RFC 7009: revogação (responde 200 mesmo para token desconhecido)

export async function revogarToken(req: Request, deps: DepsOAuth): Promise<Response> {
  const corpo = await lerCorpo(req);
  const cli = credenciais(req, corpo);
  if (corpo.token && cli.id) await deps.rpc("oauth_revogar_token", { p_hash: hashSegredo(corpo.token), p_cliente: cli.id });
  return new Response(null, { status: 200, headers: { ...CORS, "Cache-Control": "no-store" } });
}
