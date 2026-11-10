import { describe, expect, it } from "vitest";
import { normalizarNome, similaridadeNomes, sugerirMesclagem, LIMIAR_NOME_PARECIDO } from "@/lib/triagem/similaridade";
import { cpfValido, documentoValido, esquemaCliente, formatarDocumento } from "@/lib/validacao";

describe("CPF/CNPJ", () => {
  it("valida dígitos verificadores, com ou sem máscara", () => {
    expect(cpfValido("123.456.789-09")).toBe(true);
    expect(cpfValido("12345678900")).toBe(false);
    expect(cpfValido("111.111.111-11")).toBe(false);
    expect(cpfValido("1234567890")).toBe(false);
    expect(documentoValido("11.222.333/0001-81")).toBe(true);
    expect(documentoValido("11.222.333/0001-80")).toBe(false);
    expect(documentoValido("123")).toBe(false);
  });

  it("formata para exibição", () => {
    expect(formatarDocumento("12345678909")).toBe("123.456.789-09");
    expect(formatarDocumento("11222333000181")).toBe("11.222.333/0001-81");
    expect(formatarDocumento(null)).toBe("");
  });

  it("formulário de cliente: documento e telefone opcionais, mas válidos quando preenchidos", () => {
    expect(esquemaCliente.safeParse({ nome: "Maria", documento: "", email: "", telefone: "" }).success).toBe(true);
    expect(esquemaCliente.safeParse({ nome: "Maria", documento: "123.456.789-00" }).error?.issues[0].message).toMatch(/CPF ou CNPJ inválido/);
    expect(esquemaCliente.safeParse({ nome: "Maria", email: "maria@" }).error?.issues[0].message).toMatch(/E-mail inválido/);
    expect(esquemaCliente.safeParse({ nome: "Maria", telefone: "9999" }).error?.issues[0].message).toMatch(/Telefone/);
    expect(esquemaCliente.parse({ nome: " Maria ", documento: "123.456.789-09", telefone: "(71) 98888-7777" })).toMatchObject({
      nome: "Maria", documento: "12345678909", telefone: "71988887777",
    });
  });
});

describe("Nome muito parecido (sugestão de mesclagem)", () => {
  it("normaliza acento, caixa e pontuação como o banco", () => {
    expect(normalizarNome("João  da SILVA-Ltda.")).toBe("joao da silva ltda");
  });

  it("considera iguais variações comuns", () => {
    expect(similaridadeNomes("JOÃO DA SILVA", "Joao Silva")).toBe(1);
    expect(similaridadeNomes("Silva, João", "João Silva")).toBeGreaterThanOrEqual(LIMIAR_NOME_PARECIDO);
    expect(similaridadeNomes("Maria Souza Santos", "Maria Sousa Santos")).toBeGreaterThanOrEqual(LIMIAR_NOME_PARECIDO);
    expect(similaridadeNomes("Comercial Exemplo Ltda", "COMERCIAL EXEMPLO S/A")).toBe(1);
  });

  it("não confunde pessoas diferentes", () => {
    expect(similaridadeNomes("Maria Souza", "José Pereira")).toBeLessThan(LIMIAR_NOME_PARECIDO);
    expect(similaridadeNomes("Ana Lima", "Ana Lúcia Ferreira Gomes")).toBeLessThan(LIMIAR_NOME_PARECIDO);
    expect(similaridadeNomes("da de do", "Maria")).toBe(0);
  });

  it("documento igual vem antes de nome parecido e a lista é limitada", () => {
    const confirmados = [
      { id: "1", nome: "Maria Sousa", documento: null },
      { id: "2", nome: "Fulana de Tal", documento: "123.456.789-09" },
      { id: "3", nome: "Pedro Alves", documento: null },
    ];
    const s = sugerirMesclagem({ nome: "Maria Souza", documento: "12345678909" }, confirmados);
    expect(s.map((x) => [x.cliente.id, x.motivo])).toEqual([["2", "documento"], ["1", "nome"]]);
    expect(sugerirMesclagem({ nome: "Ninguém Parecido", documento: null }, confirmados)).toEqual([]);
  });
});
