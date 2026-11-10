/**
 * Os cálculos desta entrega, montados em cima do motor por trechos. MÓDULO PURO.
 *  1. Atualização monetária + juros de mora (cível).
 *  2. Cumprimento de sentença (CPC, art. 523): multa de 10% e honorários de 10% se não houver pagamento em 15 dias úteis.
 *  3. Honorários: sucumbência, contratuais e êxito.
 * Cada um devolve um Demonstrativo (o mesmo objeto alimenta a tela e o PDF, e fica congelado no cálculo salvo).
 */
import { calcularPrazo, ErroContagem, type EntradaCalendario } from "@/lib/prazos/contagem";
import {
  CEM, centavos, Dec, dataBr, dataValida, descreverCorrecao, descreverJuros, ErroCalculo, mesBr, NOMES_SERIE,
  type CodigoIndice, type CodigoSerie, type Regime, type TabelaIndices,
} from "./base";
import { atualizar, type LinhaMes, type ResultadoMotor } from "./motor";

export const AVISO_APOIO = "Cálculo de apoio. Confira os critérios fixados na decisão judicial.";
export const AVISO_SUGESTAO = "O regime padrão é uma sugestão: pode ser trocado conforme o contrato ou a decisão judicial.";
export const AVISO_FAZENDA =
  "Contra a Fazenda Pública os percentuais de honorários são escalonados por faixa de valor (CPC, art. 85, § 3º). Essa regra ainda não está neste cálculo: entra no Prompt 8C.";

export type TipoCalculo = "atualizacao" | "art523" | "honorarios" | "trabalhista";
export const NOMES_TIPO: Record<TipoCalculo, string> = {
  atualizacao: "Atualização monetária e juros de mora",
  trabalhista: "Créditos trabalhistas (ADC 58) e verbas rescisórias",
  art523: "Cumprimento de sentença (CPC, art. 523)",
  honorarios: "Honorários advocatícios",
};

export { NOMES_MARCO, type TipoMarco } from "./base";

export type SerieInfo = { codigo: CodigoSerie; nome: string; fonte: string; sgs: number; coletado_em: string | null; ultimo_mes: string | null };

export type Demonstrativo = {
  versao: 1;
  tipo: TipoCalculo;
  titulo: string;
  dataCalculo: string;
  cabecalho: { processo: string | null; partes: string | null; parametros: { rotulo: string; valor: string }[] };
  regras: { regimeId: string; inicio: string; fim: string; regime: string; versao: number; fundamento: string; correcao: string; juros: string; mesesCorrecao: string | null }[];
  tabela: (LinhaMes & { regimeNome: string })[] | null;
  blocos: { titulo: string; linhas: { rotulo: string; valor: string }[] }[];
  totais: { rotulo: string; centavos: number; destaque?: boolean }[];
  totalCentavos: number;
  /** Valor original (base da atualização); nulo nos honorários. */
  valorBaseCentavos: number | null;
  series: SerieInfo[];
  avisos: string[];
  /** Trabalhista: apuração das verbas (com a regra de cada uma), inclusive as não devidas (valor zero). */
  apuracao?: { descricao: string; regra: string; centavos: number }[];
  /** Trabalhista: atualização de cada verba (cada uma com a sua linha do tempo). */
  verbas?: { descricao: string; vencimento: string; original: number; corrigido: number; juros: number; total: number }[];
  /** Trabalhista: verbas agrupadas por vencimento, com as regras e a tabela mês a mês do grupo. */
  grupos?: { titulo: string; vencimento: string; valorBaseCentavos: number; regras: Demonstrativo["regras"]; tabela: NonNullable<Demonstrativo["tabela"]> }[];
};

export type ParametrosAtualizacao = {
  valorCentavos: number;
  dataBase: string;
  juros: "vencimento" | "citacao" | "sem_juros";
  dataCitacao: string | null;
  dataFinal: string;
  regimeIds: string[];
  indicesSubstitutos: Record<string, CodigoIndice | "nenhuma">;
  dataAjuizamento: string | null;
  dataTransito: string | null;
};
export type ParametrosArt523 = ParametrosAtualizacao & {
  dataIntimacao: string;
  pagamento: { valorCentavos: number; data: string } | null;
};
export type ParametrosHonorarios = {
  modalidade: "sucumbencia" | "contratuais" | "exito";
  forma: "percentual" | "fixo";
  baseTipo: "condenacao" | "proveito_economico" | "valor_causa" | "valor_recebido" | "outro";
  baseCentavos: number | null;
  percentual: string | null;
  valorFixoCentavos: number | null;
  fazendaPublica: boolean;
};

