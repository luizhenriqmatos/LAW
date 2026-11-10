/**
 * Motor de atualização monetária + juros de mora POR TRECHOS. MÓDULO PURO: sem banco, sem relógio, sem rede.
 *
 * O motor NUNCA aplica uma regra única ao período inteiro: corta a linha do tempo pela vigência de cada regime
 * (ex.: até 29/08/2024 e desde 30/08/2024, Lei 14.905/2024) e aplica a regra de cada trecho.
 *
 * Convenções (conferidas contra a Calculadora do Cidadão do Banco Central em 09/11/2026; ver docs/conferencia):
 *  - Período [início, fim): o dia inicial conta, o dia final não (igual à Calculadora: 30/08 a 31/08 = 1 dia).
 *  - Correção mês a mês: aplica o índice de cada mês, do mês da data-base até o mês ANTERIOR ao da data final
 *    (equivale a informar na Calculadora "mês inicial = mês da data-base" e "mês final = mês anterior ao final").
 *    O mês é corrigido pelo regime vigente no 1º dia contado do mês. Fator acumulado = produto de (1 + índice/100),
 *    sem arredondar no meio.
 *  - Correção pro rata (só se o regime pedir): cada pedaço do mês recebe (1 + índice/100)^(dias/dias do mês).
 *  - Selic "que engloba correção e juros": entra no FATOR de correção, em soma simples dentro do trecho
 *    (fator do trecho = 1 + soma das taxas, pro rata por dias com 6 casas). Mês dividido entre a Selic e um índice
 *    mensal (ex.: mês do ajuizamento) é repartido por dias: cada pedaço com a sua regra.
 *  - Marcos do processo (ex.: ajuizamento) também cortam a linha do tempo: o regime pode valer "a partir do
 *    marco" ou "até a véspera do marco", além das datas fixas de vigência.
 *  - Juros simples: somam-se as taxas do período. Pro rata por dias corridos: taxa do mês ÷ dias do mês × dias
 *    contados, com 6 casas decimais (metodologia da Taxa Legal, Res. CMN 5.171/2024). Mês cheio usa a taxa inteira.
 *  - Juros incidem sobre o valor corrigido: juros acumulados = valor corrigido × soma das taxas. "Juros do mês" =
 *    valor corrigido do mês × taxa do mês (por isso mês com Taxa Legal zero mostra R$ 0,00); os acumulados também
 *    acompanham a correção dos juros dos meses anteriores.
 *  - Dinheiro é arredondado (centavo, meio para cima) só no valor final de cada linha.
 */
import {
  CEM, centavos, Dec, diasEntre, diasNoMes, ErroCalculo, maxData, mesBr, mesDe, minData, NOMES_SERIE, primeiroDia, proximoMes,
  seisCasas, somarDias, UM, validarRegime, ZERO, dataValida, dataBr,
  NOMES_MARCO, type CodigoIndice, type CodigoSerie, type Regime, type TabelaIndices, type TipoMarco,
} from "./base";

export type EntradaMotor = {
  valorCentavos: number;
  /** Data-base do valor (ex.: vencimento). Início da correção. */
  dataBase: string;
  /** Início dos juros (vencimento ou citação). Nulo = sem juros. */
  inicioJuros: string | null;
  /** Data final do cálculo (não contada). */
  dataFinal: string;
  /** Regimes escolhidos; a linha do tempo é cortada pela vigência de cada um. */
  regimes: Regime[];
  /** Troca de índice por regime (só onde o regime permite: índice convencionado ou fixado na decisão). */
  indicesSubstitutos?: Record<string, CodigoIndice | "nenhuma">;
  indices: TabelaIndices;
  /** Datas dos marcos do processo (ex.: ajuizamento). Regimes com início/fim no marco exigem a data. */
  marcos?: Partial<Record<TipoMarco, string>>;
};

export type RegimeAplicado = Regime & { indice_efetivo: CodigoIndice | "nenhuma"; indice_substituido: boolean };
export type Trecho = { inicio: string; fim: string; regime: RegimeAplicado };

