import { describe, expect, it } from "vitest";
import { calcularDigitoCnj, cnjValido, extrairNumerosCnj, formatarCnj, somenteDigitosCnj, tribunalDataJud } from "@/lib/integrations/fontes/cnj";
import { hashPublicacao, htmlParaTexto } from "@/lib/integrations/fontes/normalizar";
import { ErroFonte, FilaRequisicoes } from "@/lib/integrations/fontes/fila";
import { FonteDjen, mapearItemDjen } from "@/lib/integrations/fontes/djen";
import { FonteDataJud } from "@/lib/integrations/fontes/datajud";
import { dataPublicacaoEstimada } from "@/lib/integrations/fontes/datas";
import { PROC_CIVEL, PROC_TRABALHO, cnjExemplo, itensExemplo } from "@/lib/integrations/fontes/exemplos";

// Fila sem espera real, registrando as esperas pedidas.
function filaDeTeste(fonte = "Teste", extra: Partial<ConstructorParameters<typeof FilaRequisicoes>[0]> = {}) {
  const esperas: number[] = [];
  const fila = new FilaRequisicoes({
    fonte, intervaloMinimoMs: 0, maxTentativas: 4, backoffBaseMs: 1000, esperaApos429Ms: 60_000, timeoutMs: 5000,
    dormir: async (ms) => { esperas.push(ms); }, aleatorio: () => 0.5, ...extra,
  });
  return { fila, esperas };
}