export type Contexto = {
  titulo: string;
  processo: { numero_cnj: string; titulo: string | null } | null;
  partes: string | null;
  dataCalculo: string;
  regimes: Regime[];
  indices: TabelaIndices;
  series: SerieInfo[];
  /** Calendário forense (já filtrado pelo tribunal), para o prazo do art. 523. */
  calendario?: EntradaCalendario[];
};

const real = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const pct = (v: string, casas = 6) => `${new Dec(v).toFixed(casas).replace(".", ",")}%`;
const cnjFormatado = (n: string) => (/^\d{20}$/.test(n) ? `${n.slice(0, 7)}-${n.slice(7, 9)}.${n.slice(9, 13)}.${n.slice(13, 14)}.${n.slice(14, 16)}.${n.slice(16)}` : n);

export function cabecalho(ctx: Contexto, parametros: { rotulo: string; valor: string }[]) {
  return {
    processo: ctx.processo ? `${cnjFormatado(ctx.processo.numero_cnj)}${ctx.processo.titulo ? ` — ${ctx.processo.titulo}` : ""}` : null,
    partes: ctx.partes,
    parametros,
  };
}

function inicioDosJuros(p: ParametrosAtualizacao): string | null {
  if (p.juros === "sem_juros") return null;
  if (p.juros === "citacao") {
    if (!p.dataCitacao || !dataValida(p.dataCitacao)) throw new ErroCalculo("citacao_obrigatoria", "Informe a data da citação.");
    return p.dataCitacao;
  }
  return p.dataBase;
}

function regimesEscolhidos(p: ParametrosAtualizacao, ctx: Contexto): Regime[] {
  if (!p.regimeIds.length) throw new ErroCalculo("sem_regime", "Escolha ao menos um regime.");
  return p.regimeIds.map((id) => {
    const r = ctx.regimes.find((x) => x.id === id);
    if (!r) throw new ErroCalculo("regime_invalido", "Regime não encontrado.");
    return r;
  });
}

function rodarMotor(p: ParametrosAtualizacao, ctx: Contexto, dataFinal = p.dataFinal): ResultadoMotor {
  return atualizar({
    valorCentavos: p.valorCentavos,
    dataBase: p.dataBase,
    inicioJuros: inicioDosJuros(p),
    dataFinal,
    regimes: regimesEscolhidos(p, ctx),
    indicesSubstitutos: p.indicesSubstitutos,
    indices: ctx.indices,
  });
}

function parametrosBase(p: ParametrosAtualizacao, r: ResultadoMotor): { rotulo: string; valor: string }[] {
  const linhas = [
    { rotulo: "Valor original", valor: real(p.valorCentavos) },
    { rotulo: "Data-base (vencimento)", valor: dataBr(p.dataBase) },
    {
      rotulo: "Juros de mora desde",
      valor: p.juros === "sem_juros" ? "Sem juros" : p.juros === "citacao" ? `Citação, ${dataBr(p.dataCitacao!)}` : `Vencimento, ${dataBr(p.dataBase)}`,
    },
    { rotulo: "Atualizado até", valor: dataBr(p.dataFinal) },
  ];
  if (p.dataAjuizamento) linhas.push({ rotulo: "Ajuizamento", valor: dataBr(p.dataAjuizamento) });
  if (p.dataTransito) linhas.push({ rotulo: "Trânsito em julgado", valor: dataBr(p.dataTransito) });
  const trocados = r.trechos.filter((t) => t.regime.indice_substituido);
  for (const t of trocados) {
    linhas.push({ rotulo: `Índice escolhido (${dataBr(t.inicio)} a ${dataBr(t.fim)})`, valor: NOMES_SERIE[t.regime.indice_efetivo as CodigoSerie] ?? "Sem correção" });
  }
  return linhas;
}

