import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cnjFormatado, limparNome, nomeDeArquivo, nomePastaCliente, nomePastaProcesso } from "@/lib/drive/nomes";
import { apiGoogleDrive, escapar, linkDaPasta, linkDoDriveSeguro, MIME_PASTA } from "@/lib/integrations/google/drive-api";
import { ErroGoogle } from "@/lib/integrations/google/erro";
import { configGoogle, ESCOPO_DRIVE, ESCOPO_GOOGLE, urlAutorizacao } from "@/lib/integrations/google/oauth";

describe("Nomes de pasta", () => {
  it("cliente: tira barras e espaços repetidos, mantém acentos", () => {
    expect(nomePastaCliente("  José   da Silva / Filhos \\ Ltda ")).toBe("José da Silva - Filhos - Ltda");
    expect(nomePastaCliente("   ")).toBe("Cliente sem nome");
    expect(nomePastaCliente(".oculto")).toBe("oculto");
    expect(limparNome("a".repeat(300), "x").length).toBe(120);
  });
  it("processo: “<CNJ formatado> - <classe>”", () => {
    expect(cnjFormatado("00000011220268050001")).toBe("0000001-12.2026.8.05.0001");
    expect(nomePastaProcesso("00000011220268050001", "Procedimento Comum Cível")).toBe("0000001-12.2026.8.05.0001 - Procedimento Comum Cível");
    expect(nomePastaProcesso("00000011220268050001", null)).toBe("0000001-12.2026.8.05.0001");
    expect(nomePastaProcesso("123", " Classe ")).toBe("123 - Classe");
    expect(nomePastaProcesso(null, null)).toBe("Processo sem número");
  });
  it("arquivo enviado: sem caminho, sem barras", () => {
    expect(nomeDeArquivo("C:\\Users\\x\\contrato final.pdf")).toBe("contrato final.pdf");
    expect(nomeDeArquivo("../../a/b.txt")).toBe("b.txt");
    expect(nomeDeArquivo("")).toBe("arquivo");
  });
});

describe("Google Drive: escopo e links", () => {
  it("o escopo do Drive é o mínimo (drive.file) e o da agenda continua separado", () => {
    expect(ESCOPO_DRIVE).toBe("https://www.googleapis.com/auth/drive.file");
    const cfg = configGoogle("https://law.exemplo.com.br") ?? { clientId: "id", clientSecret: "s", redirectUri: "https://law.exemplo.com.br/api/google/callback" };
    const u = new URL(urlAutorizacao(cfg, "est", ESCOPO_DRIVE));
    expect(u.searchParams.get("scope")).toBe(ESCOPO_DRIVE);
    expect(u.searchParams.get("scope")).not.toContain("drive ");
    expect(new URL(urlAutorizacao(cfg, "est")).searchParams.get("scope")).toBe(ESCOPO_GOOGLE);
    expect(u.searchParams.get("include_granted_scopes")).toBe("false");
  });
  it("só aceita link do Google; escapa aspas na consulta", () => {
    expect(linkDoDriveSeguro("https://drive.google.com/file/d/1/view")).toContain("drive.google.com");
    expect(linkDoDriveSeguro("https://docs.google.com/document/d/1/edit")).not.toBeNull();
    expect(linkDoDriveSeguro("javascript:alert(1)")).toBeNull();
    expect(linkDoDriveSeguro("https://drive.google.com.evil.com/x")).toBeNull();
    expect(linkDoDriveSeguro("http://drive.google.com/x")).toBeNull();
    expect(linkDoDriveSeguro(undefined)).toBeNull();
    expect(linkDaPasta("abc/12")).toBe("https://drive.google.com/drive/folders/abc%2F12");
    expect(escapar("O'Brien \\ x")).toBe("O\\'Brien \\\\ x");
  });
});

