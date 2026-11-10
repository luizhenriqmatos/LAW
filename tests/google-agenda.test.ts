import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { hashEvento, idEvento, montarEvento, type ItemSync } from "@/lib/agenda/evento";
import { nomeDoCalendario } from "@/lib/agenda/conectar";
import { chaveDoAmbiente, cifrar, decifrar } from "@/lib/integrations/google/cripto";
import { ErroGoogle } from "@/lib/integrations/google/erro";
import { configGoogle, ESCOPO_GOOGLE, renovarAcesso, revogarToken, trocarCodigo, urlAutorizacao } from "@/lib/integrations/google/oauth";
import { apiGoogleAgenda } from "@/lib/integrations/google/agenda-api";

const base: ItemSync = {
  origem: "tarefa", escritorio_id: "e", ativo: true, usuarios: ["u"], titulo: "Revisar minuta", descricao: "Ver cláusula 3",
  feita: false, dia_inteiro: true, data: "2026-12-31", numero_cnj: null, restrito: false,
};

describe("Cifra dos tokens", () => {
  const chave = randomBytes(32);
  it("ida e volta; cada cifra é diferente; texto puro não aparece", () => {
    const a = cifrar("1//refresh-token-secreto", chave), b = cifrar("1//refresh-token-secreto", chave);
    expect(a).not.toBe(b);
    expect(a).not.toContain("secreto");
    expect(decifrar(a, chave)).toBe("1//refresh-token-secreto");
  });
  it("detecta adulteração e chave errada", () => {
    const c = cifrar("abc", chave);
    const [v, iv, tag, ct] = c.split(":");
    const adulterado = [v, iv, tag, Buffer.from("xyz").toString("base64")].join(":");
    expect(() => decifrar(adulterado, chave)).toThrow();
    expect(() => decifrar(c, randomBytes(32))).toThrow();
    expect(() => decifrar("lixo", chave)).toThrow();
    void ct;
  });
  it("exige chave de 32 bytes no ambiente", () => {
    expect(() => chaveDoAmbiente(undefined)).toThrow(/GOOGLE_TOKEN_KEY/);
    expect(() => chaveDoAmbiente(Buffer.from("curta").toString("base64"))).toThrow();
    expect(chaveDoAmbiente(randomBytes(32).toString("base64"))).toHaveLength(32);
  });
});

describe("OAuth", () => {
  const cfg = { clientId: "id-1", clientSecret: "seg", redirectUri: "https://law.exemplo.com.br/api/google/callback" };
  it("pede SÓ o escopo mínimo, acesso offline e consentimento", () => {
    const u = new URL(urlAutorizacao(cfg, "estado123"));
    expect(u.searchParams.get("scope")).toBe(ESCOPO_GOOGLE);
    expect(ESCOPO_GOOGLE).toBe("https://www.googleapis.com/auth/calendar.app.created");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("state")).toBe("estado123");
    expect(u.searchParams.get("redirect_uri")).toBe(cfg.redirectUri);
    expect(u.searchParams.get("client_secret")).toBeNull();
  });
  it("sem credenciais a configuração fica desligada", () => {
    const antes = { ...process.env };
    delete process.env.GOOGLE_CLIENT_ID;
    expect(configGoogle("https://x.com")).toBeNull();
    process.env.GOOGLE_CLIENT_ID = "a"; process.env.GOOGLE_CLIENT_SECRET = "b";
    expect(configGoogle("https://x.com/")?.redirectUri).toBe("https://x.com/api/google/callback");
    expect(configGoogle(undefined)).toBeNull();
    process.env = antes;
  });
  const resposta = (status: number, corpo: unknown) => (async () => new Response(JSON.stringify(corpo), { status })) as unknown as typeof fetch;
  it("troca de código devolve tokens; invalid_grant vira “revogado”", async () => {
    const t = await trocarCodigo(cfg, "codigo", resposta(200, { access_token: "A", refresh_token: "R", expires_in: 3600, scope: ESCOPO_GOOGLE }), new Date("2026-11-09T10:00:00Z"));
    expect(t).toMatchObject({ accessToken: "A", refreshToken: "R", escopo: ESCOPO_GOOGLE });
    expect(t.expiraEm.toISOString()).toBe("2026-11-09T11:00:00.000Z");
    await expect(renovarAcesso(cfg, "R", resposta(400, { error: "invalid_grant" }))).rejects.toMatchObject({ codigo: "revogado" });
    await expect(renovarAcesso(cfg, "R", resposta(503, {}))).rejects.toMatchObject({ codigo: "indisponivel" });
    await expect(renovarAcesso(cfg, "R", (async () => { throw new Error("rede"); }) as unknown as typeof fetch)).rejects.toBeInstanceOf(ErroGoogle);
  });
  it("revogar é melhor esforço: nunca lança", async () => {
    expect(await revogarToken("t", resposta(200, {}))).toBe(true);
    expect(await revogarToken("t", (async () => { throw new Error("x"); }) as unknown as typeof fetch)).toBe(false);
  });
});

