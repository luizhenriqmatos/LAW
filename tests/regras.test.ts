import { describe, expect, it } from "vitest";
import { cnpjValido, esquemaMonitoramento, esquemaOab, oabValida, UFS } from "@/lib/validacao";
import { IDS_MODULOS, itensDoMenu, moduloDaRota, podeAcessar } from "@/lib/modulos";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("OAB", () => {
  it("aceita de 1 a 7 dígitos com UF válida", () => {
    expect(oabValida("1", "BA")).toBe(true);
    expect(oabValida("54321", "ba")).toBe(true);
    expect(oabValida("1234567", "SE")).toBe(true);
    expect(oabValida("0054321", "BA")).toBe(true);
  });
  it("recusa 8 dígitos, zero, vazio e UF inexistente", () => {
    expect(oabValida("12345678", "BA")).toBe(false);
    expect(oabValida("0", "BA")).toBe(false);
    expect(oabValida("", "BA")).toBe(false);
    expect(oabValida("123", "XX")).toBe(false);
  });
  it("tem exatamente as 27 UFs", () => {
    expect(new Set(UFS).size).toBe(27);
  });
  it("normaliza número e UF", () => {
    expect(esquemaOab.parse({ numero: "00.543-21", uf: "ba" })).toEqual({ numero: "54321", uf: "BA" });
  });
});

describe("CNPJ", () => {
  it("aceita CNPJ válido com ou sem máscara", () => {
    expect(cnpjValido("11.222.333/0001-81")).toBe(true);
    expect(cnpjValido("11222333000181")).toBe(true);
  });
  it("recusa dígito errado, repetidos e tamanho errado", () => {
    expect(cnpjValido("11222333000182")).toBe(false);
    expect(cnpjValido("00000000000000")).toBe(false);
    expect(cnpjValido("1122233300018")).toBe(false);
  });
});

describe("Monitoramento", () => {
  it("exige ao menos uma OAB no modo OAB", () => {
    expect(esquemaMonitoramento.safeParse({ modo: "oab", oabs: [] }).success).toBe(false);
  });
  it("exige CNPJ ou nome no modo sociedade", () => {
    expect(esquemaMonitoramento.safeParse({ modo: "sociedade", cnpj: "", nome: "" }).success).toBe(false);
    expect(esquemaMonitoramento.safeParse({ modo: "sociedade", cnpj: "", nome: "Prado Advogados" }).success).toBe(true);
  });
});

describe("Menu e rota usam a mesma regra", () => {
  const semFinanceiro = IDS_MODULOS.filter((m) => m !== "financeiro");

  it("financeiro some do menu e a rota é bloqueada, inclusive subrotas", () => {
    expect(itensDoMenu(semFinanceiro).map((i) => i.id)).not.toContain("financeiro");
    expect(podeAcessar("/app/financeiro", semFinanceiro)).toBe(false);
    expect(podeAcessar("/app/financeiro/lancamentos/123", semFinanceiro)).toBe(false);
    expect(podeAcessar("/app/financeiro/?x=1", semFinanceiro)).toBe(false);
  });

  it("painel inicial é livre; rota parecida não é confundida com o módulo", () => {
    expect(podeAcessar("/app", semFinanceiro)).toBe(true);
    expect(moduloDaRota("/app/financeiro-extra")).toBe(null);
  });

  it("para qualquer combinação de módulos, item do menu ⇔ rota liberada", () => {
    for (let mascara = 0; mascara < 1 << IDS_MODULOS.length; mascara++) {
      const mods = IDS_MODULOS.filter((_, i) => mascara & (1 << i));
      const noMenu = new Set(itensDoMenu(mods).map((i) => i.id));
      for (const id of IDS_MODULOS) {
        const rota = itensDoMenu(IDS_MODULOS).find((i) => i.id === id)!.rota;
        expect(podeAcessar(rota, mods)).toBe(noMenu.has(id));
      }
    }
  });

  it("lista de módulos do app é a mesma do banco (última definição nas migrações)", () => {
    const pasta = join(__dirname, "..", "supabase", "migrations");
    const definicoes = readdirSync(pasta).filter((f) => f.endsWith(".sql")).sort()
      .flatMap((f) => [...readFileSync(join(pasta, f), "utf8").matchAll(/function public\.modulos_validos\(\)[\s\S]*?select array\[([^\]]+)\]::text\[\]/g)].map((m) => m[1]));
    const noBanco = definicoes.at(-1)!.split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(noBanco).toEqual(IDS_MODULOS);
  });
});
