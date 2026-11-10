/**
 * Configuração do servidor OAuth 2.1 + MCP do LAW (Prompt 12).
 * PENDENCIA P-072: NEXT_PUBLIC_SITE_URL real (HTTPS) — o endereço do conector e o "issuer" saem dele.
 */
export const ESCOPOS = {
  "law.read": "Ler processos, clientes, prazos, tarefas, lançamentos e publicações que você pode ver",
  "law.write": "Criar lançamentos, tarefas, prazos e minutas em seu nome (cada uma com a sua aprovação no assistente)",
} as const;
export type Escopo = keyof typeof ESCOPOS;
export const TODOS_ESCOPOS = Object.keys(ESCOPOS) as Escopo[];

export const TEMPO_ACESSO_SEG = 3600; // 1 hora
export const TEMPO_REFRESH_SEG = 30 * 24 * 3600; // 30 dias, com rotação a cada uso
export const LIMITE_POR_MINUTO = 60; // por token de acesso
export const LIMITE_POR_DIA = 2000; // chamadas de ferramenta por concessão
export const TEMPO_JWT_SEG = 300; // JWT interno usuário->banco

/** Endereço público do LAW sem barra no fim; null se não configurado ou não for https (exceto localhost). */
export function urlBase(valor: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): string | null {
  const v = (valor ?? "").trim().replace(/\/+$/, "");
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export const recursoMcp = (base: string) => `${base}/api/mcp`;
export const urlMetadadosRecurso = (base: string) => `${base}/.well-known/oauth-protected-resource/api/mcp`;

/** RFC 9728: metadados do recurso protegido (o servidor MCP). */
export function metadadosRecurso(base: string) {
  return {
    resource: recursoMcp(base),
    authorization_servers: [base],
    scopes_supported: TODOS_ESCOPOS,
    bearer_methods_supported: ["header"],
    resource_name: "LAW",
    resource_documentation: `${base}/app/conexoes`,
  };
}

/** RFC 8414: metadados do servidor de autorização. */
export function metadadosServidor(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/autorizar`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    scopes_supported: TODOS_ESCOPOS,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/app/conexoes`,
  };
}

/** Cabeçalhos dos endpoints públicos do OAuth (sem cookie; podem ser chamados do navegador do cliente). */
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
};
