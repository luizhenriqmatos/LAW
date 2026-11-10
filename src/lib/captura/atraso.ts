import { dataBrasilia, somarDias } from "@/lib/integrations/fontes/datas";

export type SituacaoCaptura = "em_dia" | "atrasada" | "falhou" | "nao_configurada" | "aguardando_primeira";

/** Hora (em Brasília) até a qual a captura do dia precisa ter terminado. A rotina roda às 4h. */
export const HORA_LIMITE = 8;

function horaBrasilia(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }).format(d));
}

/**
 * Regra do aviso: falha ou atraso na captura aparece como alerta, nunca como "nenhuma publicação".
 *  - depois das 8h, a última captura OK precisa ser de hoje;
 *  - antes das 8h, basta ser de ontem (a de hoje ainda pode estar rodando).
 */
export function situacaoCaptura(p: { modo: string | null; status: string; ultimaOk: string | null }, agora = new Date()): SituacaoCaptura {
  if (!p.modo) return "nao_configurada";
  if (p.status === "erro") return "falhou";
  if (!p.ultimaOk) return p.status === "aguardando_busca" || p.status === "buscando" ? "aguardando_primeira" : "atrasada";
  const hoje = dataBrasilia(agora);
  const diaOk = dataBrasilia(new Date(p.ultimaOk));
  const exigido = horaBrasilia(agora) >= HORA_LIMITE ? hoje : somarDias(hoje, -1);
  return diaOk >= exigido ? "em_dia" : "atrasada";
}