/** Um índice ou taxa aplicado num mês (ou num pedaço dele). `dias` nulo = mês cheio. */
export type Parcela = { serie: CodigoSerie | "FIXO"; regimeId: string; percentualMes: string; aplicado: string; dias: number | null; diasMes: number };

export type LinhaMes = {
  mes: string;
  regimes: string[];
  correcao: Parcela[];
  fatorMes: string;
  fatorAcumulado: string;
  valorCorrigido: number;
  juros: Parcela[];
  jurosMesPercentual: string;
  jurosAcumuladoPercentual: string;
  jurosMes: number;
  jurosAcumulados: number;
  subtotal: number;
  ajusteTeto: string | null;
};

export type ResultadoMotor = {
  trechos: Trecho[];
  linhas: LinhaMes[];
  fatorCorrecao: string;
  jurosPercentual: string;
  principalOriginal: number;
  principalCorrigido: number;
  juros: number;
  total: number;
  /** Valores sem arredondar (texto), para cálculos que continuam a partir deste (ex.: imputação de pagamento). */
  exatos: { corrigido: string; juros: string };
  seriesUsadas: CodigoSerie[];
};

const FIXO = "FIXO" as const;

function aplicarSubstitutos(regimes: Regime[], subs: EntradaMotor["indicesSubstitutos"] = {}): RegimeAplicado[] {
  return regimes.map((r) => {
    const erro = validarRegime(r);
    if (erro) throw new ErroCalculo(erro, `Regime "${r.nome}" inválido.`);
    const sub = subs[r.id];
    if (!sub || sub === r.correcao_indice) return { ...r, indice_efetivo: r.correcao_indice, indice_substituido: false };
    if (!r.indice_editavel) throw new ErroCalculo("indice_nao_editavel", `O regime "${r.nome}" não permite trocar o índice.`);
    if (r.juros_tipo === "selic_englobando_correcao_e_juros" && sub !== "nenhuma") {
      throw new ErroCalculo("selic_com_indice", "A Selic já engloba correção e juros: não se soma outro índice no mesmo trecho.");
    }
    return { ...r, indice_efetivo: sub, indice_substituido: true };
  });
}

/** Vigência efetiva = datas fixas do regime ∩ marcos do processo. Regime que fica vazio sai do cálculo. */
function aplicarMarcos(regimes: RegimeAplicado[], marcos: EntradaMotor["marcos"] = {}): RegimeAplicado[] {
  const data = (m: TipoMarco) => {
    const d = marcos[m];
    if (!d || !dataValida(d)) throw new ErroCalculo("marco_obrigatorio", `Informe a data de ${NOMES_MARCO[m].toLowerCase()}: ela define onde muda a regra.`);
    return d;
  };
  return regimes.flatMap((r) => {
    let ini = r.vigencia_inicio, fim = r.vigencia_fim;
    if (r.inicio_no_marco) ini = ini ? maxData(ini, data(r.inicio_no_marco)) : data(r.inicio_no_marco);
    if (r.fim_no_marco) {
      const vespera = somarDias(data(r.fim_no_marco), -1);
      fim = fim ? minData(fim, vespera) : vespera;
    }
    return ini && fim && ini > fim ? [] : [{ ...r, vigencia_inicio: ini, vigencia_fim: fim }];
  });
}

const corrigeDiario = (r: Regime) => r.correcao_pro_rata || r.juros_tipo === "selic_englobando_correcao_e_juros";

