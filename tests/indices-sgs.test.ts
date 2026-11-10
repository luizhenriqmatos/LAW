import { describe, expect, it } from "vitest";
import { atualizarIndices, lerRespostaSgs, SERIES_SGS, urlSgs } from "@/lib/integrations/bcb/sgs";
import { criarBanco, rpcComoServico } from "./db/banco";

describe("SGS do Banco Central", () => {
  it("monta a URL oficial com datas no formato dd/mm/aaaa", () => {
    expect(urlSgs(29543, "2024-11-01", "2026-11-09")).toBe("https://api.bcb.gov.br/dados/serie/bcdata.sgs.29543/dados?formato=json&dataInicial=01/11/2024&dataFinal=09/11/2026");
  });

  it("lê a resposta; descarta a Selic do mês corrente (parcial) e qualquer mês futuro", () => {
    const resp = [{ data: "01/10/2026", valor: "1.09" }, { data: "01/11/2026", valor: "0.25" }, { data: "01/12/2026", valor: "9" }];
    expect(lerRespostaSgs(resp, "SELIC", "2026-11")).toEqual([{ mes: "2026-10-01", valor: "1.09" }]);
    expect(lerRespostaSgs(resp, "TAXA_LEGAL", "2026-11")).toEqual([{ mes: "2026-10-01", valor: "1.09" }, { mes: "2026-11-01", valor: "0.25" }]);
  });

  it("recusa resposta fora do formato (não grava lixo)", () => {
    expect(() => lerRespostaSgs({ erro: "x" }, "IPCA", "2026-11")).toThrow(/formato/);
    expect(() => lerRespostaSgs([{ data: "2026-10-01", valor: "1" }], "IPCA", "2026-11")).toThrow(/Data inesperada/);
    expect(() => lerRespostaSgs([{ data: "01/10/2026", valor: "1,5" }], "IPCA", "2026-11")).toThrow(/Valor inesperado/);
  });

  it("job: grava no cache; série com erro registra o erro e não para as outras", async () => {
    const db = await criarBanco();
    const chamadas: string[] = [];
    const fakeFetch = (async (url: string) => {
      chamadas.push(url);
      if (url.includes(`sgs.${SERIES_SGS.IGP_M}/`)) return new Response("<html>fora do ar</html>", { status: 503 });
      return Response.json([{ data: "01/10/2026", valor: "0.42" }]);
    }) as typeof fetch;
    const r = await atualizarIndices({ fetch: fakeFetch, rpc: rpcComoServico(db), hoje: "2026-11-09" });
    expect(chamadas).toHaveLength(8);
    expect(chamadas[0]).toContain("dataInicial=01/11/2024");
    expect(r.filter((x) => !x.ok).map((x) => x.serie)).toEqual(["IGP_M"]);
    const s = (await db.query<{ codigo: string; erro: string | null; ultimo_mes: string }>("select codigo, erro, ultimo_mes::text from public.indice_serie order by codigo")).rows;
    expect(s.find((x) => x.codigo === "IGP_M")!.erro).toMatch(/503/);
    expect(s.find((x) => x.codigo === "IPCA")).toMatchObject({ erro: null, ultimo_mes: "2026-10-01" });
    expect((await db.query<{ v: string }>("select valor::text as v from public.indice_valor where serie = 'INPC' and mes = '2026-10-01'")).rows[0].v).toBe("0.4200000000");
  });
});
