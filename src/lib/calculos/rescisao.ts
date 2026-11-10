/**
 * Apuração das verbas rescisórias básicas. MÓDULO PURO.
 * Cada verba sai com a regra aplicada (texto) para o demonstrativo. Valores arredondados no centavo, meio para cima,
 * só no valor final de cada verba.
 *
 * Fora desta entrega (PENDENCIA P-052): horas extras e reflexos, adicional noturno, insalubridade, periculosidade,
 * INSS e IR sobre a condenação, desconto do aviso não cumprido no pedido de demissão, faltas que reduzem férias
 * (CLT, art. 130), adiantamento do 13º.
 */
import { CEM, centavos, Dec, dataBr, dataValida, diasEntre, diasNoMes, ErroCalculo, maxData, minData, somarDias } from "./base";

export type TipoDesligamento = "sem_justa_causa" | "pedido_demissao" | "justa_causa" | "acordo_484a";
export const NOMES_DESLIGAMENTO: Record<TipoDesligamento, string> = {
  sem_justa_causa: "Dispensa sem justa causa",
  pedido_demissao: "Pedido de demissão",
  justa_causa: "Dispensa por justa causa",
  acordo_484a: "Acordo entre as partes (CLT, art. 484-A)",
};

export type EntradaRescisao = {
  admissao: string;
  /** Último dia trabalhado / data da comunicação da dispensa. */
  saida: string;
  tipo: TipoDesligamento;
  /** Aviso prévio indenizado (true) ou trabalhado (false). Só conta na dispensa sem justa causa e no acordo. */
  avisoIndenizado: boolean;
  salarioCentavos: number;
  /** Média mensal das parcelas variáveis (comissões, horas extras habituais etc.), opcional. */
  mediasCentavos: number;
  /** Períodos aquisitivos completos e não gozados. */
  feriasVencidas: number;
  /** Quantos desses já passaram do período concessivo (pagos em dobro, CLT, art. 137). */
  feriasVencidasEmDobro: number;
  /** Saldo do FGTS para fins rescisórios (extrato). Sem ele, a multa usa uma estimativa. */
  saldoFgtsCentavos: number | null;
};

export type CodigoVerba =
  | "saldo_salario" | "aviso_previo" | "decimo_terceiro" | "ferias_vencidas" | "terco_ferias_vencidas"
  | "ferias_proporcionais" | "terco_ferias_proporcionais" | "fgts_mes" | "multa_fgts";

export type VerbaApurada = { codigo: CodigoVerba; descricao: string; centavos: number; regra: string };

export type ApuracaoRescisao = {
  verbas: VerbaApurada[];
  /** Data-limite de pagamento das verbas rescisórias (CLT, art. 477, § 6º): saída + 10 dias. Vencimento para atualizar. */
  vencimento: string;
  resumo: { rotulo: string; valor: string }[];
  avisos: string[];
};

const real = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const plural = (n: number, s: string, p: string) => `${n} ${n === 1 ? s : p}`;

function somarMeses(iso: string, n: number): string {
  const [a, m, d] = iso.split("-").map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth(), Math.min(d, ultimo))).toISOString().slice(0, 10);
}

/** Anos completos de serviço: completa 1 ano no dia anterior ao aniversário da admissão (10/03/2021 → 09/03/2022). */
export function anosCompletos(admissao: string, ate: string): number {
  let n = 0;
  while (somarMeses(admissao, 12 * (n + 1)) <= somarDias(ate, 1)) n++;
  return n;
}

/** Aviso prévio proporcional (Lei 12.506/2011): 30 dias + 3 por ano completo, até 90. */
export const diasDeAviso = (anos: number) => Math.min(30 + 3 * anos, 90);

/**
 * Avos (1/12) por mês de calendário com 15 dias ou mais de trabalho entre `de` e `ate` (inclusive) — 13º salário
 * (Lei 4.090/1962, art. 1º, § 2º).
 */
