import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { datasDoPeriodo } from "@/lib/assistente/ferramentas";
import { FERRAMENTAS_MCP, ferramentasDoEscopo } from "@/lib/mcp/ferramentas";
import { atenderMcp, type Autenticado, type DepsHttpMcp } from "@/lib/mcp/http";
import { absolutizar, tratarMcp, type SessaoMcp } from "@/lib/mcp/protocolo";
import { metadadosRecurso, metadadosServidor, urlBase } from "@/lib/oauth/config";
import { desafioPkce, hashSegredo, jwtHs256, novoSegredo, verifierValido } from "@/lib/oauth/cripto";

const BASE = "https://app.law.test";

describe("Cripto do OAuth", () => {
  it("PKCE S256 = BASE64URL(SHA-256(verifier)), sem '=' no fim", () => {
    const v = "a".repeat(43) + "-._~";
    expect(desafioPkce(v)).toBe(createHash("sha256").update(v).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    expect(desafioPkce(v)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("verifier: 43 a 128 caracteres permitidos", () => {
    expect(verifierValido("a".repeat(43))).toBe(true);
    expect(verifierValido("a".repeat(42))).toBe(false);
    expect(verifierValido("a".repeat(129))).toBe(false);
    expect(verifierValido(`${"a".repeat(42)}!`)).toBe(false);
  });
  it("segredo aleatório de 256 bits e hash hex", () => {
    const s = novoSegredo();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(novoSegredo()).not.toBe(s);
    expect(hashSegredo("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("JWT HS256 com assinatura conferível e claim de canal", () => {
    const t = jwtHs256({ sub: "u1", role: "authenticated", law_canal: "mcp" }, "segredo");
    const [h, p, a] = t.split(".");
    expect(createHmac("sha256", "segredo").update(`${h}.${p}`).digest("base64url")).toBe(a);
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toMatchObject({ sub: "u1", law_canal: "mcp" });
  });
});

describe("Metadados OAuth (descoberta automática pelo Claude/ChatGPT)", () => {
  it("recurso protegido e servidor de autorização", () => {
    expect(metadadosRecurso(BASE)).toMatchObject({ resource: `${BASE}/api/mcp`, authorization_servers: [BASE], scopes_supported: ["law.read", "law.write"] });
    expect(metadadosServidor(BASE)).toMatchObject({
      issuer: BASE, authorization_endpoint: `${BASE}/oauth/autorizar`, token_endpoint: `${BASE}/api/oauth/token`,
      registration_endpoint: `${BASE}/api/oauth/register`, code_challenge_methods_supported: ["S256"],
    });
  });
  it("endereço base exige https (exceto localhost)", () => {
    expect(urlBase("https://app.law.com.br/")).toBe("https://app.law.com.br");
    expect(urlBase("http://localhost:3000")).toBe("http://localhost:3000");
    expect(urlBase("http://app.law.com.br")).toBeNull();
    expect(urlBase("")).toBeNull();
  });
});

describe("Período relativo", () => {
  it("semana = segunda a domingo; funciona no domingo", () => {
    expect(datasDoPeriodo("semana", "2026-11-10")).toEqual({ de: "2026-11-09", ate: "2026-11-15" }); // terça
    expect(datasDoPeriodo("semana", "2026-11-15")).toEqual({ de: "2026-11-09", ate: "2026-11-15" }); // domingo
    expect(datasDoPeriodo("mes", "2026-02-10")).toEqual({ de: "2026-02-01", ate: "2026-02-28" });
    expect(datasDoPeriodo("proximos_7_dias", "2026-12-28")).toEqual({ de: "2026-12-28", ate: "2027-01-03" });
  });
});

describe("Ferramentas do conector", () => {
  it("leitura marcada como somente leitura; escrita como destrutiva (o assistente pede aprovação)", () => {
    for (const f of FERRAMENTAS_MCP) {
      if (f.escopo === "law.read") expect(f.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      else expect(f.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(ferramentasDoEscopo(["law.read"]).map((f) => f.name)).not.toContain("criar_tarefa");
    expect(ferramentasDoEscopo(["law.read", "law.write"]).map((f) => f.name)).toEqual(expect.arrayContaining(["buscar_prazos", "criar_tarefa", "criar_lancamento", "criar_prazo", "gerar_minuta"]));
  });
});

const sessao = (escopos: string[], chamadas: string[] = []): SessaoMcp => ({
  escopos, base: BASE,
  ctx: async () => { throw new Error("não deveria precisar do banco"); },
  registrar: async (f, _e, ok, c) => { chamadas.push(`${f}:${ok}:${c}`); },
});

describe("Protocolo MCP", () => {
  it("initialize negocia a versão", async () => {
    const r = (await tratarMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, sessao(["law.read"]))) as { result: { protocolVersion: string; capabilities: object } };
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
    const r2 = (await tratarMcp({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, sessao(["law.read"]))) as { result: { protocolVersion: string } };
    expect(r2.result.protocolVersion).toBe("2025-11-25");
  });
  it("notificação não tem resposta; método desconhecido dá -32601; lote é recusado", async () => {
    expect(await tratarMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, sessao(["law.read"]))).toBeNull();
    expect(await tratarMcp({ jsonrpc: "2.0", id: 3, method: "resources/list" }, sessao(["law.read"]))).toMatchObject({ error: { code: -32601 } });
    expect(await tratarMcp([{ jsonrpc: "2.0", id: 1, method: "ping" }], sessao(["law.read"]))).toMatchObject({ error: { code: -32600 } });
  });
  it("tools/list respeita o escopo; escrita sem law.write é recusada sem tocar no banco", async () => {
    const lista = (await tratarMcp({ jsonrpc: "2.0", id: 4, method: "tools/list" }, sessao(["law.read"]))) as { result: { tools: { name: string; annotations: object }[] } };
    expect(lista.result.tools.every((t) => t.name.startsWith("buscar_"))).toBe(true);
    const chamadas: string[] = [];
    const r = (await tratarMcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "criar_tarefa", arguments: { titulo: "x" } } }, sessao(["law.read"], chamadas))) as { result: { isError: boolean } };
    expect(r.result.isError).toBe(true);
    expect(chamadas).toEqual(["criar_tarefa:false:escopo_insuficiente"]);
  });
  it("links internos viram endereço completo", () => {
    expect(absolutizar({ itens: [{ link: "/app/processos/1", outro: "/app/x" }] }, BASE)).toEqual({ itens: [{ link: `${BASE}/app/processos/1`, outro: "/app/x" }] });
  });
});

describe("Transporte HTTP do MCP", () => {
  const autenticado: Autenticado = { usuario_id: "u", escritorio_id: "e", concessao_id: "c", escopos: ["law.read"], conversa_id: "v", cliente: "Claude", perfil: "claude" };
  const deps = (autenticar: DepsHttpMcp["autenticar"] = async () => autenticado): DepsHttpMcp => ({ base: BASE, origens: ["https://claude.ai"], autenticar, sessao: () => sessao(["law.read"]) });
  const post = (corpo: unknown, cab: Record<string, string> = {}) =>
    new Request(`${BASE}/api/mcp`, { method: "POST", headers: { "content-type": "application/json", ...cab }, body: JSON.stringify(corpo) });

  it("sem token: 401 com o endereço dos metadados (é assim que o Claude descobre o OAuth)", async () => {
    const r = await atenderMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }), deps());
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp"`);
  });
  it("token revogado: 401 invalid_token; limite: 429", async () => {
    const revogado = await atenderMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer abc" }), deps(async () => { throw new Error("token_invalido"); }));
    expect(revogado.status).toBe(401);
    expect(revogado.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const limite = await atenderMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer abc" }), deps(async () => { throw new Error("limite_excedido"); }));
    expect(limite.status).toBe(429);
    expect(limite.headers.get("retry-after")).toBe("60");
  });
  it("token válido: responde JSON-RPC; notificação = 202; GET = 405; origem estranha = 403", async () => {
    const ok = await atenderMcp(post({ jsonrpc: "2.0", id: 9, method: "ping" }, { authorization: "Bearer abc" }), deps());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
    expect((await atenderMcp(post({ jsonrpc: "2.0", method: "notifications/initialized" }, { authorization: "Bearer abc" }), deps())).status).toBe(202);
    expect((await atenderMcp(new Request(`${BASE}/api/mcp`, { method: "GET" }), deps())).status).toBe(405);
    expect((await atenderMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer abc", origin: "https://malicioso.example" }), deps())).status).toBe(403);
    expect((await atenderMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer abc", origin: "https://claude.ai" }), deps())).status).toBe(200);
  });
  it("o hash do token (nunca o token) é o que vai ao banco", async () => {
    let recebido = "";
    await atenderMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer meu-token" }), deps(async (h) => { recebido = h; return autenticado; }));
    expect(recebido).toBe(hashSegredo("meu-token"));
  });
});
