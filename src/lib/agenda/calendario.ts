/** Grade do mês para a Agenda. Tudo em strings AAAA-MM-DD (dia de Brasília), sem fuso do servidor. */
const NOMES_MES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const DIAS_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

const pad = (n: number) => String(n).padStart(2, "0");

export function mesValido(valor: string | undefined | null): string | null {
  return valor && /^\d{4}-(0[1-9]|1[0-2])$/.test(valor) ? valor : null;
}

export function diaValido(valor: string | undefined | null): string | null {
  if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return null;
  const d = new Date(`${valor}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor ? null : valor;
}

export function nomeDoMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return `${NOMES_MES[m - 1]} de ${a}`;
}

export function mesVizinho(mes: string, delta: number): string {
  const [a, m] = mes.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** Semanas (dom a sáb) que cobrem o mês. Dias de fora do mês vêm marcados para a grade ficar cheia. */
export function semanasDoMes(mes: string): { dia: string; doMes: boolean }[][] {
  const [a, m] = mes.split("-").map(Number);
  const primeiro = new Date(Date.UTC(a, m - 1, 1));
  const inicio = new Date(Date.UTC(a, m - 1, 1 - primeiro.getUTCDay()));
  const ultimo = new Date(Date.UTC(a, m, 0));
  const fim = new Date(Date.UTC(a, m, 0 + (6 - ultimo.getUTCDay())));
  const semanas: { dia: string; doMes: boolean }[][] = [];
  for (let d = new Date(inicio); d <= fim; ) {
    const semana: { dia: string; doMes: boolean }[] = [];
    for (let i = 0; i < 7; i++, d.setUTCDate(d.getUTCDate() + 1)) {
      semana.push({ dia: d.toISOString().slice(0, 10), doMes: d.getUTCMonth() === m - 1 });
    }
    semanas.push(semana);
  }
  return semanas;
}

/** "2026-11-10T13:00:00+00:00" -> "10:00" em Brasília. */
export function horaBrasilia(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** Valor de <input type="datetime-local"> (hora de Brasília, sem fuso) -> ISO com fuso -03:00 (sem horário de verão desde 2019). */
export function localParaIso(valor: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(valor) && !Number.isNaN(new Date(`${valor}:00-03:00`).getTime()) ? `${valor}:00-03:00` : null;
}

/** ISO -> valor para <input type="datetime-local"> em Brasília. */
export function isoParaLocal(iso: string): string {
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return p.replace(" ", "T");
}
