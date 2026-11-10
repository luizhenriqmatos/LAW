/**
 * Regras do parcelamento (a mesma conta é feita no banco em `lancamento_criar`; aqui serve para mostrar a prévia
 * antes de salvar e é testada contra o banco para nunca divergirem).
 * Tudo em centavos inteiros: nunca usa número com vírgula.
 */
export const MAX_PARCELAS = 120;

/** Divide `total` em `n` parcelas. Todas iguais ao piso; a sobra de centavos inteira vai para a PRIMEIRA. */
export function dividirEmParcelas(totalCentavos: number, n: number): number[] {
  if (!Number.isSafeInteger(totalCentavos) || totalCentavos <= 0) throw new RangeError("valor_invalido");
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARCELAS) throw new RangeError("parcelas_invalidas");
  if (totalCentavos < n) throw new RangeError("parcelas_demais");
  const base = Math.floor(totalCentavos / n);
  const resto = totalCentavos - base * n;
  return Array.from({ length: n }, (_, i) => base + (i === 0 ? resto : 0));
}

const DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Soma meses a uma data AAAA-MM-DD; dia que não existe no mês cai no último dia (31/01 + 1 mês = 28/02). Sempre a partir da data original. */
export function somarMeses(dia: string, meses: number): string {
  const m = DIA.exec(dia);
  if (!m) throw new RangeError("data_invalida");
  const [ano, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const alvo = new Date(Date.UTC(ano, mes - 1 + meses, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  const r = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth(), Math.min(d, ultimo)));
  return r.toISOString().slice(0, 10);
}

export function vencimentosMensais(primeiro: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => somarMeses(primeiro, i));
}

export type StatusParcela = "aberta" | "paga" | "parcial" | "atrasada" | "cancelada";

export const saldoDaParcela = (valor: number, pago: number) => Math.max(valor - pago, 0);

/** Situação para mostrar: aberta/parcial com vencimento passado aparece como atrasada mesmo antes do job diário rodar. */
export function situacaoParcela(status: StatusParcela, vencimento: string, hoje: string): StatusParcela {
  if (status === "aberta" && vencimento < hoje) return "atrasada";
  return status;
}

/** Saldo em aberto: a soma do que falta pagar nas parcelas não pagas e não canceladas. */
export function saldoEmAberto(parcelas: { valor: number; pago: number; status: StatusParcela }[]): number {
  return parcelas.reduce((s, p) => (p.status === "paga" || p.status === "cancelada" ? s : s + saldoDaParcela(p.valor, p.pago)), 0);
}