describe("API do Google Agenda (mapeamento de erros)", () => {
  const f = (status: number, corpo: unknown = {}) => apiGoogleAgenda((async () => new Response(JSON.stringify(corpo), { status })) as unknown as typeof fetch);
  const ev = { summary: "x", start: { date: "2026-12-01" }, end: { date: "2026-12-02" } };
  it("traduz códigos HTTP para o que o LAW trata", async () => {
    await expect(f(401).inserirEvento("t", "c", "e1", ev)).rejects.toMatchObject({ codigo: "nao_autorizado" });
    await expect(f(409).inserirEvento("t", "c", "e1", ev)).rejects.toMatchObject({ codigo: "conflito" });
    await expect(f(404).inserirEvento("t", "c", "e1", ev)).rejects.toMatchObject({ codigo: "calendario_removido" });
    await expect(f(404).atualizarEvento("t", "c", "e1", ev)).rejects.toMatchObject({ codigo: "nao_encontrado" });
    await expect(f(429).inserirEvento("t", "c", "e1", ev)).rejects.toMatchObject({ codigo: "limite" });
    await expect(f(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }).inserirEvento("t", "c", "e1", ev)).rejects.toMatchObject({ codigo: "limite" });
    await expect(f(403, { error: { errors: [{ reason: "forbidden" }] } }).inserirEvento("t", "c", "e1", ev)).rejects.toMatchObject({ codigo: "revogado" });
    await expect(f(500).inserirEvento("t", "c", "e1", ev)).rejects.toMatchObject({ codigo: "indisponivel" });
  });
  it("apagar evento que já não existe é sucesso", async () => {
    await expect(f(404).apagarEvento("t", "c", "e1")).resolves.toBeUndefined();
    await expect(f(410).apagarEvento("t", "c", "e1")).resolves.toBeUndefined();
    await expect(f(401).apagarEvento("t", "c", "e1")).rejects.toMatchObject({ codigo: "nao_autorizado" });
  });
  it("calendário que sumiu não “existe”", async () => {
    expect(await f(404).calendarioExiste("t", "c")).toBe(false);
    expect(await f(200).calendarioExiste("t", "c")).toBe(true);
  });
  it("manda o token no cabeçalho e o id escolhido pelo LAW", async () => {
    let visto: { url: string; init?: RequestInit } | null = null;
    const api = apiGoogleAgenda((async (url: string, init?: RequestInit) => { visto = { url, init }; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch);
    await api.inserirEvento("TOKEN", "cal@group", "eabc", ev);
    expect(visto!.url).toBe("https://www.googleapis.com/calendar/v3/calendars/cal%40group/events");
    expect((visto!.init!.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(String(visto!.init!.body)).id).toBe("eabc");
  });
});

describe("Montagem do evento", () => {
  it("tarefa/prazo: dia inteiro, fim exclusivo (dia seguinte, inclusive virando o ano)", () => {
    const { evento } = montarEvento(base, "t1", "https://law.com.br/");
    expect(evento.start).toEqual({ date: "2026-12-31" });
    expect(evento.end).toEqual({ date: "2027-01-01" });
    expect(evento.description).toContain("Abrir no LAW: https://law.com.br/app/tarefas/t1");
  });
  it("tarefa feita ganha ✔; prazo ganha “Prazo:” e link para a lista", () => {
    expect(montarEvento({ ...base, feita: true }, "t", "https://x").evento.summary).toBe("✔ Revisar minuta");
    const p = montarEvento({ ...base, origem: "prazo", titulo: "Contestar" }, "p", "https://x").evento;
    expect(p.summary).toBe("Prazo: Contestar");
    expect(p.description).toContain("https://x/app/prazos");
  });
  it("compromisso: data e hora com fuso de Brasília; fim igual ao início vira 1 hora", () => {
    const c: ItemSync = { ...base, origem: "compromisso", titulo: "Instrução", tipo: "audiencia", local: "Fórum", dia_inteiro: false, data: null, inicio: "2026-11-30T17:00:00+00:00", fim: "2026-11-30T17:00:00+00:00" };
    const { evento } = montarEvento(c, "k", "https://x");
    expect(evento.summary).toBe("Audiência: Instrução");
    expect(evento.location).toBe("Fórum");
    expect(evento.start).toEqual({ dateTime: "2026-11-30T17:00:00.000Z", timeZone: "America/Sao_Paulo" });
    expect(evento.end).toEqual({ dateTime: "2026-11-30T18:00:00.000Z", timeZone: "America/Sao_Paulo" });
  });
  it("segredo de justiça: sem título, descrição, local nem número do processo", () => {
    const { evento } = montarEvento({ ...base, restrito: true, numero_cnj: "00000011220268050001", local: "Sala secreta" }, "t", "https://x");
    expect(evento.summary).toBe("LAW: item restrito");
    const tudo = JSON.stringify(evento);
    for (const proibido of ["Revisar", "cláusula", "0000001", "secreta"]) expect(tudo).not.toContain(proibido);
    expect(tudo).toContain("https://x/app/tarefas/t");
  });
  it("número do processo aparece formatado (CNJ)", () => {
    expect(montarEvento({ ...base, numero_cnj: "00000011220268050001" }, "t", "https://x").evento.description).toContain("0000001-12.2026.8.05.0001");
  });
  it("hash muda quando o conteúdo muda e é estável quando não muda", () => {
    const a = montarEvento(base, "t", "https://x").hash;
    expect(montarEvento(base, "t", "https://x").hash).toBe(a);
    expect(montarEvento({ ...base, titulo: "Outro" }, "t", "https://x").hash).not.toBe(a);
    expect(hashEvento(montarEvento(base, "t", "https://x").evento)).toBe(a);
  });
  it("item sem data é recusado", () => {
    expect(() => montarEvento({ ...base, data: null }, "t", "https://x")).toThrow();
  });
});

describe("Id do evento no Google", () => {
  it("é determinístico, único por conexão/origem/item/geração e só usa caracteres aceitos (a-v, 0-9)", () => {
    const a = idEvento("c1", "tarefa", "i1");
    expect(idEvento("c1", "tarefa", "i1")).toBe(a);
    expect(new Set([a, idEvento("c2", "tarefa", "i1"), idEvento("c1", "prazo", "i1"), idEvento("c1", "tarefa", "i2"), idEvento("c1", "tarefa", "i1", 1)]).size).toBe(5);
    expect(a).toMatch(/^[a-v0-9]{5,1024}$/);
  });
});

describe("Nome do calendário", () => {
  it("“LAW”; com vários escritórios leva o nome do escritório", () => {
    expect(nomeDoCalendario("Prado Advocacia", false)).toBe("LAW");
    expect(nomeDoCalendario("Prado Advocacia", true)).toBe("LAW – Prado Advocacia");
  });
});