export function avosPorMesCivil(de: string, ate: string): { ano: number; avos: number }[] {
  const out = new Map<number, number>();
  for (let m = de.slice(0, 7); m <= ate.slice(0, 7); ) {
    const ini = maxData(de, `${m}-01`), fim = minData(ate, `${m}-${String(diasNoMes(m)).padStart(2, "0")}`);
    const dias = diasEntre(ini, fim) + 1;
    const ano = Number(m.slice(0, 4));
    if (dias >= 15) out.set(ano, (out.get(ano) ?? 0) + 1);
    else if (!out.has(ano)) out.set(ano, 0);
    const [a, mm] = m.split("-").map(Number);
    m = mm === 12 ? `${a + 1}-01` : `${a}-${String(mm + 1).padStart(2, "0")}`;
  }
  return [...out].map(([ano, avos]) => ({ ano, avos }));
}

/**
 * Avos de férias proporcionais (CLT, art. 146, parágrafo único): 1/12 por mês do período aquisitivo, contado do
 * aniversário da admissão; fração de 15 dias ou mais conta como mês.
 */
export function avosDeFerias(inicioPeriodo: string, ate: string): number {
  let avos = 0;
  for (let i = 0; ; i++) {
    const ini = somarMeses(inicioPeriodo, i);
    if (ini > ate) break;
    const fimCheio = somarDias(somarMeses(inicioPeriodo, i + 1), -1);
    if (fimCheio <= ate) avos++;
    else if (diasEntre(ini, ate) + 1 >= 15) avos++;
  }
  return avos;
}

