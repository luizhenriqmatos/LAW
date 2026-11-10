import { PDFDocument } from "pdf-lib";
import { pdfDeTeste } from "./pdf-teste";
import { describe, expect, it } from "vitest";
import { byteaDeBytes, bytesDeBytea } from "@/lib/assinatura/bytea";
import { cpfValido, formatarCpf } from "@/lib/assinatura/cpf";
import { montarPdfFinal, sha256Hex, validarPdf } from "@/lib/assinatura/pdf";

describe("CPF", () => {
  it("aceita CPF com dígitos verificadores certos, com ou sem máscara", () => {
    expect(cpfValido("52998224725")).toBe(true);
    expect(cpfValido("529.982.247-25")).toBe(true);
    expect(cpfValido("111.444.777-35")).toBe(true);
  });
  it("recusa dígito errado, tamanho errado, todos iguais e lixo", () => {
    for (const ruim of ["52998224726", "529.982.247-24", "1234567890", "111.111.111-11", "00000000000", "", "abc", "529982247250"]) {
      expect(cpfValido(ruim), ruim).toBe(false);
    }
  });
  it("formata", () => expect(formatarCpf("52998224725")).toBe("529.982.247-25"));
});

describe("bytea", () => {
  it("vai e volta, e aceita bytes do PGlite", () => {
    const b = new Uint8Array([0, 1, 37, 80, 255]);
    expect(Array.from(bytesDeBytea(byteaDeBytes(b)))).toEqual(Array.from(b));
    expect(bytesDeBytea(b)).toBe(b);
    expect(() => bytesDeBytea("nada")).toThrow();
  });
});

describe("PDF", () => {
  it("valida PDF bom e recusa vazio, texto e PDF quebrado", async () => {
    expect(await validarPdf(await pdfDeTeste(3))).toEqual({ ok: true, paginas: 3 });
    expect(await validarPdf(new Uint8Array())).toEqual({ ok: false, motivo: "vazio" });
    expect(await validarPdf(new TextEncoder().encode("não sou pdf"))).toEqual({ ok: false, motivo: "nao_pdf" });
    expect(await validarPdf(new TextEncoder().encode("%PDF-1.4\nlixo sem estrutura"))).toEqual({ ok: false, motivo: "nao_pdf" });
    expect(await validarPdf(new Uint8Array(4 * 1024 * 1024 + 1))).toEqual({ ok: false, motivo: "grande" });
  });

  it("PDF final = original + manifesto; o hash muda se 1 byte muda", async () => {
    const original = await pdfDeTeste(2);
    const final = await montarPdfFinal(original, {
      titulo: "Contrato", nomeArquivo: "contrato.pdf", escritorio: "Prado Advocacia", envelopeId: "00000000-0000-4000-8000-000000000001",
      hashOriginal: sha256Hex(original), criadoEm: "2026-11-10T10:00:00.000Z",
      signatarios: [
        { ordem: 1, nome: "Ana Teste Łukasz", email: "ana@teste.com", cpf: "52998224725", assinadoEm: "2026-11-10T11:00:00.000Z", ip: "203.0.113.7", userAgent: "Mozilla/5.0 ".repeat(30) },
        { ordem: 2, nome: "Beto Teste", email: "beto@teste.com", cpf: "11144477735", assinadoEm: "2026-11-10T12:00:00.000Z", ip: null, userAgent: null },
      ],
    });
    const doc = await PDFDocument.load(final);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(3);
    const h = sha256Hex(final);
    const adulterado = Uint8Array.from(final);
    adulterado[adulterado.length >> 1] ^= 1;
    expect(sha256Hex(adulterado)).not.toBe(h);
  });

  it("muitos signatários viram mais de uma página de manifesto", async () => {
    const original = await pdfDeTeste(1);
    const sigs = Array.from({ length: 20 }, (_, i) => ({ ordem: 1, nome: `Pessoa ${i}`, email: `p${i}@teste.com`, cpf: "52998224725", assinadoEm: "2026-11-10T11:00:00.000Z", ip: "203.0.113.7", userAgent: "Navegador" }));
    const final = await montarPdfFinal(original, { titulo: "T", nomeArquivo: "a.pdf", escritorio: "E", envelopeId: "x", hashOriginal: "a".repeat(64), criadoEm: "2026-11-10T10:00:00.000Z", signatarios: sigs });
    expect((await PDFDocument.load(final)).getPageCount()).toBeGreaterThan(2);
  });
});
