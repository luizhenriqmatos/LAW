import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { unzipSync, strFromU8 } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Privacidade from "@/app/privacidade/page";
import Termos from "@/app/termos/page";
import { montarAviso } from "@/lib/conta/avisos";
import { montarZip, paraCsv } from "@/lib/conta/zip";

vi.mock("@/lib/supabase/servico", () => ({ rpcServico: () => async () => [], servicoConfigurado: () => true }));
vi.mock("@/lib/integrations/email", () => ({ servicoEmail: () => ({ enviarAviso: async () => ({ enviado: true }) }) }));

const html = (c: () => React.ReactElement) => renderToStaticMarkup(c()).replace(/&#x27;/g, "'").replace(/ /g, " ");

describe("Páginas legais", () => {
  it("as duas trazem REVISAR COM ADVOGADO no topo, antes de qualquer outro conteúdo", () => {
    for (const p of [Termos, Privacidade]) {
      const x = html(() => h(p));
      const aviso = x.indexOf("REVISAR COM ADVOGADO");
      expect(aviso).toBeGreaterThan(-1);
      expect(aviso).toBeLessThan(x.indexOf("<h1"));
      expect(x.indexOf("<main")).toBeLessThan(aviso);
    }
  });

  it("Termos: ferramenta de apoio, conferir prazos nos sistemas oficiais e limite = valor pago nos últimos 12 meses", () => {
    const x = html(() => h(Termos));
    expect(x).toContain("O LAW é uma ferramenta de apoio");
    expect(x).toMatch(/conferir todo prazo, intimação e andamento diretamente nos sistemas oficiais/);
    expect(x).toMatch(/limitada ao valor que o escritório efetivamente pagou ao LAW nos 12 meses anteriores/);
    expect(x).toContain("30 dias");
    expect(x).toContain("5 anos");
  });

  it("Privacidade: controlador e operador, e todos os provedores nomeados", () => {
    const x = html(() => h(Privacidade));
    expect(x).toMatch(/controlador/);
    expect(x).toMatch(/operador/);
    for (const prov of ["Supabase", "Vercel", "Google", "Anthropic", "Resend", "Meta"]) expect(x, prov).toContain(prov);
    expect(x).toContain("LGPD");
  });
});

describe("E-mails do encerramento", () => {
  const base = { escritorio_id: "e", nome: "Prado Advocacia", ate: "2027-03-31T12:00:00Z", destinatarios: ["ana@t.com"] };
  it("pedido, 7 dias e exclusão têm assunto e texto próprios, com o nome do escritório e a data", () => {
    const [a, b, c] = (["pedido", "sete_dias", "exclusao"] as const).map((tipo) => montarAviso({ ...base, tipo }));
    expect(new Set([a.assunto, b.assunto, c.assunto]).size).toBe(3);
    for (const m of [a, b, c]) { expect(m.assunto + m.texto).toContain("Prado Advocacia"); expect(m.texto).toContain("31 de março de 2027"); }
    expect(a.texto).toContain("somente para leitura");
    expect(b.assunto).toContain("Faltam 7 dias");
    expect(c.texto).toContain("5 anos");
  });
});

describe("CSV e ZIP da exportação", () => {
  it("CSV: BOM, aspas, vírgula, quebra de linha e fórmula neutralizada", () => {
    const csv = paraCsv([{ a: "x,y", b: 'diz "oi"', c: "linha1\nlinha2", d: "=SOMA(A1)", e: 5, f: null }, { a: "z", g: { k: 1 } }]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"diz ""oi"""');
    expect(csv).toContain('"linha1\nlinha2"');
    expect(csv).toContain("'=SOMA(A1)");
    expect(csv).toContain('"{""k"":1}"');
    expect(csv.split("\r\n")[0]).toBe("﻿a,b,c,d,e,f,g");
  });

  it("ZIP: uma planilha por tabela, PDFs dos assinados, LEIA-ME; tabela vazia continua existindo", () => {
    const pdf = Buffer.from("%PDF-1.4 conteúdo de teste");
    const zip = montarZip({
      escritorio: "Prado", geradoEm: new Date("2027-03-02T00:00:00Z"),
      tabelas: { cliente: [{ id: "1", nome: "Maria" }], processo: [] },
      assinaturas: { assinatura_envelope: [{ id: "abcdef12-0000", titulo: "Contrato" }] },
      arquivos: [{ envelopeId: "abcdef12-0000", titulo: "Contrato/../x", nomeArquivo: "c.pdf", original: pdf, final: pdf }],
    });
    const f = unzipSync(zip);
    expect(Object.keys(f).sort()).toEqual([
      "LEIA-ME.txt", "documentos-assinados/abcdef12-Contrato___x/assinado-c.pdf", "documentos-assinados/abcdef12-Contrato___x/original-c.pdf",
      "tabelas/assinatura_envelope.csv", "tabelas/cliente.csv", "tabelas/processo.csv",
    ]);
    expect(strFromU8(f["tabelas/cliente.csv"])).toContain("Maria");
    expect(Buffer.from(f["documentos-assinados/abcdef12-Contrato___x/assinado-c.pdf"]).equals(pdf)).toBe(true);
    expect(strFromU8(f["LEIA-ME.txt"])).toContain("cliente: 1 linha(s)");
    expect(Object.keys(f).every((n) => !n.includes(".."))).toBe(true);
  });
});

describe("/api/cron/encerramento", () => {
  beforeEach(() => { process.env.CRON_SECRET = "segredo-cron"; });
  const req = (auth?: string) => new Request("https://app.law.test/api/cron/encerramento", { headers: auth ? { authorization: auth } : {} });
  it("sem o segredo: 401; com o segredo: roda", async () => {
    const { GET } = await import("@/app/api/cron/encerramento/route");
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer errado"))).status).toBe(401);
    const ok = await GET(req("Bearer segredo-cron"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ excluidas: 0, avisos: [], falhas: 0 });
  });
});