const json = (corpo: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("Número CNJ: dígito verificador (módulo 97)", () => {
  it("aceita número real publicado (0000832-35.2018.4.01.3202)", () => {
    expect(cnjValido("0000832-35.2018.4.01.3202")).toBe(true);
    expect(cnjValido("00008323520184013202")).toBe(true);
  });

  it("calcula o dígito e recusa qualquer dígito trocado", () => {
    expect(calcularDigitoCnj("0000832", "2018", "4", "01", "3202")).toBe("35");
    expect(cnjValido("0000832-36.2018.4.01.3202")).toBe(false);
    expect(cnjValido("0000833-35.2018.4.01.3202")).toBe(false);
    expect(cnjValido("0000832-35.2018.4.01.320")).toBe(false);
    expect(cnjValido("")).toBe(false);
    expect(cnjValido(null)).toBe(false);
  });

  it("os números de exemplo são válidos", () => {
    for (const p of [PROC_CIVEL, PROC_TRABALHO]) expect(cnjValido(p.digitos)).toBe(true);
  });

  it("formata e limpa", () => {
    expect(formatarCnj("00008323520184013202")).toBe("0000832-35.2018.4.01.3202");
    expect(somenteDigitosCnj("0000832-35.2018.4.01.3202")).toBe("00008323520184013202");
  });
});

describe("Número CNJ: extração do texto", () => {
  it("acha números com máscara e sem máscara, ignora dígito errado e repetidos", () => {
    const outro = cnjExemplo("0000099", "2024", "8", "26", "0100");
    const texto = `Autos ${PROC_CIVEL.mascara} (apenso ${outro.digitos}). Ref.: 1234567-00.2020.8.05.0001. Repete ${PROC_CIVEL.mascara}.`;
    expect(extrairNumerosCnj(texto)).toEqual([PROC_CIVEL.digitos, outro.digitos]);
  });

  it("não pega pedaço de número maior nem texto vazio", () => {
    expect(extrairNumerosCnj(`9${PROC_CIVEL.digitos}`)).toEqual([]);
    expect(extrairNumerosCnj(`${PROC_CIVEL.digitos}1`)).toEqual([]);
    expect(extrairNumerosCnj(undefined)).toEqual([]);
  });

  it("descobre o índice do tribunal no DataJud", () => {
    expect(tribunalDataJud(PROC_CIVEL.digitos)).toBe("tjba");
    expect(tribunalDataJud(PROC_TRABALHO.digitos)).toBe("trt5");
    expect(tribunalDataJud("00008323520184013202")).toBe("trf1");
    expect(tribunalDataJud(cnjExemplo("0000001", "2024", "5", "00", "0000").digitos)).toBe("tst");
    expect(tribunalDataJud(cnjExemplo("0000001", "2024", "8", "07", "0001").digitos)).toBe("tjdft");
    expect(tribunalDataJud(cnjExemplo("0000001", "2024", "1", "00", "0000").digitos)).toBeNull();
  });
});

describe("Texto e hash de deduplicação", () => {
  it("tira HTML, script e entidades; tag escapada não volta como tag", () => {
    const t = htmlParaTexto("<p>Intima&ccedil;&atilde;o&nbsp;da <b>parte</b></p><script>alert(1)</script><p>&lt;img src=x onerror=alert(1)&gt; fim</p>");
    expect(t).toBe("Intimação da parte\nfim");
  });

  it("mesmo conteúdo com espaços, maiúsculas e acentos diferentes dá o mesmo hash; data diferente muda", () => {
    const base = { tribunal: "TJBA", numeroCnj: PROC_CIVEL.digitos, dataDisponibilizacao: "2026-11-09" };
    const a = hashPublicacao({ ...base, texto: "Intimação  da parte\nautora" });
    const b = hashPublicacao({ ...base, tribunal: "tjba", texto: "INTIMACAO da parte autora " });
    const c = hashPublicacao({ ...base, dataDisponibilizacao: "2026-11-10", texto: "Intimação da parte autora" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("publicação estimada no dia útil seguinte (pula fim de semana e feriado nacional fixo)", () => {
    expect(dataPublicacaoEstimada("2026-11-06")).toBe("2026-11-09"); // sexta → segunda
    expect(dataPublicacaoEstimada("2026-11-19")).toBe("2026-11-23"); // 20/11 feriado, 21-22 fim de semana
  });
});

describe("Fila com espera crescente", () => {
  it("após 429 espera pelo menos 1 minuto e tenta de novo", async () => {
    const { fila, esperas } = filaDeTeste();
    let n = 0;
    const r = await fila.executar(async () => (++n === 1 ? json({}, 429) : json({ ok: true })));
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
    expect(esperas[0]).toBeGreaterThanOrEqual(60_000);
  });

  it("5xx repete com espera dobrando e desiste no limite", async () => {
    const { fila, esperas } = filaDeTeste();
    let n = 0;
    await expect(fila.executar(async () => { n++; return json({}, 503); })).rejects.toMatchObject({ codigo: "indisponivel" });
    expect(n).toBe(4);
    expect(esperas).toEqual([1000, 2000, 4000]);
  });

  it("403 e 401 não repetem", async () => {
    const { fila } = filaDeTeste();
    let n = 0;
    await expect(fila.executar(async () => { n++; return json({}, 403); })).rejects.toMatchObject({ codigo: "bloqueado" });
    await expect(fila.executar(async () => { n++; return json({}, 401); })).rejects.toMatchObject({ codigo: "chave_recusada" });
    expect(n).toBe(2);
  });

  it("falha de rede repete e recupera", async () => {
    const { fila } = filaDeTeste();
    let n = 0;
    const r = await fila.executar(async () => { if (++n < 3) throw new TypeError("fetch failed"); return json({}); });
    expect(r.ok).toBe(true);
  });

  it("respeita o intervalo mínimo entre chamadas", async () => {
    let relogio = 0;
    const esperas: number[] = [];
    const fila = new FilaRequisicoes({
      fonte: "T", intervaloMinimoMs: 500, maxTentativas: 1, backoffBaseMs: 1, esperaApos429Ms: 1, timeoutMs: 1000,
      agora: () => relogio, dormir: async (ms) => { esperas.push(ms); relogio += ms; },
    });
    await Promise.all([fila.executar(async () => json({})), fila.executar(async () => json({})), fila.executar(async () => json({}))]);
    expect(esperas).toEqual([500, 500]);
  });
});

describe("Adaptador DJEN", () => {
  const oab = { numero: "54321", uf: "BA" };

  it("monta a consulta oficial, pagina e converte os itens", async () => {
    const urls: URL[] = [];
    const itens = itensExemplo(oab, "2026-11-09");
    const muitos = Array.from({ length: 100 }, (_, i) => ({ ...itens[3], id: 990000 + i, texto: `Edital ${i}` }));
    const falso: typeof fetch = async (entrada) => {
      const u = new URL(String(entrada));
      urls.push(u);
      return u.searchParams.get("pagina") === "1" ? json({ status: "success", count: 104, items: muitos }) : json({ status: "success", count: 104, items: itens });
    };
    const djen = new FonteDjen({ fetch: falso, fila: filaDeTeste("DJEN").fila });
    const pubs = await djen.buscarPublicacoes({ oab, desde: new Date("2026-11-07T12:00:00Z"), ate: new Date("2026-11-09T12:00:00Z") });

    expect(urls).toHaveLength(2);
    const q = urls[0].searchParams;
    expect(urls[0].origin + urls[0].pathname).toBe("https://comunicaapi.pje.jus.br/api/v1/comunicacao");
    expect(Object.fromEntries(q)).toMatchObject({
      numeroOab: "54321", ufOab: "BA", dataDisponibilizacaoInicio: "2026-11-07", dataDisponibilizacaoFim: "2026-11-09", itensPorPagina: "100",
    });
    expect(pubs).toHaveLength(104);
    const civel = pubs.find((p) => p.idExterno === "910001")!;
    expect(civel.numeroCnj).toBe(PROC_CIVEL.digitos);
    expect(civel.texto).not.toMatch(/script|alert/);
    expect(civel.advogados).toEqual([{ nome: "ADVOGADA EXEMPLO", oab: "54321", uf: "BA" }]);
    const semNumero = pubs.find((p) => p.idExterno === "910004")!;
    expect(semNumero.numeroCnj).toBeNull();
  });

  it("número só no texto é extraído; número com dígito errado é ignorado", () => {
    const [, , item3] = itensExemplo(oab, "2026-11-09");
    const p = mapearItemDjen(item3)!;
    expect(p.numeroCnj).not.toBeNull();
    expect(p.numerosCitados).toHaveLength(1);
  });

  it("acima de 10.000 resultados, refaz a busca dia a dia", async () => {
    const datas: string[] = [];
    const falso: typeof fetch = async (entrada) => {
      const q = new URL(String(entrada)).searchParams;
      const ini = q.get("dataDisponibilizacaoInicio")!, fim = q.get("dataDisponibilizacaoFim")!;
      datas.push(`${ini}..${fim}`);
      return ini === fim ? json({ status: "success", count: 0, items: [] }) : json({ status: "success", count: 10000, items: [] });
    };
    const djen = new FonteDjen({ fetch: falso, fila: filaDeTeste("DJEN").fila });
    await djen.buscarPublicacoes({ oab, desde: new Date("2026-11-07T12:00:00Z"), ate: new Date("2026-11-09T12:00:00Z") });
    expect(datas).toEqual(["2026-11-07..2026-11-09", "2026-11-07..2026-11-07", "2026-11-08..2026-11-08", "2026-11-09..2026-11-09"]);
  });

  it("bloqueio (403, acesso de fora do Brasil) vira erro claro, sem repetir", async () => {
    let n = 0;
    const djen = new FonteDjen({ fetch: async () => { n++; return new Response("<html>403 ERROR</html>", { status: 403 }); }, fila: filaDeTeste("DJEN").fila });
    await expect(djen.buscarPublicacoes({ oab, desde: new Date() })).rejects.toMatchObject({ codigo: "bloqueado" });
    expect(n).toBe(1);
  });

  it("filtro vazio é recusado antes de chamar a API", async () => {
    const djen = new FonteDjen({ fetch: async () => json({}), fila: filaDeTeste("DJEN").fila });
    await expect(djen.buscarPublicacoes({ cnpj: "11222333000181", desde: new Date() })).rejects.toBeInstanceOf(ErroFonte);
  });
});

describe("Adaptador DataJud", () => {
  const fonteTjba = {
    numeroProcesso: PROC_CIVEL.digitos, tribunal: "TJBA", grau: "G1", dataAjuizamento: "20250314000000", nivelSigilo: 0,
    classe: { codigo: 7, nome: "Procedimento Comum Cível" },
    orgaoJulgador: { codigo: 1, nome: "3ª Vara Cível" },
    assuntos: [{ codigo: 10433, nome: "Indenização por Dano Moral" }],
    movimentos: [
      { codigo: 26, nome: "Distribuição", dataHora: "2025-03-14T10:00:00.000Z" },
      { codigo: 123, nome: "Remessa", dataHora: "2025-04-01T10:00:00.000Z", complementosTabelados: [{ nome: "motivo", descricao: "em grau de recurso" }] },
    ],
  };

  it("chama o índice do tribunal certo com a chave e converte a resposta", async () => {
    let pedido: { url: string; init?: RequestInit } | null = null;
    const dj = new FonteDataJud({
      apiKey: "chave-publica",
      fetch: async (url, init) => { pedido = { url: String(url), init }; return json({ hits: { hits: [{ _source: fonteTjba }] } }); },
      fila: filaDeTeste("DataJud").fila,
    });
    const p = await dj.buscarProcesso(PROC_CIVEL.mascara);
    expect(pedido!.url).toBe("https://api-publica.datajud.cnj.jus.br/api_publica_tjba/_search");
    expect((pedido!.init!.headers as Record<string, string>).Authorization).toBe("APIKey chave-publica");
    expect(JSON.parse(String(pedido!.init!.body))).toEqual({ size: 10, query: { match: { numeroProcesso: PROC_CIVEL.digitos } } });
    expect(p).toMatchObject({
      tribunal: "TJBA", classe: { codigo: "7", nome: "Procedimento Comum Cível" }, orgaoJulgador: "3ª Vara Cível",
      dataAjuizamento: "2025-03-14T00:00:00", partes: [],
    });
    expect(p!.movimentos.map((m) => m.nome)).toEqual(["Distribuição", "Remessa"]);
    expect(p!.movimentos[1].complementos).toEqual(["motivo: em grau de recurso"]);
  });

  it("processo não encontrado (ou em segredo de justiça) volta null", async () => {
    const dj = new FonteDataJud({ apiKey: "k", fetch: async () => json({ hits: { hits: [] } }), fila: filaDeTeste().fila });
    expect(await dj.buscarProcesso(PROC_CIVEL.digitos)).toBeNull();
  });

  it("sem chave ou com chave recusada, erro claro", async () => {
    const semChave = new FonteDataJud({ apiKey: undefined, fetch: async () => json({}), fila: filaDeTeste().fila });
    await expect(semChave.buscarProcesso(PROC_CIVEL.digitos)).rejects.toMatchObject({ codigo: "chave_recusada" });
    const vencida = new FonteDataJud({ apiKey: "velha", fetch: async () => json({}, 401), fila: filaDeTeste().fila });
    await expect(vencida.buscarProcesso(PROC_CIVEL.digitos)).rejects.toMatchObject({ codigo: "chave_recusada" });
  });

  it("STF/CNJ ficam de fora da API pública", async () => {
    let chamou = false;
    const dj = new FonteDataJud({ apiKey: "k", fetch: async () => { chamou = true; return json({}); }, fila: filaDeTeste().fila });
    expect(await dj.buscarProcesso(cnjExemplo("0000001", "2024", "1", "00", "0000").digitos)).toBeNull();
    expect(chamou).toBe(false);
  });
});
