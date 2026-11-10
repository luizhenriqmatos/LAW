/**
 * Demonstrativo em PDF (A4 deitado), pronto para anexar ao processo. Gerado a partir do MESMO objeto da tela.
 * Fonte Helvetica padrão do PDF (sem baixar nada): cobre acentos do português; caracteres fora dela viram "?".
 */
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { Dec, NOMES_SERIE, dataBr, mesBr, type CodigoSerie } from "./base";
import { NOMES_TIPO, type Demonstrativo } from "./calculos";
import type { Parcela } from "./motor";

const LARG = 842, ALT = 595, MARGEM = 36;
const COR_TEXTO = rgb(0.1, 0.1, 0.12), COR_SUAVE = rgb(0.42, 0.42, 0.46), COR_LINHA = rgb(0.85, 0.85, 0.87), COR_FUNDO = rgb(0.95, 0.95, 0.96);

const TROCAS: Record<string, string> = { "→": "->", "≤": "<=", "≥": ">=", "\u202f": " ", "\u2009": " " };
/** Além do Latin-1, a codificação WinAnsi da fonte padrão desenha estes. */
const WINANSI_EXTRA = new Set([..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"]);
/** Só caracteres que a fonte padrão (WinAnsi) desenha. */
export function textoPdf(s: string): string {
  return [...s.normalize("NFC")].map((c) => {
    if (TROCAS[c] !== undefined) return TROCAS[c];
    const n = c.charCodeAt(0);
    return (n >= 32 && n <= 126) || (n >= 160 && n <= 255) || WINANSI_EXTRA.has(c) ? c : n === 10 ? " " : "?";
  }).join("");
}

export const realPdf = (c: number) => `${c < 0 ? "-" : ""}R$ ${Math.floor(Math.abs(c) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(Math.abs(c) % 100).padStart(2, "0")}`;
const pctPdf = (v: string, casas = 6) => `${new Dec(v).toFixed(casas).replace(".", ",")}%`;
const nomeSerie = (s: CodigoSerie | "FIXO") => (s === "FIXO" ? "Taxa fixa" : NOMES_SERIE[s]);

export function descreverParcelas(ps: Parcela[]): string {
  if (!ps.length) return "-";
  return ps.map((p) => `${nomeSerie(p.serie)} ${pctPdf(p.percentualMes, p.serie === "TAXA_LEGAL" || p.serie === "FIXO" ? 6 : 2)}${p.dias === null ? "" : ` (${p.dias}/${p.diasMes} d)`}`).join(" + ");
}

class Escritor {
  pagina!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, private fonte: PDFFont, private negrito: PDFFont) {
    this.novaPagina();
  }
  novaPagina() {
    this.pagina = this.doc.addPage([LARG, ALT]);
    this.y = ALT - MARGEM;
  }
  garantir(altura: number) {
    if (this.y - altura < MARGEM + 24) this.novaPagina();
  }
  largura(t: string, tam: number, negrito = false) {
    return (negrito ? this.negrito : this.fonte).widthOfTextAtSize(textoPdf(t), tam);
  }
  quebrar(t: string, tam: number, max: number, negrito = false): string[] {
    const palavras = textoPdf(t).split(/\s+/);
    const linhas: string[] = [];
    let atual = "";
    for (const p of palavras) {
      const tenta = atual ? `${atual} ${p}` : p;
      if (this.largura(tenta, tam, negrito) <= max || !atual) atual = tenta;
      else { linhas.push(atual); atual = p; }
    }
    if (atual) linhas.push(atual);
    return linhas;
  }
  escrever(t: string, x: number, tam: number, opts: { negrito?: boolean; cor?: ReturnType<typeof rgb>; y?: number } = {}) {
    this.pagina.drawText(textoPdf(t), { x, y: opts.y ?? this.y, size: tam, font: opts.negrito ? this.negrito : this.fonte, color: opts.cor ?? COR_TEXTO });
  }
  paragrafo(t: string, tam = 9, opts: { negrito?: boolean; cor?: ReturnType<typeof rgb>; x?: number; max?: number } = {}) {
    const x = opts.x ?? MARGEM;
    for (const l of this.quebrar(t, tam, opts.max ?? LARG - x - MARGEM, opts.negrito)) {
      this.garantir(tam + 3);
      this.escrever(l, x, tam, opts);
      this.y -= tam + 3;
    }
  }
  titulo(t: string) {
    this.garantir(28);
    this.y -= 8;
    this.escrever(t.toUpperCase(), MARGEM, 9, { negrito: true, cor: COR_SUAVE });
    this.y -= 4;
    this.pagina.drawLine({ start: { x: MARGEM, y: this.y }, end: { x: LARG - MARGEM, y: this.y }, thickness: 0.6, color: COR_LINHA });
    this.y -= 12;
  }
  pares(itens: { rotulo: string; valor: string }[], larguraRotulo = 190) {
    for (const i of itens) {
      const linhas = this.quebrar(i.valor, 9, LARG - 2 * MARGEM - larguraRotulo);
      this.garantir(12 * linhas.length);
      this.escrever(i.rotulo, MARGEM, 9, { cor: COR_SUAVE });
      for (const l of linhas) {
        this.escrever(l, MARGEM + larguraRotulo, 9);
        this.y -= 12;
      }
    }
  }
  tabela(colunas: { titulo: string; largura: number; direita?: boolean }[], linhas: string[][], tam = 7.5) {
    // this.y = topo da próxima linha; o texto fica na linha de base (topo - tam) e o fio separador no pé da linha.
    const larguraTotal = colunas.reduce((s, c) => s + c.largura, 0);
    const desenharCelulas = (valores: string[][], negrito: boolean) => {
      let x = MARGEM;
      valores.forEach((ls, i) => {
        const c = colunas[i];
        ls.forEach((l, k) => {
          const w = this.largura(l, tam, negrito);
          this.escrever(l, c.direita ? x + c.largura - w - 3 : x + 3, tam, { negrito, y: this.y - tam - 1 - k * (tam + 2) });
        });
        x += c.largura;
      });
    };
    const cabecalho = () => {
      this.garantir(tam * 4);
      const h = tam + 7;
      this.pagina.drawRectangle({ x: MARGEM, y: this.y - h, width: larguraTotal, height: h, color: COR_FUNDO });
      desenharCelulas(colunas.map((c) => [c.titulo]), true);
      this.y -= h + 1;
    };
    cabecalho();
    for (const linha of linhas) {
      const celulas = linha.map((v, i) => this.quebrar(v, tam, colunas[i].largura - 6));
      const altura = Math.max(...celulas.map((c) => c.length)) * (tam + 2) + 4;
      if (this.y - altura < MARGEM + 24) { this.novaPagina(); cabecalho(); }
      desenharCelulas(celulas, false);
      this.y -= altura;
      this.pagina.drawLine({ start: { x: MARGEM, y: this.y }, end: { x: MARGEM + larguraTotal, y: this.y }, thickness: 0.3, color: COR_LINHA });
    }
    this.y -= tam + 6;
  }
}

export async function gerarPdf(d: Demonstrativo, opts: { escritorio?: string; geradoEm?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(textoPdf(`Demonstrativo - ${d.titulo}`));
  doc.setAuthor(textoPdf(opts.escritorio ?? "LAW"));
  doc.setCreator("LAW");
  doc.setProducer("LAW (pdf-lib)");
  const fonte = await doc.embedFont(StandardFonts.Helvetica);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const e = new Escritor(doc, fonte, negrito);

  // Cabeçalho
  e.escrever(`Demonstrativo de cálculo — ${NOMES_TIPO[d.tipo]}`, MARGEM, 9, { cor: COR_SUAVE });
  e.y -= 18;
  e.paragrafo(d.titulo, 16, { negrito: true });
  e.y -= 4;
  e.pares([
    ...(opts.escritorio ? [{ rotulo: "Escritório", valor: opts.escritorio }] : []),
    { rotulo: "Processo", valor: d.cabecalho.processo ?? "Não vinculado" },
    { rotulo: "Partes", valor: d.cabecalho.partes ?? "-" },
    { rotulo: "Data do cálculo", valor: dataBr(d.dataCalculo) },
  ]);
  e.titulo("Parâmetros escolhidos");
  e.pares(d.cabecalho.parametros);

  if (d.regras.length) {
    e.titulo("Regras aplicadas (linha do tempo)");
    regrasPdf(e, d.regras);
  }

  if (d.apuracao?.length) {
    e.titulo("Apuração das verbas rescisórias");
    for (const v of d.apuracao) {
      e.garantir(30);
      const valor = v.centavos ? realPdf(v.centavos) : "não devido";
      e.escrever(v.descricao, MARGEM, 9, { negrito: true });
      e.escrever(valor, LARG - MARGEM - e.largura(valor, 9, true), 9, { negrito: true });
      e.y -= 12;
      e.paragrafo(v.regra, 8, { x: MARGEM + 12, cor: COR_SUAVE });
      e.y -= 3;
    }
  }

  if (d.verbas?.length) {
    e.garantir(60);
    e.titulo("Atualização verba por verba");
    e.tabela(
      [
        { titulo: "Verba", largura: 300 }, { titulo: "Vencimento", largura: 70 }, { titulo: "Original", largura: 90, direita: true },
        { titulo: "Corrigido", largura: 90, direita: true }, { titulo: "Juros", largura: 90, direita: true }, { titulo: "Total", largura: 130, direita: true },
      ],
      d.verbas.map((v) => [v.descricao, dataBr(v.vencimento), realPdf(v.original), realPdf(v.corrigido), realPdf(v.juros), realPdf(v.total)]),
      8,
    );
  }

  for (const b of d.blocos) {
    e.titulo(b.titulo);
    e.pares(b.linhas);
  }

  if (d.tabela?.length) {
    e.garantir(90);
    e.titulo("Evolução mês a mês");
    tabelaMensalPdf(e, d.tabela, d.valorBaseCentavos, d.regras);
  }

  for (const g of d.grupos ?? []) {
    e.garantir(120);
    e.titulo(g.titulo);
    regrasPdf(e, g.regras);
    tabelaMensalPdf(e, g.tabela, g.valorBaseCentavos, g.regras);
  }

  e.garantir(30 + d.totais.length * 15);
  e.titulo("Totais");
  for (const t of d.totais) {
    e.garantir(14);
    e.escrever(t.rotulo, MARGEM, t.destaque ? 11 : 9.5, { negrito: t.destaque });
    const v = realPdf(t.centavos);
    e.escrever(v, MARGEM + 360 - e.largura(v, t.destaque ? 11 : 9.5, t.destaque), t.destaque ? 11 : 9.5, { negrito: true });
    e.y -= t.destaque ? 16 : 13;
  }

  if (d.series.length) {
    e.titulo("Fonte dos índices");
    for (const s of d.series) {
      e.paragrafo(`${s.nome}: ${s.fonte}. Coletado em ${s.coletado_em ? dataHora(s.coletado_em) : "-"}; último mês disponível no cache: ${s.ultimo_mes ? mesBr(s.ultimo_mes.slice(0, 7)) : "-"}.`, 8);
    }
  }
  e.titulo("Avisos");
  for (const a of d.avisos) e.paragrafo(a, 8.5);

  // Rodapé em todas as páginas.
  const paginas = doc.getPages();
  paginas.forEach((p, i) => {
    const t = textoPdf(`Cálculo de apoio. Confira os critérios fixados na decisão judicial.   ·   ${opts.geradoEm ? `Gerado em ${opts.geradoEm}   ·   ` : ""}Página ${i + 1} de ${paginas.length}`);
    p.drawText(t, { x: MARGEM, y: MARGEM - 14, size: 7.5, font: fonte, color: COR_SUAVE });
  });
  return doc.save();
}

function regrasPdf(e: Escritor, regras: Demonstrativo["regras"]) {
  regras.forEach((r, i) => {
    e.garantir(40);
    e.paragrafo(`Trecho ${i + 1}: ${dataBr(r.inicio)} a ${dataBr(r.fim)} — ${r.regime} (versão ${r.versao})`, 9, { negrito: true });
    e.paragrafo(`Correção: ${r.correcao}${r.mesesCorrecao ? `; índices de ${r.mesesCorrecao}` : ""}. Juros: ${r.juros}.`, 8.5, { x: MARGEM + 12 });
    e.paragrafo(`Fundamento: ${r.fundamento}`, 8, { x: MARGEM + 12, cor: COR_SUAVE });
    e.y -= 4;
  });
}

function tabelaMensalPdf(e: Escritor, tabela: NonNullable<Demonstrativo["tabela"]>, valorBase: number | null, regras: Demonstrativo["regras"]) {
  const trechoDe = (id: string) => {
    const n = regras.findIndex((r) => r.regimeId === id);
    return n >= 0 ? `T${n + 1}` : "-";
  };
  const base = valorBase === null ? "-" : realPdf(valorBase);
  e.tabela(
    [
      { titulo: "Mês", largura: 44 },
      { titulo: "Valor base", largura: 72, direita: true },
      { titulo: "Índice do mês", largura: 118 },
      { titulo: "Fator acumulado", largura: 72, direita: true },
      { titulo: "Valor corrigido", largura: 80, direita: true },
      { titulo: "Juros do mês", largura: 132, direita: true },
      { titulo: "Juros acumulados", largura: 128, direita: true },
      { titulo: "Subtotal", largura: 80, direita: true },
      { titulo: "Trecho", largura: 44 },
    ],
    tabela.map((l) => [
      mesBr(l.mes),
      base,
      descreverParcelas(l.correcao),
      new Dec(l.fatorAcumulado).toFixed(8).replace(".", ","),
      realPdf(l.valorCorrigido),
      `${realPdf(l.jurosMes)} (${pctPdf(l.jurosMesPercentual)})${l.ajusteTeto ? " teto" : ""}`,
      `${realPdf(l.jurosAcumulados)} (${pctPdf(l.jurosAcumuladoPercentual)})`,
      realPdf(l.subtotal),
      [...new Set(l.regimes.map(trechoDe))].join("+"),
    ]),
  );
  e.paragrafo("Juros do mês = valor corrigido do mês × taxa do mês. Juros acumulados = valor corrigido × soma das taxas (juros simples sobre o valor corrigido). Na fase da Selic, ela entra no fator (soma simples) e não há juros à parte.", 7.5, { cor: COR_SUAVE });
}

function dataHora(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