export function apurarRescisao(e: EntradaRescisao): ApuracaoRescisao {
  if (!dataValida(e.admissao) || !dataValida(e.saida)) throw new ErroCalculo("data_invalida", "Informe as datas de admissão e de saída.");
  if (e.saida < e.admissao) throw new ErroCalculo("periodo_invertido", "A saída não pode ser anterior à admissão.");
  if (!Number.isSafeInteger(e.salarioCentavos) || e.salarioCentavos <= 0) throw new ErroCalculo("valor_invalido", "Informe o último salário.");
  if (!Number.isSafeInteger(e.mediasCentavos) || e.mediasCentavos < 0) throw new ErroCalculo("valor_invalido", "Médias de variáveis inválidas.");
  if (!Number.isInteger(e.feriasVencidas) || e.feriasVencidas < 0 || e.feriasVencidas > 5) throw new ErroCalculo("ferias_invalidas", "Férias vencidas: informe de 0 a 5 períodos.");
  if (!Number.isInteger(e.feriasVencidasEmDobro) || e.feriasVencidasEmDobro < 0 || e.feriasVencidasEmDobro > e.feriasVencidas) {
    throw new ErroCalculo("ferias_invalidas", "Férias em dobro: no máximo o número de períodos vencidos.");
  }

  const salario = new Dec(e.salarioCentavos);
  const R = salario.plus(e.mediasCentavos); // remuneração = salário + médias de variáveis
  const tipo = e.tipo;
  const temAvisoIndenizado = (tipo === "sem_justa_causa" || tipo === "acordo_484a") && e.avisoIndenizado;
  const anos = anosCompletos(e.admissao, e.saida);
  const diasAviso = diasDeAviso(anos);
  const projetada = temAvisoIndenizado ? somarDias(e.saida, diasAviso) : e.saida;
  const textoR = e.mediasCentavos > 0 ? `Remuneração de ${real(R.toNumber())} (salário ${real(e.salarioCentavos)} + médias ${real(e.mediasCentavos)})` : `Salário de ${real(e.salarioCentavos)}`;
  const verbas: VerbaApurada[] = [];
  const v = (codigo: CodigoVerba, descricao: string, valor: Dec | number, regra: string) =>
    verbas.push({ codigo, descricao, centavos: typeof valor === "number" ? valor : centavos(valor), regra });

  // 1. Saldo de salário (dias trabalhados no mês da saída; divisor 30; mês inteiro = salário integral).
  const mesSaida = e.saida.slice(0, 7);
  const iniMes = maxData(e.admissao, `${mesSaida}-01`);
  const diasTrab = diasEntre(iniMes, e.saida) + 1;
  const mesInteiro = iniMes === `${mesSaida}-01` && diasTrab === diasNoMes(mesSaida);
  v("saldo_salario", "Saldo de salário", mesInteiro ? salario : salario.div(30).mul(diasTrab),
    mesInteiro ? `Mês da saída trabalhado por inteiro: salário integral de ${real(e.salarioCentavos)}.`
      : `${plural(diasTrab, "dia trabalhado", "dias trabalhados")} no mês da saída × salário ÷ 30 (${real(e.salarioCentavos)} ÷ 30 × ${diasTrab}). Variáveis do mês não incluídas.`);

  // 2. Aviso prévio indenizado, proporcional ao tempo de serviço.
  if (temAvisoIndenizado) {
    const cheio = R.div(30).mul(diasAviso);
    const metade = tipo === "acordo_484a";
    v("aviso_previo", metade ? "Aviso prévio indenizado (metade)" : "Aviso prévio indenizado", metade ? cheio.div(2) : cheio,
      `${plural(anos, "ano completo", "anos completos")} de serviço → ${diasAviso} dias de aviso (30 + 3 por ano, até 90; Lei 12.506/2011). ${textoR} ÷ 30 × ${diasAviso}${metade ? " ÷ 2 (CLT, art. 484-A, I, a)" : ""}. Projeta o contrato até ${dataBr(projetada)} (CLT, art. 487, § 1º).`);
  } else {
    v("aviso_previo", "Aviso prévio", 0,
      tipo === "pedido_demissao" ? "Pedido de demissão: o aviso é do empregado; não há aviso a pagar. Desconto de aviso não cumprido não está neste cálculo."
        : tipo === "justa_causa" ? "Justa causa: aviso prévio não é devido."
          : "Aviso prévio trabalhado: já pago como salário; não há verba de aviso.");
  }

  // 3. 13º salário proporcional (avos por mês civil com 15+ dias, até a data projetada).
  if (tipo !== "justa_causa") {
    const porAno = avosPorMesCivil(maxData(e.admissao, `${e.saida.slice(0, 4)}-01-01`), projetada).filter((x) => x.avos > 0);
    const avos = porAno.reduce((s, x) => s + x.avos, 0);
    v("decimo_terceiro", "13º salário proporcional", R.mul(avos).div(12),
      `${avos}/12 (${porAno.map((x) => `${x.avos}/12 de ${x.ano}`).join(" + ")}): um avo por mês com 15 dias ou mais de trabalho até ${dataBr(projetada)} (Lei 4.090/1962). ${textoR} × ${avos} ÷ 12.`);
  } else {
    v("decimo_terceiro", "13º salário proporcional", 0, "Justa causa: 13º proporcional não é devido (Lei 4.090/1962, art. 3º).");
  }

  // 4. Férias vencidas + 1/3 (devidas em qualquer desligamento).
  if (e.feriasVencidas > 0) {
    const simples = e.feriasVencidas - e.feriasVencidasEmDobro;
    const ferias = R.mul(simples + 2 * e.feriasVencidasEmDobro);
    v("ferias_vencidas", "Férias vencidas", ferias,
      `${plural(e.feriasVencidas, "período vencido", "períodos vencidos")}${e.feriasVencidasEmDobro ? `, ${e.feriasVencidasEmDobro} em dobro (CLT, art. 137)` : ""}. ${textoR} × ${simples + 2 * e.feriasVencidasEmDobro}.`);
    v("terco_ferias_vencidas", "1/3 sobre férias vencidas", ferias.div(3), "Terço constitucional (CF, art. 7º, XVII) sobre as férias vencidas.");
  }

  // 5. Férias proporcionais + 1/3 (não devidas na justa causa: Súmula 171 do TST).
  if (tipo !== "justa_causa") {
    let inicioPeriodo = e.admissao;
    while (somarMeses(inicioPeriodo, 12) <= e.saida) inicioPeriodo = somarMeses(inicioPeriodo, 12);
    const avos = avosDeFerias(inicioPeriodo, projetada);
    const fp = R.mul(avos).div(12);
    v("ferias_proporcionais", "Férias proporcionais", fp,
      `${avos}/12: período aquisitivo iniciado em ${dataBr(inicioPeriodo)}, um avo por mês (ou fração de 15 dias ou mais) até ${dataBr(projetada)} (CLT, art. 146, parágrafo único)${avos > 12 ? "; inclui o período completado durante a projeção do aviso" : ""}. ${textoR} × ${avos} ÷ 12.`);
    v("terco_ferias_proporcionais", "1/3 sobre férias proporcionais", fp.div(3), "Terço constitucional (CF, art. 7º, XVII) sobre as férias proporcionais.");
  } else {
    v("ferias_proporcionais", "Férias proporcionais", 0, "Justa causa: férias proporcionais não são devidas (Súmula 171 do TST).");
  }

  // 6. FGTS do mês da rescisão: 8% sobre saldo de salário, aviso indenizado e 13º (férias indenizadas não incidem).
  const valorDe = (c: CodigoVerba) => verbas.find((x) => x.codigo === c)?.centavos ?? 0;
  const baseFgts = valorDe("saldo_salario") + valorDe("aviso_previo") + valorDe("decimo_terceiro");
  const fgtsMes = centavos(new Dec(baseFgts).mul(8).div(CEM));
  v("fgts_mes", "FGTS do mês da rescisão (8%)", fgtsMes,
    `8% sobre saldo de salário + aviso prévio indenizado + 13º (${real(baseFgts)}). Férias indenizadas e o terço não incidem (OJ 195 da SBDI-1 do TST). Lei 8.036/1990, art. 15; Súmula 305 do TST.`);

  // 7. Multa do FGTS: 40% (sem justa causa) ou 20% (acordo) sobre o saldo para fins rescisórios + depósitos da rescisão.
  const avisos: string[] = [];
  if (tipo === "sem_justa_causa" || tipo === "acordo_484a") {
    const pct = tipo === "sem_justa_causa" ? 40 : 20;
    let saldo: number, origem: string;
    if (e.saldoFgtsCentavos !== null) {
      saldo = e.saldoFgtsCentavos;
      origem = `saldo informado de ${real(saldo)}`;
    } else {
      const meses = mesesCompletos(e.admissao, e.saida);
      saldo = centavos(R.mul(8).div(CEM).mul(meses).mul(40).div(36));
      origem = `saldo ESTIMADO de ${real(saldo)} (8% × remuneração × ${meses} meses × 40/36, que considera 13º e terço de férias; sem juros e correção da conta)`;
      avisos.push("A multa do FGTS usou um saldo estimado. Para o valor exato, informe o saldo para fins rescisórios do extrato do FGTS.");
    }
    v("multa_fgts", `Multa de ${pct}% do FGTS`, new Dec(saldo + fgtsMes).mul(pct).div(CEM),
      `${pct}% sobre ${origem} + FGTS do mês da rescisão (${real(fgtsMes)}). Lei 8.036/1990, art. 18, § 1º${pct === 20 ? "; CLT, art. 484-A, I, b" : ""}.`);
  } else {
    v("multa_fgts", "Multa do FGTS", 0, `${NOMES_DESLIGAMENTO[tipo]}: não há multa do FGTS.`);
  }

  const vencimento = somarDias(e.saida, 10);
  return {
    verbas,
    vencimento,
    resumo: [
      { rotulo: "Desligamento", valor: `${NOMES_DESLIGAMENTO[tipo]}${(tipo === "sem_justa_causa" || tipo === "acordo_484a") ? `, aviso ${e.avisoIndenizado ? "indenizado" : "trabalhado"}` : ""}` },
      { rotulo: "Admissão e saída", valor: `${dataBr(e.admissao)} a ${dataBr(e.saida)} (${plural(anos, "ano completo", "anos completos")})` },
      { rotulo: "Remuneração de cálculo", valor: textoR },
      ...(temAvisoIndenizado ? [{ rotulo: "Projeção do aviso", valor: `${diasAviso} dias, até ${dataBr(projetada)}` }] : []),
      { rotulo: "Vencimento das verbas", valor: `${dataBr(vencimento)} (10 dias após a saída; CLT, art. 477, § 6º)` },
    ],
    avisos,
  };
}

function mesesCompletos(de: string, ate: string): number {
  let n = 0;
  while (somarMeses(de, n + 1) <= somarDias(ate, 1)) n++;
  return n;
}
