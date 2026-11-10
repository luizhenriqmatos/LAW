import { describe, expect, it } from "vitest";
import {
  AVISO_PRAZO, calcularPrazo, emRecesso, entradasDoTribunal, ErroContagem, motivoNaoUtil, sugerirDiasDoTexto, ufDoTribunal,
  type EntradaCalendario,
} from "@/lib/prazos/contagem";

// Calendário de teste (datas conferidas à mão; 09/11/2026 é segunda-feira).
const nac = (data: string, descricao: string): EntradaCalendario => ({ data, escopo: "nacional", tipo: "feriado", descricao });
const NACIONAL: EntradaCalendario[] = [
  nac("2026-04-21", "Tiradentes"), nac("2026-10-12", "Nossa Senhora Aparecida"), nac("2026-11-02", "Finados"),
  nac("2026-11-15", "Proclamação da República"), nac("2026-11-20", "Consciência Negra"), nac("2026-12-25", "Natal"),
  nac("2027-01-01", "Confraternização Universal"),
];
const BA_2_JULHO: EntradaCalendario = { data: "2026-07-02", escopo: "estadual", uf: "BA", tipo: "feriado", descricao: "Independência da Bahia" };
const CARNAVAL_TJBA: EntradaCalendario[] = [
  { data: "2027-02-08", escopo: "tribunal", tribunal: "TJBA", tipo: "feriado", descricao: "Carnaval (segunda)" },
  { data: "2027-02-09", escopo: "tribunal", tribunal: "TJBA", tipo: "feriado", descricao: "Carnaval (terça)" },
];
const TUDO = [...NACIONAL, BA_2_JULHO, ...CARNAVAL_TJBA];

describe("Sexta-feira", () => {
  it("disponibilizado na sexta: publica na segunda, conta a partir da terça (pulando o feriado do meio)", () => {
    const r = calcularPrazo({ disponibilizacao: "2026-10-02", dias: 5, calendario: NACIONAL });
    expect(r.publicacao).toBe("2026-10-05"); // segunda
    expect(r.inicioContagem).toBe("2026-10-06"); // terça = dia 1
    // 6(1) 7(2) 8(3) 9(4) [12/10 feriado] 13(5)
    expect(r.dataFinal).toBe("2026-10-13");
    expect(r.prorrogado).toBe(false);
    expect(r.diasPulados.map((p) => [p.data, p.motivo])).toEqual([
      ["2026-10-03", "fim_de_semana"], ["2026-10-04", "fim_de_semana"], ["2026-10-10", "fim_de_semana"],
      ["2026-10-11", "fim_de_semana"], ["2026-10-12", "feriado"],
    ]);
  });

  it("prazo de 1 dia útil termina no dia 1 (o dia de início conta)", () => {
    expect(calcularPrazo({ disponibilizacao: "2026-10-02", dias: 1, calendario: NACIONAL }).dataFinal).toBe("2026-10-06");
  });
});

describe("Véspera de feriado", () => {
  it("disponibilizado na segunda 20/04, feriado na terça 21/04: publica quarta, começa quinta", () => {
    const r = calcularPrazo({ disponibilizacao: "2026-04-20", dias: 5, calendario: NACIONAL });
    expect(r.publicacao).toBe("2026-04-22");
    expect(r.inicioContagem).toBe("2026-04-23");
    expect(r.dataFinal).toBe("2026-04-29"); // 23(1) 24(2) 27(3) 28(4) 29(5)
    expect(r.diasPulados[0]).toMatchObject({ data: "2026-04-21", motivo: "feriado", descricao: "Tiradentes" });
  });
});

