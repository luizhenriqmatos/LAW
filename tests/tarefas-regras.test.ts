import { describe, expect, it } from "vitest";
import { diaValido, horaBrasilia, isoParaLocal, localParaIso, mesValido, mesVizinho, nomeDoMes, semanasDoMes } from "@/lib/agenda/calendario";
import { daColuna, lerEtiquetas, progressoChecklist, reordenar } from "@/lib/tarefas/ordem";

const item = (id: string, colunaId: string, posicao: number) => ({ id, colunaId, posicao });
const ids = (l: { id: string }[]) => l.map((i) => i.id);

describe("reordenar (mesma regra do banco)", () => {
  const base = [item("a", "c1", 1), item("b", "c1", 2), item("c", "c1", 3), item("x", "c2", 1)];
  it("dentro da coluna", () => {
    expect(ids(daColuna(reordenar(base, "c", "c1", 0), "c1"))).toEqual(["c", "a", "b"]);
    expect(ids(daColuna(reordenar(base, "a", "c1", 1), "c1"))).toEqual(["b", "a", "c"]);
    expect(ids(daColuna(reordenar(base, "a", "c1", 99), "c1"))).toEqual(["b", "c", "a"]);
  });
  it("entre colunas: renumera origem e destino 1..n", () => {
    const r = reordenar(base, "b", "c2", 0);
    expect(daColuna(r, "c1").map((i) => `${i.posicao}${i.id}`)).toEqual(["1a", "2c"]);
    expect(daColuna(r, "c2").map((i) => `${i.posicao}${i.id}`)).toEqual(["1b", "2x"]);
  });
  it("para coluna vazia, índice negativo, NaN e id desconhecido", () => {
    expect(ids(daColuna(reordenar(base, "a", "c3", 5), "c3"))).toEqual(["a"]);
    expect(ids(daColuna(reordenar(base, "c", "c1", -4), "c1"))[0]).toBe("c");
    expect(ids(daColuna(reordenar(base, "c", "c1", Number.NaN), "c1"))[0]).toBe("c");
    expect(reordenar(base, "zzz", "c1", 0)).toHaveLength(4);
  });
  it("não muda a lista original", () => {
    const copia = JSON.stringify(base);
    reordenar(base, "a", "c2", 0);
    expect(JSON.stringify(base)).toBe(copia);
  });
});

describe("etiquetas e checklist", () => {
  it("lerEtiquetas tira vazias e repetidas (sem diferenciar maiúsculas) e limita tamanho e quantidade", () => {
    expect(lerEtiquetas("urgente, Cível ,URGENTE,, ")).toEqual(["urgente", "Cível"]);
    expect(lerEtiquetas("a".repeat(50))[0]).toHaveLength(30);
    expect(lerEtiquetas(Array.from({ length: 30 }, (_, i) => `e${i}`).join(","))).toHaveLength(15);
  });
  it("progresso do checklist", () => {
    expect(progressoChecklist([{ id: "1", texto: "a", feito: true }, { id: "2", texto: "b", feito: false }])).toEqual({ feitos: 1, total: 2 });
    expect(progressoChecklist([])).toEqual({ feitos: 0, total: 0 });
  });
});

describe("calendário do mês", () => {
  it("valida mês e dia", () => {
    expect(mesValido("2026-11")).toBe("2026-11");
    expect(mesValido("2026-13")).toBeNull();
    expect(mesValido(undefined)).toBeNull();
    expect(diaValido("2026-02-29")).toBeNull(); // 2026 não é bissexto
    expect(diaValido("2028-02-29")).toBe("2028-02-29");
    expect(diaValido("2026-11-9")).toBeNull();
  });
  it("navega entre meses virando o ano", () => {
    expect(mesVizinho("2026-12", 1)).toBe("2027-01");
    expect(mesVizinho("2026-01", -1)).toBe("2025-12");
    expect(nomeDoMes("2026-03")).toBe("março de 2026");
  });
  it("grade em semanas completas de domingo a sábado, com os dias do mês marcados", () => {
    const s = semanasDoMes("2026-11"); // 1/11/2026 é domingo; 30/11 é segunda
    expect(s[0][0]).toEqual({ dia: "2026-11-01", doMes: true });
    expect(s.every((w) => w.length === 7)).toBe(true);
    expect(s[s.length - 1][6].dia).toBe("2026-12-05");
    expect(s.flat().filter((d) => d.doMes)).toHaveLength(30);
    expect(s.flat().length).toBeLessThanOrEqual(42);
    const fev = semanasDoMes("2026-02"); // começa num domingo, 28 dias: 4 semanas exatas
    expect(fev).toHaveLength(4);
  });
  it("hora e conversões em Brasília (UTC-3)", () => {
    expect(horaBrasilia("2026-11-10T13:00:00+00:00")).toBe("10:00");
    expect(localParaIso("2026-11-10T10:00")).toBe("2026-11-10T10:00:00-03:00");
    expect(localParaIso("10/11/2026 10:00")).toBeNull();
    expect(isoParaLocal("2026-11-10T13:00:00+00:00")).toBe("2026-11-10T10:00");
    expect(isoParaLocal(localParaIso("2026-12-31T23:30")!)).toBe("2026-12-31T23:30");
  });
});
