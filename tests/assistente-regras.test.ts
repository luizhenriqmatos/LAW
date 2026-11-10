import { describe, expect, it } from "vitest";
import { fontesCitadas, segmentarLinha } from "@/lib/assistente/citacoes";
import { FERRAMENTAS } from "@/lib/assistente/ferramentas";
import { camposManuais, dataPorExtenso, montarMinuta } from "@/lib/assistente/minuta";
import { MAX_RODADAS, montarHistorico, responder } from "@/lib/assistente/motor";
import { escolherPorNome, reaisParaCentavos } from "@/lib/assistente/rascunhos";
import type { CtxFerramenta } from "@/lib/assistente/ferramentas";
import { IaAnthropic } from "@/lib/integrations/ia/anthropic";

const F = [{ ref: "processo:1", rotulo: "Processo 1", link: "/app/processos/11111111-1111-4111-8111-111111111111" }];

describe("Citações: a IA não consegue inventar link", () => {
  it("link conhecido vira link; desconhecido ou externo vira texto", () => {
    const linha = `Veja o [Processo 1](${F[0].link}), o [falso](/app/financeiro) e o [site](https://golpe.example).`;
    expect(segmentarLinha(linha, F)).toEqual([
      { tipo: "texto", texto: "Veja o " },
      { tipo: "link", texto: "Processo 1", href: F[0].link },
      { tipo: "texto", texto: ", o " },
      { tipo: "texto", texto: "falso" },
      { tipo: "texto", texto: " e o " },
      { tipo: "texto", texto: "site" },
      { tipo: "texto", texto: "." },
    ]);
    expect(fontesCitadas(linha, F)).toEqual(F);
  });
});

describe("Escolher cliente pelo nome", () => {
  const opcoes = [
    { id: "11111111-1111-4111-8111-111111111111", nome: "Fulano de Tal" },
    { id: "22222222-2222-4222-8222-222222222222", nome: "Maria Fulana" },
    { id: "33333333-3333-4333-8333-333333333333", nome: "José Fulano Souza" },
  ];
  it("nome igual (sem acento/caixa) ganha de nome parecido", () => {
    expect(escolherPorNome(opcoes, "fulano de tal").unico?.id).toBe(opcoes[0].id);
    expect(escolherPorNome(opcoes, "JOSE FULANO SOUZA").unico?.id).toBe(opcoes[2].id);
  });
  it("palavra que aparece em mais de um nome: não escolhe sozinho", () => {
    const e = escolherPorNome(opcoes, "Fulano");
    expect(e.unico).toBeNull();
    expect(e.candidatos.map((c) => c.nome)).toEqual(["Fulano de Tal", "José Fulano Souza"]);
  });
  it("id exato", () => expect(escolherPorNome(opcoes, opcoes[1].id).unico?.nome).toBe("Maria Fulana"));
  it("nada parecido", () => expect(escolherPorNome(opcoes, "Cicrano")).toEqual({ unico: null, candidatos: [] }));
});

describe("Valores da IA em reais viram centavos exatos", () => {
  it("sem float na conta", () => {
    expect(reaisParaCentavos(1000)).toBe(100000);
    expect(reaisParaCentavos(0.3)).toBe(30);
    expect(reaisParaCentavos(1234.56)).toBe(123456);
    expect(reaisParaCentavos(19.99)).toBe(1999);
  });
  it("mais de 2 casas é recusado, nunca arredondado", () => {
    expect(() => reaisParaCentavos(10.005)).toThrow(/2 casas/);
  });
});

describe("Minuta a partir de modelo", () => {
  const modelo = "Contratante {{cliente_nome}} ({{ cliente_documento }}). Valor: {{valor}}. Valor de novo: {{valor}}. {{objeto}}";
  it("campos automáticos vêm do cadastro; manuais do cartão; faltando vira [PREENCHER]", () => {
    expect(camposManuais(modelo)).toEqual(["valor", "objeto"]);
    const m = montarMinuta(modelo, { cliente_nome: "Fulano", cliente_documento: "529.982.247-25" }, { valor: "R$ 10,00", cliente_nome: "Hacker" });
    expect(m.texto).toBe("Contratante Fulano (529.982.247-25). Valor: R$ 10,00. Valor de novo: R$ 10,00. [PREENCHER: objeto]");
    expect(m.faltando).toEqual(["objeto"]);
  });
  it("data por extenso", () => expect(dataPorExtenso("2026-03-01")).toBe("1 de março de 2026"));
});