describe("Recesso de fim de ano (20/12 a 20/01)", () => {
  it("limites do recesso", () => {
    expect(emRecesso("2026-12-19")).toBe(false);
    expect(emRecesso("2026-12-20")).toBe(true);
    expect(emRecesso("2027-01-20")).toBe(true);
    expect(emRecesso("2027-01-21")).toBe(false);
  });

  it("disponibilizado em 18/12: publica em 21/01, começa em 22/01 e termina em 11/02 (15 úteis)", () => {
    const r = calcularPrazo({ disponibilizacao: "2026-12-18", dias: 15, calendario: NACIONAL });
    expect(r.publicacao).toBe("2027-01-21");
    expect(r.inicioContagem).toBe("2027-01-22");
    expect(r.dataFinal).toBe("2027-02-11");
    expect(r.diasPulados.some((p) => p.motivo === "recesso" && p.data === "2026-12-25")).toBe(true);
  });

  it("prazo que começa antes e atravessa o recesso fica suspenso e retoma em 21/01", () => {
    const r = calcularPrazo({ disponibilizacao: "2026-12-14", dias: 10, calendario: NACIONAL });
    expect(r.inicioContagem).toBe("2026-12-16");
    // 16(1) 17(2) 18(3) [recesso] 21/01(4) 22(5) 25(6) 26(7) 27(8) 28(9) 29(10)
    expect(r.dataFinal).toBe("2027-01-29");
  });

  it("disponibilizado no último dia do recesso (20/01): publica em 21/01", () => {
    const r = calcularPrazo({ disponibilizacao: "2027-01-20", dias: 1, calendario: NACIONAL });
    expect(r.publicacao).toBe("2027-01-21");
    expect(r.dataFinal).toBe("2027-01-22");
  });

  it("prazo em dias corridos também é suspenso no recesso", () => {
    const r = calcularPrazo({ disponibilizacao: "2026-12-11", dias: 10, tipo: "corrido", calendario: NACIONAL });
    expect(r.inicioContagem).toBe("2026-12-15");
    // 15(1) 16(2) 17(3) 18(4) 19(5) [20/12 a 20/01] 21/01(6) 22(7) 23(8) 24(9) 25(10)
    expect(r.dataFinal).toBe("2027-01-25");
  });

  it("suspensão cadastrada pelo tribunal (Carnaval) empurra o prazo", () => {
    const sem = calcularPrazo({ disponibilizacao: "2026-12-18", dias: 15, calendario: NACIONAL });
    const com = calcularPrazo({ disponibilizacao: "2026-12-18", dias: 15, calendario: [...NACIONAL, ...CARNAVAL_TJBA] });
    expect(sem.dataFinal).toBe("2027-02-11");
    expect(com.dataFinal).toBe("2027-02-15"); // pula 08 e 09/02
  });
});

describe("Feriado estadual", () => {
  const disponibilizacao = "2026-07-01"; // quarta; 02/07 (quinta) é feriado na Bahia

  it("no TJBA o 2 de Julho é pulado", () => {
    const cal = entradasDoTribunal(TUDO, "TJBA");
    const r = calcularPrazo({ disponibilizacao, dias: 5, calendario: cal });
    expect(r.publicacao).toBe("2026-07-03");
    expect(r.inicioContagem).toBe("2026-07-06");
    expect(r.dataFinal).toBe("2026-07-10");
    expect(r.diasPulados[0]).toMatchObject({ data: "2026-07-02", motivo: "feriado", descricao: "Independência da Bahia" });
  });

  it("no TJSP o mesmo dia é útil", () => {
    const r = calcularPrazo({ disponibilizacao, dias: 5, calendario: entradasDoTribunal(TUDO, "TJSP") });
    expect(r.publicacao).toBe("2026-07-02");
    expect(r.dataFinal).toBe("2026-07-09");
  });

  it("filtra o calendário por tribunal e UF", () => {
    expect(ufDoTribunal("TJBA")).toBe("BA");
    expect(ufDoTribunal("TRT5")).toBe("BA");
    expect(ufDoTribunal("STJ")).toBeNull();
    expect(entradasDoTribunal(TUDO, "TJBA")).toContain(BA_2_JULHO);
    expect(entradasDoTribunal(TUDO, "TJBA")).toEqual(expect.arrayContaining(CARNAVAL_TJBA));
    expect(entradasDoTribunal(TUDO, "TJSP")).not.toContain(BA_2_JULHO);
    expect(entradasDoTribunal(TUDO, "TJSP")).not.toContain(CARNAVAL_TJBA[0]);
    expect(entradasDoTribunal(TUDO, null)).toEqual(NACIONAL); // tribunal desconhecido: só o nacional
    const municipal: EntradaCalendario = { data: "2026-12-08", escopo: "municipal", tribunal: "TJBA", tipo: "feriado", descricao: "N. Sra. da Conceição (Salvador)" };
    expect(entradasDoTribunal([municipal], "TJBA")).toEqual([municipal]);
    expect(entradasDoTribunal([municipal], "TJSP")).toEqual([]);
  });

  it("suspensão com data final cobre o intervalo inteiro", () => {
    const greve: EntradaCalendario = { data: "2026-09-14", dataFim: "2026-09-16", escopo: "tribunal", tribunal: "TJBA", tipo: "suspensao", descricao: "Suspensão do expediente" };
    expect(motivoNaoUtil("2026-09-15", [greve])).toMatchObject({ motivo: "suspensao" });
    expect(motivoNaoUtil("2026-09-17", [greve])).toBeNull();
  });
});

