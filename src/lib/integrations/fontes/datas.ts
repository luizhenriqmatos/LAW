/** Datas no calendário de Brasília (AAAA-MM-DD), sem depender do fuso do servidor. */

export function dataBrasilia(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function somarDias(iso: string, dias: number): string {
  const [a, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d + dias));
  return dt.toISOString().slice(0, 10);
}

// Só para a data de publicação ESTIMADA gravada na captura (informativa). A contagem de prazo usa o calendário
// forense completo (src/lib/prazos/contagem.ts + tabela calendario_forense). PENDENCIA P-007.
const FERIADOS_NACIONAIS_FIXOS = ["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25"];

export function ehDiaUtilBasico(iso: string): boolean {
  const [a, m, d] = iso.split("-").map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  return dia !== 0 && dia !== 6 && !FERIADOS_NACIONAIS_FIXOS.includes(iso.slice(5));
}

/**
 * Data de publicação estimada: primeiro dia útil seguinte à disponibilização (Lei 11.419/2006, art. 4º, § 3º; CPC, art. 224).
 * É informativa; o cálculo de prazo (Prompt 4) recalcula com o calendário forense completo.
 */
export function dataPublicacaoEstimada(disponibilizacao: string): string {
  let d = somarDias(disponibilizacao, 1);
  while (!ehDiaUtilBasico(d)) d = somarDias(d, 1);
  return d;
}

/** dd/mm/aaaa → aaaa-mm-dd (o DJEN manda os dois formatos). */
export function brParaIso(br: string | null | undefined): string | null {
  const m = String(br ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function listarDias(desde: string, ate: string): string[] {
  const dias: string[] = [];
  for (let d = desde; d <= ate; d = somarDias(d, 1)) dias.push(d);
  return dias;
}