describe("API real do Drive (fetch simulado)", () => {
  type Chamada = { url: string; metodo: string; corpo?: string; cab: Record<string, string> };
  function falso(respostas: (Response | Error)[]) {
    const chamadas: Chamada[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      chamadas.push({ url: String(url), metodo: init?.method ?? "GET", corpo: init?.body as string | undefined, cab: (init?.headers ?? {}) as Record<string, string> });
      const r = respostas.shift();
      if (r instanceof Error) throw r;
      return r ?? new Response("{}", { status: 200 });
    }) as typeof fetch;
    return { f, chamadas };
  }
  const json = (o: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: h });

  it("cria pasta com a marca do LAW e o pai certo", async () => {
    const { f, chamadas } = falso([json({ id: "p1" })]);
    expect(await apiGoogleDrive(f).criarPasta("tok", "Maria", "pai1", "esc:cliente:1")).toEqual({ id: "p1" });
    expect(chamadas[0].metodo).toBe("POST");
    expect(chamadas[0].cab.authorization).toBe("Bearer tok");
    expect(JSON.parse(chamadas[0].corpo!)).toEqual({ name: "Maria", mimeType: MIME_PASTA, parents: ["pai1"], appProperties: { law_marca: "esc:cliente:1" } });
  });
  it("mover usa addParents/removeParents; renomear usa PATCH com o nome", async () => {
    const { f, chamadas } = falso([json({}), json({})]);
    const api = apiGoogleDrive(f);
    await api.mover("tok", "p1", "novo", "velho");
    await api.renomear("tok", "p1", "Novo Nome");
    expect(chamadas[0].url).toContain("addParents=novo");
    expect(chamadas[0].url).toContain("removeParents=velho");
    expect(JSON.parse(chamadas[1].corpo!)).toEqual({ name: "Novo Nome" });
  });
  it("envio retomável: abre a sessão e manda os bytes no endereço devolvido", async () => {
    const { f, chamadas } = falso([json({}, 200, { location: "https://upload.exemplo/sessao1" }), json({ id: "a1", name: "x.pdf", mimeType: "application/pdf" })]);
    const r = await apiGoogleDrive(f).enviar("tok", "pai", "x.pdf", "application/pdf", new Uint8Array([1, 2]));
    expect(r.id).toBe("a1");
    expect(chamadas[0].url).toContain("uploadType=resumable");
    expect(JSON.parse(chamadas[0].corpo!)).toMatchObject({ name: "x.pdf", parents: ["pai"] });
    expect(chamadas[1].url).toBe("https://upload.exemplo/sessao1");
    expect(chamadas[1].metodo).toBe("PUT");
  });
  it("traduz os erros do Google", async () => {
    const codigo = async (status: number, reason = "") => {
      const { f } = falso([json({ error: { errors: [{ reason }] } }, status)]);
      return apiGoogleDrive(f).renomear("t", "p", "n").catch((e: ErroGoogle) => e.codigo);
    };
    expect(await codigo(401)).toBe("nao_autorizado");
    expect(await codigo(404)).toBe("nao_encontrado");
    expect(await codigo(403, "appNotAuthorizedToFile")).toBe("nao_encontrado");
    expect(await codigo(403, "userRateLimitExceeded")).toBe("limite");
    expect(await codigo(429)).toBe("limite");
    expect(await codigo(500)).toBe("indisponivel");
    const { f } = falso([new Error("rede")]);
    expect(await apiGoogleDrive(f).renomear("t", "p", "n").catch((e: ErroGoogle) => e.codigo)).toBe("indisponivel");
  });
  it("obterPasta devolve null quando a pasta não existe", async () => {
    const { f } = falso([json({}, 404)]);
    expect(await apiGoogleDrive(f).obterPasta("t", "p")).toBeNull();
  });
  it("o módulo do Drive NUNCA apaga: não há DELETE nem lixeira no código", () => {
    for (const arq of ["src/lib/integrations/google/drive-api.ts", "src/lib/drive/sync.ts", "src/lib/drive/arquivos.ts", "src/lib/drive/conectar.ts"]) {
      // Comentários podem citar "apagar" (para explicar a regra); só o código conta.
      const fonte = readFileSync(arq, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
      expect(fonte, arq).not.toMatch(/["']DELETE["']|trashed:\s*true|\.delete\(|apagar|excluir|lixeira/i);
    }
  });
});