/** Corta [inicio, fimExclusivo) pelos regimes. Erro se dois regimes se sobrepõem ou se sobra dia sem regime. */
export function resolverTrechos(regimes: RegimeAplicado[], inicio: string, fimExclusivo: string): Trecho[] {
  if (inicio >= fimExclusivo) return [];
  const ultimo = somarDias(fimExclusivo, -1);
  const relevantes = regimes
    .filter((r) => (r.vigencia_inicio ?? "0000-01-01") <= ultimo && (r.vigencia_fim ?? "9999-12-31") >= inicio)
    .sort((a, b) => (a.vigencia_inicio ?? "").localeCompare(b.vigencia_inicio ?? ""));
  for (let i = 1; i < relevantes.length; i++) {
    const a = relevantes[i - 1], b = relevantes[i];
    if (a.vigencia_fim === null || b.vigencia_inicio === null || a.vigencia_fim >= b.vigencia_inicio) {
      throw new ErroCalculo("regimes_sobrepostos", `Os regimes "${a.nome}" e "${b.nome}" valem ao mesmo tempo. Escolha só um para cada período.`);
    }
  }
  const trechos: Trecho[] = [];
  let cursor = inicio;
  for (const r of relevantes) {
    const ini = maxData(r.vigencia_inicio ?? inicio, inicio);
    if (ini > cursor) throw new ErroCalculo("periodo_sem_regime", `Nenhum regime escolhido vale a partir de ${dataBr(cursor)}.`);
    const fim = minData(r.vigencia_fim ?? ultimo, ultimo);
    trechos.push({ inicio: ini, fim, regime: r });
    cursor = somarDias(fim, 1);
  }
  if (cursor <= ultimo) throw new ErroCalculo("periodo_sem_regime", `Nenhum regime escolhido vale a partir de ${dataBr(cursor)}.`);
  return trechos;
}

/** Fatia [a, b) nos pontos em que muda o trecho. */
function fatias(trechos: Trecho[], a: string, b: string): { de: string; ate: string; trecho: Trecho }[] {
  const out: { de: string; ate: string; trecho: Trecho }[] = [];
  for (const t of trechos) {
    const de = maxData(a, t.inicio);
    const ate = minData(b, somarDias(t.fim, 1));
    if (de < ate) out.push({ de, ate, trecho: t });
  }
  return out;
}

