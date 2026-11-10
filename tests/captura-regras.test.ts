import { describe, expect, it } from "vitest";
import { situacaoCaptura } from "@/lib/captura/atraso";

const em = (iso: string) => new Date(iso);

describe("Aviso de captura atrasada", () => {
  const base = { modo: "oab", status: "concluido" };

  it("depois das 8h, só a captura de hoje conta", () => {
    expect(situacaoCaptura({ ...base, ultimaOk: "2026-11-09T07:05:00Z" }, em("2026-11-09T12:00:00Z"))).toBe("em_dia"); // 04h05 → 09h
    expect(situacaoCaptura({ ...base, ultimaOk: "2026-11-08T07:05:00Z" }, em("2026-11-09T12:00:00Z"))).toBe("atrasada");
  });

  it("antes das 8h, a de ontem ainda vale (a de hoje pode estar rodando)", () => {
    expect(situacaoCaptura({ ...base, ultimaOk: "2026-11-08T07:05:00Z" }, em("2026-11-09T09:30:00Z"))).toBe("em_dia"); // 06h30
    expect(situacaoCaptura({ ...base, ultimaOk: "2026-11-07T07:05:00Z" }, em("2026-11-09T09:30:00Z"))).toBe("atrasada");
  });

  it("usa o dia de Brasília, não o do servidor (22h de domingo em Brasília = segunda em UTC)", () => {
    expect(situacaoCaptura({ ...base, ultimaOk: "2026-11-08T07:05:00Z" }, em("2026-11-09T01:00:00Z"))).toBe("em_dia");
  });

  it("falha vira alerta; sem configuração ou antes da primeira captura, não", () => {
    expect(situacaoCaptura({ modo: "oab", status: "erro", ultimaOk: "2026-11-09T07:05:00Z" }, em("2026-11-09T12:00:00Z"))).toBe("falhou");
    expect(situacaoCaptura({ modo: null, status: "nao_configurado", ultimaOk: null })).toBe("nao_configurada");
    expect(situacaoCaptura({ modo: "oab", status: "aguardando_busca", ultimaOk: null })).toBe("aguardando_primeira");
    expect(situacaoCaptura({ modo: "oab", status: "concluido", ultimaOk: null })).toBe("atrasada");
  });
});