describe("Vencimento em dia não útil", () => {
  it("vencimento em sábado (dias corridos) prorroga; e se a segunda for feriado, vai para a terça", () => {
    const r = calcularPrazo({ disponibilizacao: "2026-10-23", dias: 5, tipo: "corrido", calendario: NACIONAL });
    expect(r.inicioContagem).toBe("2026-10-27");
    expect(r.vencimentoBruto).toBe("2026-10-31"); // sábado
    expect(r.prorrogado).toBe(true);
    expect(r.dataFinal).toBe("2026-11-03"); // domingo, segunda 02/11 (Finados) e então terça
    expect(r.passos.some((p) => p.rotulo === "Prorrogação")).toBe(true);
  });

  it("vencimento em domingo e em feriado também prorrogam", () => {
    const dom = calcularPrazo({ disponibilizacao: "2026-10-23", dias: 6, tipo: "corrido", calendario: [] });
    expect(dom.vencimentoBruto).toBe("2026-11-01");
    expect(dom.dataFinal).toBe("2026-11-02");
    const fer = calcularPrazo({ disponibilizacao: "2026-10-23", dias: 6, tipo: "corrido", calendario: NACIONAL });
    expect(fer.dataFinal).toBe("2026-11-03");
  });

  it("prazo em dias úteis nunca vence em dia não útil", () => {
    for (let dias = 1; dias <= 40; dias++) {
      const r = calcularPrazo({ disponibilizacao: "2026-11-09", dias, calendario: TUDO });
      expect(motivoNaoUtil(r.dataFinal, TUDO)).toBeNull();
      expect(r.prorrogado).toBe(false);
    }
  });
});

describe("Raciocínio mostrado ao usuário", () => {
  it("traz disponibilização, publicação, início, contagem e data final, com o aviso fixo", () => {
    const r = calcularPrazo({ disponibilizacao: "2026-10-02", dias: 5, calendario: NACIONAL });
    expect(r.passos.map((p) => p.rotulo)).toEqual(["Disponibilização", "Publicação", "Início da contagem", "Contagem", "Data final sugerida"]);
    expect(r.passos[0].explicacao).toContain("sexta-feira, 02/10/2026");
    expect(r.passos[1].explicacao).toContain("segunda-feira, 05/10/2026");
    expect(r.passos[3].explicacao).toContain("12/10/2026 (Nossa Senhora Aparecida)");
    expect(r.passos.at(-1)!.explicacao).toContain(AVISO_PRAZO);
    expect(AVISO_PRAZO).toBe("Prazo sugerido. Confira no sistema oficial do tribunal.");
  });

  it("é determinístico", () => {
    const e = { disponibilizacao: "2026-12-18", dias: 15, calendario: TUDO };
    expect(calcularPrazo(e)).toEqual(calcularPrazo(e));
  });
});

describe("Entradas inválidas", () => {
  it.each([0, -1, 366, 1.5, Number.NaN])("recusa %s dias", (dias) => {
    expect(() => calcularPrazo({ disponibilizacao: "2026-10-02", dias, calendario: [] })).toThrow(ErroContagem);
  });
  it("recusa data inválida", () => {
    expect(() => calcularPrazo({ disponibilizacao: "02/10/2026", dias: 5, calendario: [] })).toThrow(ErroContagem);
    expect(() => calcularPrazo({ disponibilizacao: "2026-13-45", dias: 5, calendario: [] })).toThrow(ErroContagem);
  });
});

describe("Sugestão de dias a partir do texto", () => {
  it("lê 'prazo de 15 dias' e variações", () => {
    expect(sugerirDiasDoTexto("Intimação para, no prazo de 15 dias, manifestar-se.")).toMatchObject({ dias: 15, tipo: null });
    expect(sugerirDiasDoTexto("no prazo de 5 (cinco) dias úteis")).toMatchObject({ dias: 5, tipo: "util" });
    expect(sugerirDiasDoTexto("PRAZO DE 30 DIAS CORRIDOS")).toMatchObject({ dias: 30, tipo: "corrido" });
  });
  it("sem número claro não inventa", () => {
    expect(sugerirDiasDoTexto("Edital de intimação de advogados.")).toBeNull();
    expect(sugerirDiasDoTexto("prazo de 999 dias")).toBeNull();
  });
});
