import { hashSegredo } from "@/lib/oauth/cripto";
import { TODOS_ESCOPOS, urlMetadadosRecurso } from "@/lib/oauth/config";
import { erroRpc, tratarMcp, VERSOES_MCP, type SessaoMcp } from "./protocolo";

/**
 * Transporte HTTP do MCP (Streamable HTTP, só respostas JSON). Cada requisição confere o token no banco,
 * então revogar na tela Conexões corta o acesso na próxima chamada.
 */
export type Autenticado = { usuario_id: string; escritorio_id: string; concessao_id: string; escopos: string[]; conversa_id: string; cliente: string; perfil: string };
export type DepsHttpMcp = {
  base: string | null;
  autenticar: (hashToken: string) => Promise<Autenticado>;
  sessao: (a: Autenticado, base: string) => SessaoMcp;
  /** Origens de navegador aceitas (proteção contra DNS rebinding). Sem cabeçalho Origin = chamada de servidor. */
  origens: string[];
};

const json = (corpo: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(corpo === null ? null : JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });

export async function atenderMcp(req: Request, deps: DepsHttpMcp): Promise<Response> {
  if (!deps.base) return json({ error: "servidor_nao_configurado" }, 503);
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const origem = req.headers.get("origin");
  if (origem && !deps.origens.includes(origem) && origem !== deps.base) return json({ error: "origem_nao_permitida" }, 403);
  const versao = req.headers.get("mcp-protocol-version");
  if (versao && !(VERSOES_MCP as readonly string[]).includes(versao)) return json(erroRpc(null, -32600, `Versão do protocolo não suportada: ${versao}`), 400);

  const desafio = `Bearer resource_metadata="${urlMetadadosRecurso(deps.base)}", scope="${TODOS_ESCOPOS.join(" ")}"`;
  const token = req.headers.get("authorization")?.match(/^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i)?.[1];
  if (!token) return json({ error: "invalid_token", error_description: "Conecte o LAW (OAuth)." }, 401, { "WWW-Authenticate": desafio });

  let a: Autenticado;
  try {
    a = await deps.autenticar(hashSegredo(token));
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.includes("limite_excedido")) return json({ error: "rate_limited", error_description: "Muitas chamadas. Espere um minuto." }, 429, { "Retry-After": "60" });
    if (m.includes("sem_permissao") || m.includes("conectores_desligados")) {
      return json({ error: "insufficient_scope", error_description: m.includes("conectores_desligados") ? "O dono do escritório desligou os conectores." : "Você não tem mais acesso à assistente de IA neste escritório." }, 403,
        { "WWW-Authenticate": `${desafio}, error="insufficient_scope"` });
    }
    if (m.includes("token_invalido")) return json({ error: "invalid_token", error_description: "Acesso revogado ou vencido. Conecte de novo." }, 401, { "WWW-Authenticate": `${desafio}, error="invalid_token"` });
    throw e;
  }

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return json(erroRpc(null, -32700, "JSON inválido."), 400);
  }
  const r = await tratarMcp(corpo, deps.sessao(a, deps.base));
  return r === null ? new Response(null, { status: 202 }) : json(r);
}
