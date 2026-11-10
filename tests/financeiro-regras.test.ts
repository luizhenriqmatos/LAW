import { describe, expect, it } from "vitest";
import { celula, gerarCsv, reais, type LinhaParcela } from "@/lib/financeiro/csv";
import { dividirEmParcelas, saldoEmAberto, situacaoParcela, somarMeses, vencimentosMensais } from "@/lib/financeiro/parcelas";
import { paraCentavos } from "@/lib/dinheiro";

describe("Parcelamento: valores que não dividem exato", () => {
  it("R$ 100,00 em 3 → 33,34 + 33,33 + 33,33 (a diferença vai para a primeira)", () => {
    expect(dividirEmParcelas(10000, 3)).toEqual([3334, 3333, 3333]);
  });
  it("sempre soma o total, primeira ≥ demais, demais iguais, diferença menor que N centavos", () => {
    for (const [total, n] of [[10000, 3], [100, 7], [1, 1], [99999, 12], [7, 7], [50000, 10], [123457, 120], [10001, 4], [500000, 6]] as const) {
      const p = dividirEmParcelas(total, n);
      expect(p).toHaveLength(n);
      expect(p.reduce((s, x) => s + x, 0)).toBe(total);
      expect(p.slice(1).every((x) => x === p[1] || n === 1)).toBe(true);
      if (n > 1) expect(p[0] - p[1]).toBeLessThan(n);
      expect(p.every((x) => Number.isInteger(x) && x > 0)).toBe(true);
    }
  });
  it("recusa valor, quantidade e divisão impossíveis", () => {
    expect(() => dividirEmParcelas(0, 1)).toThrow("valor_invalido");
    expect(() => dividirEmParcelas(1000.5, 2)).toThrow("valor_invalido");
    expect(() => dividirEmParcelas(1000, 0)).toThrow("parcelas_invalidas");
    expect(() => dividirEmParcelas(1000, 121)).toThrow("parcelas_invalidas");
    expect(() => dividirEmParcelas(2, 3)).toThrow("parcelas_demais");
  });
  it("digitar o valor em reais vira centavos exatos", () => {
    expect(dividirEmParcelas(paraCentavos("1.000,00")!, 3)).toEqual([33334, 33333, 33333]);
    expect(paraCentavos("0,10")! + paraCentavos("0,20")!).toBe(30); // sem erro de ponto flutuante
  });
});

describe("Vencimentos mensais", () => {
  it("dia 31 cai no último dia dos meses curtos e volta ao 31 depois", () => {
    expect(vencimentosMensais("2026-01-31", 5)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });
  it("ano bissexto e virada de ano", () => {
    expect(somarMeses("2028-01-31", 1)).toBe("2028-02-29");
    expect(somarMeses("2026-11-15", 3)).toBe("2027-02-15");
    expect(somarMeses("2026-12-31", 12)).toBe("2027-12-31");
  });
  it("data inválida é recusada", () => {
    expect(() => somarMeses("31/01/2026", 1)).toThrow("data_invalida");
  });
});

describe("Situação e saldo", () => {
  it("aberta vencida aparece como atrasada; parcial e paga não mudam", () => {
    expect(situacaoParcela("aberta", "2026-01-01", "2026-01-02")).toBe("atrasada");
    expect(situacaoParcela("aberta", "2026-01-02", "2026-01-02")).toBe("aberta");
    expect(situacaoParcela("parcial", "2026-01-01", "2026-01-02")).toBe("parcial");
    expect(situacaoParcela("paga", "2026-01-01", "2026-01-02")).toBe("paga");
  });
  it("saldo em aberto soma só o que falta nas parcelas não pagas e não canceladas", () => {
    expect(saldoEmAberto([
      { valor: 33334, pago: 10000, status: "parcial" },
      { valor: 33333, pago: 0, status: "aberta" },
      { valor: 33333, pago: 33333, status: "paga" },
      { valor: 5000, pago: 0, status: "cancelada" },
    ])).toBe(23334 + 33333);
  });
});

describe("CSV", () => {
  const linha: LinhaParcela = {
    id: "1", lancamento_id: "2", numero: 1, total_parcelas: 3, valor_centavos: 33334, valor_pago_centavos: 10000, vencimento: "2026-02-10",
    data_pagamento: "2026-02-05", forma_pagamento: "pix", status: "parcial", tipo: "receita", categoria: "honorarios_contratuais",
    descricao: "Honorários; \"fase 1\"", data_competencia: "2026-02-01", cliente_nome: "Maria Silva", numero_cnj: "00000011220268050001",
  };
  it("tem BOM, separador ; e vírgula decimal", () => {
    const csv = gerarCsv([linha], "2026-03-01");
    expect(csv.startsWith("﻿Tipo;Categoria;")).toBe(true);
    const l = csv.split("\r\n")[1];
    expect(l).toContain("Receita;Honorários contratuais;\"Honorários; \"\"fase 1\"\"\";Maria Silva");
    expect(l).toContain(";1/3;10/02/2026;333,34;100,00;233,34;05/02/2026;Pix;Parcial");
  });
  it("escapa fórmula de planilha (= + - @)", () => {
    expect(celula("=1+1")).toBe("'=1+1");
    expect(celula("+55 71")).toBe("'+55 71");
    expect(celula("@soma")).toBe("'@soma");
    expect(celula("-5")).toBe("'-5");
    expect(celula("normal")).toBe("normal");
  });
  it("reais formata sem float", () => {
    expect(reais(5)).toBe("0,05");
    expect(reais(123456)).toBe("1234,56");
  });
});

import { lerFiltros, paraLancamentos, paraParcelas, paraQuery } from "@/lib/financeiro/filtros";

describe("Filtros vindos da URL", () => {
  const U = "3f0e2b9c-6c1a-4d3e-9a55-0f6a1c2b3d4e";
  it("aceita o que é válido e ignora o resto", () => {
    const f = lerFiltros({ tipo: "receita", categoria: "exito", situacao: "atrasado", cliente: U, de: "2026-01-01", busca: "  contrato ", pagina: "2" });
    expect(f).toMatchObject({ tipo: "receita", categoria: "exito", situacao: "atrasado", cliente: U, de: "2026-01-01", busca: "contrato", pagina: 2 });
    const ruim = lerFiltros({ tipo: "x'; drop table", categoria: "nada", situacao: "?", cliente: "não-é-uuid", de: "ontem", pagina: "-3", busca: "" });
    expect(ruim).toEqual({});
  });
  it("converte para os filtros do banco (lista usa competência; CSV traduz a situação)", () => {
    const f = lerFiltros({ situacao: "quitado", cliente: U, de: "2026-02-01", pagina: "3" });
    expect(paraLancamentos(f)).toEqual({ situacao: "quitado", cliente_id: U, de: "2026-02-01", limite: 50, deslocamento: 100 });
    expect(paraParcelas(f)).toEqual({ situacao: "paga", cliente_id: U, comp_de: "2026-02-01", limite: 5000 });
  });
  it("monta a query de volta sem campos vazios", () => {
    expect(paraQuery(lerFiltros({ tipo: "despesa" }), { pagina: 2 })).toBe("?tipo=despesa&pagina=2");
    expect(paraQuery(lerFiltros({}))).toBe("");
  });
});
