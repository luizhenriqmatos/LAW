import { describe, expect, it } from "vitest";
import { alertasDevidos, horaBrasilia, situacaoDoPrazo, type AlertaEnviado } from "@/lib/prazos/alertas";

// 7h em Brasília/Bahia (UTC-3) = 10h UTC.
const as7 = (dia: string) => new Date(`${dia}T10:00:00Z`);
const prazo = { id: "p1", dataFinal: "2026-11-20", status: "aberto" };

describe("Alertas com relógio simulado", () => {
  it("fuso: 10h UTC são 7h em Brasília", () => {
    expect(horaBrasilia(new Date("2026-11-17T10:00:00Z"))).toBe(7);
    expect(horaBrasilia(new Date("2026-11-17T09:59:00Z"))).toBe(6);
    expect(horaBrasilia(new Date("2026-11-17T02:30:00Z"))).toBe(23); // dia anterior, noite
  });

  it("nada antes das 7h", () => {
    expect(alertasDevidos([prazo], [], new Date("2026-11-17T09:59:00Z"))).toEqual([]);
    expect(alertasDevidos([prazo], [], new Date("2026-11-20T09:00:00Z"))).toEqual([]);
  });

  it("três momentos: 3 dias antes, no dia e depois de vencido (todo dia)", () => {
    const enviados: AlertaEnviado[] = [];
    const passo = (dia: string) => {
      const d = alertasDevidos([prazo], enviados, as7(dia));
      enviados.push(...d.map((x) => ({ prazoId: x.prazoId, tipo: x.tipo, dataRef: x.dataRef })));
      return d.map((x) => x.tipo);
    };
    expect(passo("2026-11-16")).toEqual([]); // 4 dias antes
    expect(passo("2026-11-17")).toEqual(["antes_3"]); // 3 dias antes
    expect(passo("2026-11-17")).toEqual([]); // rodar de novo no mesmo dia não repete
    expect(passo("2026-11-18")).toEqual([]);
    expect(passo("2026-11-19")).toEqual([]);
    expect(passo("2026-11-20")).toEqual(["dia"]); // no dia do vencimento
    expect(passo("2026-11-21")).toEqual(["vencido"]); // depois de vencido...
    expect(passo("2026-11-22")).toEqual(["vencido"]); // ...todo dia
    expect(passo("2026-11-22")).toEqual([]);
    expect(passo("2026-12-30")).toEqual(["vencido"]);
  });

  it("marcado como cumprido ou cancelado, para de avisar", () => {
    for (const status of ["cumprido", "cancelado"]) {
      expect(alertasDevidos([{ ...prazo, status }], [], as7("2026-11-25"))).toEqual([]);
    }
  });

  it("prazo criado em cima da hora ainda recebe o aviso de proximidade uma vez", () => {
    expect(alertasDevidos([prazo], [], as7("2026-11-19")).map((a) => a.tipo)).toEqual(["antes_3"]);
  });

  it("se o job atrasa e perde o dia do vencimento, já cai direto em 'vencido'", () => {
    expect(alertasDevidos([prazo], [], as7("2026-11-21")).map((a) => a.tipo)).toEqual(["vencido"]);
  });

  it("situação: aberto, cumprido, vencido e cancelado", () => {
    expect(situacaoDoPrazo("aberto", "2026-11-20", "2026-11-20")).toBe("aberto");
    expect(situacaoDoPrazo("aberto", "2026-11-20", "2026-11-21")).toBe("vencido");
    expect(situacaoDoPrazo("cumprido", "2026-11-20", "2026-12-01")).toBe("cumprido");
    expect(situacaoDoPrazo("cancelado", "2026-11-20", "2026-12-01")).toBe("cancelado");
  });
});