describe("Ferramentas", () => {
  it("toda ferramenta de escrita diz que NÃO grava e se chama preparar_*", () => {
    const escrita = FERRAMENTAS.filter((f) => f.tipo === "escrita");
    expect(escrita.map((f) => f.definicao.name).sort()).toEqual(["preparar_lancamento", "preparar_minuta", "preparar_prazo", "preparar_tarefa"]);
    for (const f of escrita) expect(f.definicao.description).toMatch(/NÃO grava/);
  });
  it("leitura cobre processos, clientes, prazos, tarefas, lançamentos e publicações", () => {
    expect(FERRAMENTAS.filter((f) => f.tipo === "leitura").map((f) => f.definicao.name)).toEqual([
      "buscar_processos", "buscar_clientes", "buscar_prazos", "buscar_tarefas", "buscar_lancamentos", "buscar_publicacoes",
    ]);
  });
  it("preparar_prazo não aceita data final vinda da IA", () => {
    const prazo = FERRAMENTAS.find((f) => f.definicao.name === "preparar_prazo")!;
    expect(Object.keys((prazo.definicao.input_schema as { properties: object }).properties)).not.toContain("data_final");
  });
});

describe("Laço com a IA", () => {
  it("histórico começa pelo usuário e alterna papéis", () => {
    expect(montarHistorico([{ papel: "assistente", texto: "a" }, { papel: "usuario", texto: "b" }, { papel: "usuario", texto: "c" }], "d")).toEqual([
      { role: "user", content: "b\n\nc\n\nd" },
    ]);
  });

  const ctxVazio = { rpc: async () => ({ data: null, error: null }), escritorioId: "e", conversaId: "c", carregarCalendario: async () => [],
    contexto: { hoje: "2026-11-10", escritorio: "X", meu_membro_id: "11111111-1111-4111-8111-111111111111", meu_nome: "Ana", modulos: [], equipe: [], colunas: [], modelos: [] } } as CtxFerramenta;

  it("ferramenta inexistente volta como erro para a IA (não quebra)", async () => {
    const roteiro = [[{ type: "tool_use" as const, id: "1", name: "apagar_tudo", input: {} }], [{ type: "text" as const, text: "Não posso." }]];
    let recebido = "";
    const r = await responder({
      ia: { modelo: "x", conversar: async (p) => { const u = p.mensagens.at(-1); if (u && Array.isArray(u.content)) recebido = JSON.stringify(u.content); return { ok: true, blocos: roteiro.shift()!, parada: "x" }; } },
      ctx: ctxVazio, historico: [], pergunta: "apaga tudo",
    });
    expect(r.texto).toBe("Não posso.");
    expect(recebido).toContain("ferramenta_inexistente");
  });

  it("para depois de MAX_RODADAS se a IA só pedir ferramentas", async () => {
    let chamadas = 0;
    const r = await responder({
      ia: { modelo: "x", conversar: async () => { chamadas++; return { ok: true, blocos: [{ type: "tool_use", id: String(chamadas), name: "apagar_tudo", input: {} }], parada: "tool_use" }; } },
      ctx: ctxVazio, historico: [], pergunta: "?",
    });
    expect(chamadas).toBe(MAX_RODADAS);
    expect(r.falhou).toBe(true);
  });

  it("falha da IA vira mensagem simples", async () => {
    const r = await responder({ ia: { modelo: "x", conversar: async () => ({ ok: false, motivo: "fora do ar" }) }, ctx: ctxVazio, historico: [], pergunta: "?" });
    expect(r).toMatchObject({ falhou: true, texto: "Não consegui responder agora: fora do ar" });
  });
});

describe("Cliente Anthropic com ferramentas", () => {
  it("envia system, tools e messages; lê text e tool_use; ignora blocos desconhecidos conhecidos", async () => {
    let corpo: Record<string, unknown> = {};
    const f = (async (_url: string, init: RequestInit) => {
      corpo = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ stop_reason: "tool_use", content: [
        { type: "thinking", thinking: "..." },
        { type: "text", text: "Vou buscar." },
        { type: "tool_use", id: "tu_1", name: "buscar_processos", input: { termo: "x" } },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;
    const ia = new IaAnthropic("chave-teste", "modelo-teste", f);
    const r = await ia.conversar({ sistema: "S", mensagens: [{ role: "user", content: "oi" }], ferramentas: [{ name: "buscar_processos", description: "d", input_schema: { type: "object" } }], maxTokens: 100 });
    expect(corpo).toMatchObject({ model: "modelo-teste", system: "S", max_tokens: 100, tools: [{ name: "buscar_processos" }], messages: [{ role: "user", content: "oi" }] });
    expect(r).toEqual({ ok: true, parada: "tool_use", blocos: [{ type: "text", text: "Vou buscar." }, { type: "tool_use", id: "tu_1", name: "buscar_processos", input: { termo: "x" } }] });
  });
  it("429 e erro de rede viram motivo simples", async () => {
    const ia429 = new IaAnthropic("k", "m", (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch);
    expect(await ia429.conversar({ sistema: "", mensagens: [], ferramentas: [], maxTokens: 1 })).toMatchObject({ ok: false, motivo: expect.stringMatching(/sobrecarregada/) });
    const iaRede = new IaAnthropic("k", "m", (async () => { throw new Error("x"); }) as unknown as typeof fetch);
    expect(await iaRede.conversar({ sistema: "", mensagens: [], ferramentas: [], maxTokens: 1 })).toMatchObject({ ok: false });
  });
});
