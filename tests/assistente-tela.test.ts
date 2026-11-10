import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CartaoRascunho, type RascunhoTela } from "@/app/app/assistente/cartao-rascunho";
import { AvisoSemPermissao, TextoResposta } from "@/app/app/assistente/comum";

const opcoes = { equipe: [{ id: "m1", nome: "Ana", prazos: true, tarefas: true }], colunas: [{ id: "c1", nome: "A fazer" }], clientes: [{ id: "f", nome: "Fulano de Tal" }], processos: [] };
const base = { resumo: "r", avisos: ["aviso x"], status: "pendente" as const, vencido: false, linkResultado: null };
const cartao = (r: RascunhoTela) => renderToStaticMarkup(h(CartaoRascunho, { r, opcoes, confirmar: () => {}, descartar: () => {} })).replace(/\u00a0/g, " ");

describe("Tela da Lia", () => {
  it("cartão de lançamento mostra as 3 parcelas e os botões Confirmar / Editar / Descartar", () => {
    const html = cartao({ ...base, id: "1", tipo: "lancamento", dados: {
      tipo: "receita", categoria: "honorarios_contratuais", descricao: "Honorários", valor_centavos: 300000, parcelas: 3, primeiro_vencimento: "2026-12-10",
      cliente_id: "f", processo_id: null, data_competencia: null, _exibir: { cliente_nome: "Fulano de Tal", candidatos_cliente: [] } } });
    for (const t of ["Confirmar e gravar", "Editar", "Descartar", "nada foi gravado", "Fulano de Tal", "R$ 3.000,00", "10/12/2026", "10/01/2027", "10/02/2027"]) expect(html).toContain(t);
    expect(html.match(/R\$ 1\.000,00/g)?.length).toBe(3);
  });

  it("cartões de tarefa, prazo e minuta renderizam; confirmado não mostra botões", () => {
    expect(cartao({ ...base, id: "2", tipo: "tarefa", dados: { titulo: "Ligar", descricao: "", data: null, responsavel_id: "m1", coluna_id: "c1", etiquetas: [], _exibir: {} } })).toContain("Ligar");
    expect(cartao({ ...base, id: "3", tipo: "prazo", dados: { descricao: "Manifestação", dias: 15, tipo_contagem: "util", data_final: "2026-11-25", responsavel_id: "m1",
      _exibir: { passos: [{ rotulo: "Publicação", data: "2026-11-04", explicacao: "dia útil seguinte" }], processo_numero: "0001" } } })).toContain("25/11/2026");
    expect(cartao({ ...base, id: "4", tipo: "minuta", dados: { titulo: "Contrato", campos: {}, _exibir: { campos_manuais: ["valor"], previa: "TEXTO DA PRÉVIA" } } })).toContain("TEXTO DA PRÉVIA");
    const feito = cartao({ ...base, status: "confirmado", linkResultado: "/app/tarefas/x", id: "5", tipo: "tarefa", dados: { titulo: "T", _exibir: {} } });
    expect(feito).not.toContain("Confirmar e gravar");
    expect(feito).toContain('href="/app/tarefas/x"');
  });

  it("resposta só tem link para fonte devolvida pela ferramenta", () => {
    const html = renderToStaticMarkup(h(TextoResposta, { texto: "- item [P](/app/processos/a)\n[inventado](/app/financeiro)", fontes: [{ ref: "p", rotulo: "P", link: "/app/processos/a" }] }));
    expect(html).toContain('href="/app/processos/a"');
    expect(html).not.toContain('href="/app/financeiro"');
    expect(html).toContain("inventado");
  });

  it("aviso fixo de permissão nomeia o módulo", () => {
    expect(renderToStaticMarkup(h(AvisoSemPermissao, { modulos: ["financeiro"] }))).toContain("Financeiro");
    expect(renderToStaticMarkup(h(AvisoSemPermissao, { modulos: [] }))).toBe("");
  });
});