export function atualizar(e: EntradaMotor): ResultadoMotor {
  if (!Number.isSafeInteger(e.valorCentavos) || e.valorCentavos <= 0) throw new ErroCalculo("valor_invalido", "Informe um valor maior que zero.");
  for (const [d, nome] of [[e.dataBase, "data-base"], [e.dataFinal, "data final"]] as const) {
    if (!dataValida(d)) throw new ErroCalculo("data_invalida", `A ${nome} é inválida.`);
  }
  if (e.inicioJuros !== null && !dataValida(e.inicioJuros)) throw new ErroCalculo("data_invalida", "A data de início dos juros é inválida.");
  if (e.dataFinal < e.dataBase) throw new ErroCalculo("periodo_invertido", "A data final não pode ser anterior à data-base.");

  const base = new Dec(e.valorCentavos);
  const D0 = e.dataBase, D1 = e.dataFinal, J0 = e.inicioJuros;
  const comJuros = J0 !== null && J0 < D1;
  const inicio = comJuros && J0! < D0 ? J0! : D0;
  const trechos = resolverTrechos(aplicarMarcos(aplicarSubstitutos(e.regimes, e.indicesSubstitutos), e.marcos), inicio, D1);
  const trechoEm = (dia: string) => trechos.find((t) => t.inicio <= dia && dia <= t.fim)!;

  const faltando = new Set<string>();
  const usadas = new Set<CodigoSerie>();
  const valor = (serie: CodigoSerie, mes: string): Dec => {
    const v = e.indices[serie]?.[mes];
    if (v === undefined || v === null || v === "") {
      faltando.add(`${NOMES_SERIE[serie]} de ${mesBr(mes)}`);
      return ZERO;
    }
    usadas.add(serie);
    return new Dec(v);
  };
  const taxaJuros = (r: RegimeAplicado, mes: string): { serie: CodigoSerie | typeof FIXO; taxa: Dec } | null => {
    switch (r.juros_tipo) {
      case "nenhum": return null;
      case "percentual_ao_mes": return { serie: FIXO, taxa: new Dec(String(r.juros_valor)) };
      case "percentual_fixo_ao_ano_simples": return { serie: FIXO, taxa: new Dec(String(r.juros_valor)).div(12) };
      case "taxa_legal": return { serie: "TAXA_LEGAL", taxa: valor("TAXA_LEGAL", mes) };
      case "tr_art39_lei8177": return { serie: "TR", taxa: valor("TR", mes) };
      case "selic_englobando_correcao_e_juros": return null; // a Selic entra no fator de correção
    }
  };
  const proRata = (taxaMes: Dec, dias: number, dm: number) => (dias === dm ? taxaMes : seisCasas(taxaMes.mul(dias).div(dm)));

  // Teto (Selic do trecho): acumuladores por trecho.
  const porTrecho = new Map<Trecho, { fator: Dec; juros: Dec; selic: Dec }>(trechos.map((t) => [t, { fator: UM, juros: ZERO, selic: ZERO }]));
  const fimDoTrechoNoCalculo = (t: Trecho) => minData(t.fim, somarDias(D1, -1));

  const linhas: LinhaMes[] = [];
  let F = UM;
  let J = ZERO;
  const mesFinal = mesDe(D1);

  for (let m = mesDe(inicio); m <= mesFinal; m = proximoMes(m)) {
    const ini = primeiroDia(m), fimMes = primeiroDia(proximoMes(m)), dm = diasNoMes(m);
    const correcao: Parcela[] = [];
    const juros: Parcela[] = [];
    let fatorMes = UM;
    let jurosMes = ZERO;

    // Correção monetária.
    {
      const a = maxData(D0, ini), b = minData(D1, fimMes);
      if (a < b) {
        const t0 = trechoEm(a);
        const fs = fatias(trechos, a, b);
        const pedacos = fs.some((f) => corrigeDiario(f.trecho.regime))
          ? fs.map((f) => ({ t: f.trecho, dias: diasEntre(f.de, f.ate) as number | null }))
          : m < mesFinal ? [{ t: t0, dias: null as number | null }] : [];
        for (const { t, dias } of pedacos) {
          const acc = porTrecho.get(t)!;
          let f: Dec;
          if (t.regime.juros_tipo === "selic_englobando_correcao_e_juros") {
            // Soma simples da Selic dentro do trecho: o fator do mês é a razão entre os acumulados.
            const s = valor("SELIC", m);
            const aplicada = dias === null ? s : proRata(s, dias, dm);
            f = UM.plus(acc.selic.plus(aplicada).div(CEM)).div(UM.plus(acc.selic.div(CEM)));
            acc.selic = acc.selic.plus(aplicada);
            correcao.push({ serie: "SELIC", regimeId: t.regime.id, percentualMes: s.toString(), aplicado: aplicada.toString(), dias: dias === dm ? null : dias, diasMes: dm });
          } else {
            const idx = t.regime.indice_efetivo;
            if (idx === "nenhuma") continue;
            const i = valor(idx, m);
            const cheio = UM.plus(i.div(CEM));
            f = dias === null || dias === dm ? cheio : cheio.pow(new Dec(dias).div(dm));
            correcao.push({ serie: idx, regimeId: t.regime.id, percentualMes: i.toString(), aplicado: f.minus(UM).mul(CEM).toFixed(8), dias: dias === dm ? null : dias, diasMes: dm });
          }
          fatorMes = fatorMes.mul(f);
          acc.fator = acc.fator.mul(f);
        }
      }
    }

    // Juros de mora.
    if (comJuros) {
      const a = maxData(J0!, ini), b = minData(D1, fimMes);
      if (a < b) {
        const t0 = trechoEm(a);
        const pedacos = t0.regime.juros_pro_rata
          ? fatias(trechos, a, b).map((f) => ({ t: f.trecho, dias: diasEntre(f.de, f.ate) as number | null }))
          : m < mesFinal ? [{ t: t0, dias: null as number | null }] : [];
        for (const { t, dias } of pedacos) {
          const tx = taxaJuros(t.regime, m);
          if (!tx) continue;
          const aplicada = dias === null ? tx.taxa : proRata(tx.taxa, dias, dm);
          jurosMes = jurosMes.plus(aplicada);
          porTrecho.get(t)!.juros = porTrecho.get(t)!.juros.plus(aplicada);
          juros.push({ serie: tx.serie, regimeId: t.regime.id, percentualMes: tx.taxa.toString(), aplicado: aplicada.toString(), dias: dias === dm ? null : dias, diasMes: dm });
        }
      }
    }

    // Teto: no mês em que o trecho termina, corta o excesso de (correção + juros) sobre a Selic do trecho.
    let ajusteTeto: Dec | null = null;
    for (const t of trechos) {
      if (t.regime.teto !== "selic" || mesDe(fimDoTrechoNoCalculo(t)) !== m) continue;
      const acc = porTrecho.get(t)!;
      const selic = somaSelicNoTrecho(t, comJuros ? minData(J0!, D0) : D0, D1, valor);
      const variacao = acc.fator.minus(UM).mul(CEM);
      const excesso = variacao.plus(acc.juros).minus(selic);
      if (excesso.gt(0)) {
        const corte = Dec.min(excesso, acc.juros);
        jurosMes = jurosMes.minus(corte);
        ajusteTeto = (ajusteTeto ?? ZERO).plus(corte);
      }
    }

    if (!correcao.length && !juros.length && ajusteTeto === null) continue;
    F = F.mul(fatorMes);
    J = J.plus(jurosMes);
    const corrigidoExato = base.mul(F);
    const jurosAcum = centavos(corrigidoExato.mul(J).div(CEM));
    const valorCorrigido = centavos(corrigidoExato);
    const ids = [...new Set([...correcao, ...juros].map((p) => p.regimeId))];
    linhas.push({
      mes: m,
      regimes: ids.length ? ids : [trechoEm(maxData(inicio, ini)).regime.id],
      correcao,
      fatorMes: fatorMes.toFixed(10),
      fatorAcumulado: F.toFixed(10),
      valorCorrigido,
      juros,
      jurosMesPercentual: jurosMes.toFixed(6),
      jurosAcumuladoPercentual: J.toFixed(6),
      jurosMes: centavos(corrigidoExato.mul(jurosMes).div(CEM)),
      jurosAcumulados: jurosAcum,
      subtotal: valorCorrigido + jurosAcum,
      ajusteTeto: ajusteTeto ? ajusteTeto.toFixed(6) : null,
    });
  }

  if (faltando.size) {
    const lista = [...faltando];
    throw new ErroCalculo(
      "indice_indisponivel",
      `Índice ainda não disponível: ${lista.slice(0, 6).join(", ")}${lista.length > 6 ? ` e mais ${lista.length - 6}` : ""}. Escolha uma data final anterior ou aguarde a publicação.`,
      lista,
    );
  }

  const corrigido = base.mul(F);
  const jurosExato = corrigido.mul(J).div(CEM);
  const principalCorrigido = centavos(corrigido);
  const jurosCent = centavos(jurosExato);
  return {
    trechos,
    linhas,
    fatorCorrecao: F.toFixed(10),
    jurosPercentual: J.toFixed(6),
    principalOriginal: e.valorCentavos,
    principalCorrigido,
    juros: jurosCent,
    total: principalCorrigido + jurosCent,
    exatos: { corrigido: corrigido.toString(), juros: jurosExato.toString() },
    seriesUsadas: [...usadas].sort(),
  };
}

/** Selic do trecho, juros simples pro rata (mesma regra de 6 casas), para o teto. */
function somaSelicNoTrecho(t: Trecho, inicioCalculo: string, D1: string, valor: (s: CodigoSerie, m: string) => Dec): Dec {
  const de = maxData(t.inicio, inicioCalculo);
  const ate = minData(somarDias(t.fim, 1), D1);
  let soma = ZERO;
  for (let m = mesDe(de); de < ate && m <= mesDe(ate); m = proximoMes(m)) {
    const a = maxData(de, primeiroDia(m)), b = minData(ate, primeiroDia(proximoMes(m)));
    if (a >= b) continue;
    const dm = diasNoMes(m), dias = diasEntre(a, b), taxa = valor("SELIC", m);
    soma = soma.plus(dias === dm ? taxa : seisCasas(taxa.mul(dias).div(dm)));
  }
  return soma;
}