export function regras(r: ResultadoMotor): Demonstrativo["regras"] {
  return r.trechos.map((t) => {
    const meses = r.linhas.filter((l) => l.correcao.some((c) => c.regimeId === t.regime.id)).map((l) => l.mes);
    return {
      regimeId: t.regime.id,
      inicio: t.inicio,
      fim: t.fim,
      regime: t.regime.nome,
      versao: t.regime.versao,
      fundamento: t.regime.fundamento,
      correcao: `${descreverCorrecao(t.regime.indice_efetivo, t.regime.correcao_pro_rata)}${t.regime.indice_substituido ? " — índice escolhido no cálculo" : ""}`,
      juros: descreverJuros(t.regime),
      mesesCorrecao: meses.length ? `${mesBr(meses[0])} a ${mesBr(meses.at(-1)!)}` : null,
    };
  });
}

export function tabela(r: ResultadoMotor): Demonstrativo["tabela"] {
  const nomes = new Map(r.trechos.map((t) => [t.regime.id, t.regime.nome]));
  return r.linhas.map((l) => ({ ...l, regimeNome: l.regimes.map((id) => nomes.get(id) ?? id).join(" + ") }));
}

export function seriesUsadas(r: ResultadoMotor, ctx: Contexto): SerieInfo[] {
  return r.seriesUsadas.map((c) => ctx.series.find((s) => s.codigo === c) ?? { codigo: c, nome: NOMES_SERIE[c], fonte: "Banco Central do Brasil, SGS", sgs: 0, coletado_em: null, ultimo_mes: null });
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Atualização monetária + juros de mora
// ---------------------------------------------------------------------------------------------------------------
export function calcularAtualizacao(p: ParametrosAtualizacao, ctx: Contexto): Demonstrativo {
  const r = rodarMotor(p, ctx);
  return {
    versao: 1,
    tipo: "atualizacao",
    titulo: ctx.titulo,
    dataCalculo: ctx.dataCalculo,
    cabecalho: cabecalho(ctx, parametrosBase(p, r)),
    regras: regras(r),
    tabela: tabela(r),
    blocos: [{
      titulo: "Resumo",
      linhas: [
        { rotulo: "Fator de correção no período", valor: new Dec(r.fatorCorrecao).toFixed(8).replace(".", ",") },
        { rotulo: "Juros de mora no período (soma simples)", valor: pct(r.jurosPercentual) },
      ],
    }],
    totais: [
      { rotulo: "Valor original", centavos: r.principalOriginal },
      { rotulo: "Principal corrigido", centavos: r.principalCorrigido },
      { rotulo: "Juros de mora", centavos: r.juros },
      { rotulo: "Total geral", centavos: r.total, destaque: true },
    ],
    totalCentavos: r.total,
    valorBaseCentavos: p.valorCentavos,
    series: seriesUsadas(r, ctx),
    avisos: [AVISO_SUGESTAO, AVISO_APOIO],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Cumprimento de sentença (art. 523 do CPC)
// ---------------------------------------------------------------------------------------------------------------
export const MULTA_523 = new Dec("0.10");
export const HONORARIOS_523 = new Dec("0.10");

export function calcularArt523(p: ParametrosArt523, ctx: Contexto): Demonstrativo {
  if (!dataValida(p.dataIntimacao)) throw new ErroCalculo("intimacao_obrigatoria", "Informe a data da intimação para pagamento.");
  if (p.dataIntimacao < p.dataBase) throw new ErroCalculo("intimacao_invalida", "A intimação não pode ser anterior à data-base.");
  let prazo;
  try {
    prazo = calcularPrazo({ disponibilizacao: p.dataIntimacao, intimado: true, dias: 15, tipo: "util", calendario: ctx.calendario ?? [] });
  } catch (e) {
    if (e instanceof ErroContagem) throw new ErroCalculo("prazo_invalido", e.message);
    throw e;
  }
  const limite = prazo.dataFinal;
  const r = rodarMotor(p, ctx);
  const C1 = new Dec(r.exatos.corrigido), J1 = new Dec(r.exatos.juros);

  // Pagamento parcial: abate a fração paga do débito atualizado na data do pagamento; o restante segue atualizado.
  let restante = new Dec(1);
  const blocoPagamento: { rotulo: string; valor: string }[] = [];
  let pagoNoPrazo = false;
  if (p.pagamento) {
    const { valorCentavos: pago, data } = p.pagamento;
    if (!Number.isSafeInteger(pago) || pago <= 0) throw new ErroCalculo("pagamento_invalido", "Informe o valor pago.");
    if (!dataValida(data) || data < p.dataBase || data > p.dataFinal) {
      throw new ErroCalculo("pagamento_fora_do_periodo", "A data do pagamento deve ficar entre a data-base e a data final.");
    }
    const rp = data === p.dataBase ? null : rodarMotor(p, ctx, data);
    const devidoNaData = rp ? new Dec(rp.exatos.corrigido).plus(rp.exatos.juros) : new Dec(p.valorCentavos);
    const fracao = Dec.min(new Dec(pago).div(devidoNaData), 1);
    restante = new Dec(1).minus(fracao);
    pagoNoPrazo = data <= limite;
    blocoPagamento.push(
      { rotulo: "Pagamento", valor: `${real(pago)} em ${dataBr(data)} (${pagoNoPrazo ? "dentro" : "fora"} do prazo de 15 dias úteis)` },
      { rotulo: "Débito atualizado na data do pagamento", valor: real(centavos(devidoNaData)) },
      { rotulo: "Parte quitada", valor: pct(fracao.mul(CEM).toString(), 4) },
      { rotulo: "Saldo remanescente atualizado", valor: real(centavos(C1.mul(restante)) + centavos(J1.mul(restante))) },
    );
    if (new Dec(pago).gt(devidoNaData)) blocoPagamento.push({ rotulo: "Atenção", valor: `O pagamento supera o débito em ${real(centavos(new Dec(pago).minus(devidoNaData)))}.` });
  }

  const saldoCorrigido = centavos(C1.mul(restante));
  const saldoJuros = centavos(J1.mul(restante));
  const saldo = saldoCorrigido + saldoJuros;
  const prazoVencido = p.dataFinal > limite;
  // Multa e honorários: sobre o que não foi pago no prazo (§ 2º). Pagamento depois do prazo não reduz a base.
  const baseMulta = !prazoVencido || saldo === 0 ? 0 : p.pagamento && !pagoNoPrazo ? r.principalCorrigido + r.juros : saldo;
  const multa = centavos(new Dec(baseMulta).mul(MULTA_523));
  const honorarios = centavos(new Dec(baseMulta).mul(HONORARIOS_523));
  const total = saldo + multa + honorarios;

  const avisos = [AVISO_SUGESTAO, prazo.aviso, AVISO_APOIO];
  if (!prazoVencido) avisos.unshift(`O prazo para pagamento voluntário vence em ${dataBr(limite)}. Multa e honorários só incidem se não houver pagamento até lá.`);
  if (p.pagamento && !pagoNoPrazo) avisos.unshift("Pagamento feito depois do prazo: multa e honorários incidem sobre o débito integral (o pagamento só abate o principal e os juros).");

  return {
    versao: 1,
    tipo: "art523",
    titulo: ctx.titulo,
    dataCalculo: ctx.dataCalculo,
    cabecalho: cabecalho(ctx, [...parametrosBase(p, r), { rotulo: "Intimação para pagamento", valor: dataBr(p.dataIntimacao) }]),
    regras: regras(r),
    tabela: tabela(r),
    blocos: [
      {
        titulo: "Prazo para pagamento voluntário (15 dias úteis)",
        linhas: [
          ...prazo.passos.map((x) => ({ rotulo: x.rotulo, valor: x.explicacao })),
          { rotulo: "Situação", valor: prazoVencido ? `Prazo vencido em ${dataBr(limite)}: incidem multa de 10% e honorários de 10% (CPC, art. 523, § 1º).` : `Prazo em curso até ${dataBr(limite)}.` },
        ],
      },
      ...(blocoPagamento.length ? [{ titulo: "Pagamento parcial (CPC, art. 523, § 2º)", linhas: blocoPagamento }] : []),
    ],
    totais: [
      { rotulo: p.pagamento ? "Principal corrigido (saldo)" : "Principal corrigido", centavos: saldoCorrigido },
      { rotulo: p.pagamento ? "Juros de mora (saldo)" : "Juros de mora", centavos: saldoJuros },
      { rotulo: "Multa de 10% (art. 523, § 1º)", centavos: multa },
      { rotulo: "Honorários de 10% (art. 523, § 1º)", centavos: honorarios },
      { rotulo: "Total geral", centavos: total, destaque: true },
    ],
    totalCentavos: total,
    valorBaseCentavos: p.valorCentavos,
    series: seriesUsadas(r, ctx),
    avisos,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Honorários
// ---------------------------------------------------------------------------------------------------------------
export const NOMES_BASE: Record<ParametrosHonorarios["baseTipo"], string> = {
  condenacao: "Valor da condenação",
  proveito_economico: "Proveito econômico obtido",
  valor_causa: "Valor atualizado da causa",
  valor_recebido: "Valor efetivamente recebido",
  outro: "Base informada",
};
export const NOMES_MODALIDADE: Record<ParametrosHonorarios["modalidade"], string> = {
  sucumbencia: "Sucumbência (CPC, art. 85, § 2º)",
  contratuais: "Contratuais",
  exito: "Êxito",
};

export function calcularHonorarios(p: ParametrosHonorarios, ctx: Pick<Contexto, "titulo" | "processo" | "partes" | "dataCalculo">): Demonstrativo {
  const parametros = [{ rotulo: "Modalidade", valor: NOMES_MODALIDADE[p.modalidade] }];
  const avisos: string[] = [];
  let honorarios: number;
  let base: number | null = null;
  const percentual = p.percentual === null ? null : new Dec(p.percentual.replace(",", "."));

  const exigirBase = () => {
    if (p.baseCentavos === null || !Number.isSafeInteger(p.baseCentavos) || p.baseCentavos <= 0) throw new ErroCalculo("base_invalida", "Informe o valor da base de cálculo.");
    return p.baseCentavos;
  };
  const exigirPercentual = (min: Dec, max: Dec, msg: string) => {
    if (!percentual || !percentual.isFinite() || percentual.lt(min) || percentual.gt(max)) throw new ErroCalculo("percentual_invalido", msg);
    return percentual;
  };

  if (p.modalidade === "sucumbencia") {
    if (!["condenacao", "proveito_economico", "valor_causa"].includes(p.baseTipo)) throw new ErroCalculo("base_invalida", "Na sucumbência, a base é a condenação, o proveito econômico ou o valor da causa.");
    base = exigirBase();
    const x = exigirPercentual(new Dec(10), new Dec(20), "Na sucumbência o percentual vai de 10% a 20% (CPC, art. 85, § 2º).");
    honorarios = centavos(new Dec(base).mul(x).div(CEM));
    parametros.push({ rotulo: "Base de cálculo", valor: `${NOMES_BASE[p.baseTipo]}: ${real(base)}` }, { rotulo: "Percentual", valor: pct(x.toString(), 2) });
    avisos.push(AVISO_FAZENDA);
  } else if (p.modalidade === "contratuais" && p.forma === "fixo") {
    if (p.valorFixoCentavos === null || !Number.isSafeInteger(p.valorFixoCentavos) || p.valorFixoCentavos <= 0) throw new ErroCalculo("valor_invalido", "Informe o valor fixo dos honorários.");
    honorarios = p.valorFixoCentavos;
    parametros.push({ rotulo: "Forma", valor: "Valor fixo" });
  } else {
    base = exigirBase();
    const x = exigirPercentual(new Dec("0.01"), new Dec(100), "Informe um percentual entre 0,01% e 100%.");
    honorarios = centavos(new Dec(base).mul(x).div(CEM));
    const rotuloBase = p.modalidade === "exito" ? NOMES_BASE.valor_recebido : NOMES_BASE[p.baseTipo];
    parametros.push({ rotulo: "Base de cálculo", valor: `${rotuloBase}: ${real(base)}` }, { rotulo: "Percentual", valor: pct(x.toString(), 2) });
  }
  if (p.fazendaPublica && p.modalidade !== "sucumbencia") avisos.push(AVISO_FAZENDA);
  avisos.push(AVISO_APOIO);

  return {
    versao: 1,
    tipo: "honorarios",
    titulo: ctx.titulo,
    dataCalculo: ctx.dataCalculo,
    cabecalho: cabecalho(ctx as Contexto, parametros),
    regras: [],
    tabela: null,
    blocos: [],
    totais: [...(base !== null ? [{ rotulo: "Base de cálculo", centavos: base }] : []), { rotulo: "Honorários", centavos: honorarios, destaque: true }],
    totalCentavos: honorarios,
    valorBaseCentavos: null,
    series: [],
    avisos,
  };
}


