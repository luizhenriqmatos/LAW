/**
 * Créditos trabalhistas: atualização pelas fases do STF (ADC 58) e do TST (E-ED-RR-713-03.2010.5.04.0029), verba por
 * verba, e apuração das verbas rescisórias básicas. MÓDULO PURO, em cima do mesmo motor do cível.
 *
 * Cada verba tem o seu vencimento e a sua linha do tempo; o total é a soma das verbas já atualizadas.
 */
import { dataBr, dataValida, ErroCalculo, type CodigoIndice } from "./base";
import {
  AVISO_APOIO, cabecalho, regras, seriesUsadas, tabela, type Contexto, type Demonstrativo,
} from "./calculos";
import { atualizar, type ResultadoMotor } from "./motor";
import { apurarRescisao, type EntradaRescisao } from "./rescisao";

export const AVISO_TRABALHISTA_FORA =
  "Não estão neste cálculo: horas extras e reflexos, adicional noturno, insalubridade, periculosidade, contribuição previdenciária e imposto de renda sobre a condenação (versão 8B-2).";

export type VerbaInformada = { descricao: string; valorCentavos: number; vencimento: string };

export type ParametrosTrabalhista = {
  dataAjuizamento: string;
  dataFinal: string;
  regimeIds: string[];
  indicesSubstitutos: Record<string, CodigoIndice | "nenhuma">;
  rescisao: EntradaRescisao | null;
  verbas: VerbaInformada[];
};

type Atualizada = VerbaInformada & { r: ResultadoMotor };

export function calcularTrabalhista(p: ParametrosTrabalhista, ctx: Contexto): Demonstrativo {
  if (!dataValida(p.dataAjuizamento)) throw new ErroCalculo("marco_obrigatorio", "Informe a data de ajuizamento da ação: ela define onde começa a fase judicial.");
  if (!dataValida(p.dataFinal)) throw new ErroCalculo("data_invalida", "Informe a data final do cálculo.");
  const regimes = p.regimeIds.map((id) => {
    const r = ctx.regimes.find((x) => x.id === id);
    if (!r) throw new ErroCalculo("regime_invalido", "Regime não encontrado.");
    return r;
  });
  if (!regimes.length) throw new ErroCalculo("sem_regime", "Escolha ao menos um regime.");

  // 1. Apuração das verbas rescisórias (se informadas) + verbas avulsas.
  const apuracao = p.rescisao ? apurarRescisao(p.rescisao) : null;
  const lista: VerbaInformada[] = [
    ...(apuracao?.verbas.filter((v) => v.centavos > 0).map((v) => ({ descricao: v.descricao, valorCentavos: v.centavos, vencimento: apuracao.vencimento })) ?? []),
    ...p.verbas,
  ];
  if (!lista.length) throw new ErroCalculo("sem_verbas", "Informe ao menos uma verba (ou os dados da rescisão).");
  if (lista.length > 120) throw new ErroCalculo("verbas_demais", "No máximo 120 verbas por cálculo.");

  // 2. Cada verba com a sua linha do tempo (vencimento → ajuizamento → 29/08/2024 → data final).
  const atualizadas: Atualizada[] = lista.map((v) => {
    if (!dataValida(v.vencimento)) throw new ErroCalculo("data_invalida", `Vencimento inválido em "${v.descricao}".`);
    if (v.vencimento > p.dataFinal) throw new ErroCalculo("periodo_invertido", `"${v.descricao}" vence depois da data final do cálculo (${dataBr(v.vencimento)}).`);
    try {
      return {
        ...v,
        r: atualizar({
          valorCentavos: v.valorCentavos, dataBase: v.vencimento, inicioJuros: v.vencimento, dataFinal: p.dataFinal,
          regimes, indicesSubstitutos: p.indicesSubstitutos, indices: ctx.indices, marcos: { ajuizamento: p.dataAjuizamento },
        }),
      };
    } catch (e) {
      if (e instanceof ErroCalculo) throw new ErroCalculo(e.codigo, `${v.descricao}: ${e.message}`, e.detalhes);
      throw e;
    }
  });

  // 3. Grupos por vencimento: mesma linha do tempo, tabela mês a mês com a soma das verbas do grupo.
  const porVencimento = new Map<string, Atualizada[]>();
  for (const a of atualizadas) porVencimento.set(a.vencimento, [...(porVencimento.get(a.vencimento) ?? []), a]);
  const grupos = [...porVencimento].sort(([a], [b]) => a.localeCompare(b)).map(([venc, vs]) => {
    const base = tabela(vs[0].r)!;
    const linhas = base.map((l, i) => {
      const soma = (k: "valorCorrigido" | "jurosMes" | "jurosAcumulados" | "subtotal") => vs.reduce((s, v) => s + v.r.linhas[i][k], 0);
      return { ...l, valorCorrigido: soma("valorCorrigido"), jurosMes: soma("jurosMes"), jurosAcumulados: soma("jurosAcumulados"), subtotal: soma("subtotal") };
    });
    return {
      titulo: `Vencimento em ${dataBr(venc)}: ${vs.map((v) => v.descricao).join(", ")}`,
      vencimento: venc,
      valorBaseCentavos: vs.reduce((s, v) => s + v.valorCentavos, 0),
      regras: regras(vs[0].r),
      tabela: linhas,
    };
  });

  const soma = (f: (a: Atualizada) => number) => atualizadas.reduce((s, a) => s + f(a), 0);
  const original = soma((a) => a.valorCentavos), corrigido = soma((a) => a.r.principalCorrigido), juros = soma((a) => a.r.juros);
  const total = corrigido + juros;
  const series = [...new Set(atualizadas.flatMap((a) => a.r.seriesUsadas))].sort();

  return {
    versao: 1,
    tipo: "trabalhista",
    titulo: ctx.titulo,
    dataCalculo: ctx.dataCalculo,
    cabecalho: cabecalho(ctx, [
      { rotulo: "Ajuizamento da ação", valor: dataBr(p.dataAjuizamento) },
      { rotulo: "Atualizado até", valor: dataBr(p.dataFinal) },
      { rotulo: "Verbas", valor: `${lista.length} (cada uma atualizada desde o seu vencimento)` },
      ...(apuracao ? apuracao.resumo : []),
    ]),
    regras: [],
    tabela: null,
    blocos: [],
    apuracao: apuracao?.verbas.map((v) => ({ descricao: v.descricao, regra: v.regra, centavos: v.centavos })),
    verbas: atualizadas.map((a) => ({ descricao: a.descricao, vencimento: a.vencimento, original: a.valorCentavos, corrigido: a.r.principalCorrigido, juros: a.r.juros, total: a.r.total })),
    grupos,
    totais: [
      { rotulo: "Valor original das verbas", centavos: original },
      { rotulo: "Principal corrigido", centavos: corrigido },
      { rotulo: "Juros de mora", centavos: juros },
      { rotulo: "Total geral", centavos: total, destaque: true },
    ],
    totalCentavos: total,
    valorBaseCentavos: original,
    series: seriesUsadas({ ...atualizadas[0].r, seriesUsadas: series }, ctx),
    avisos: [
      ...(apuracao?.avisos ?? []),
      "Fases (STF, ADC 58; TST, SBDI-1, E-ED-RR-713-03.2010.5.04.0029): antes do ajuizamento, IPCA-E + juros do art. 39, caput, da Lei 8.177/1991 (TR); do ajuizamento até 29/08/2024, só a Selic; a partir de 30/08/2024, IPCA + Taxa Legal.",
      AVISO_TRABALHISTA_FORA,
      AVISO_APOIO,
    ],
  };
}
