/**
 * Regras dos alertas de prazo. MÓDULO PURO (o envio fica em executar-alertas.ts).
 *
 * Para o responsável, por e-mail e aviso no app:
 *  - "antes_3": 3 dias (corridos) antes do vencimento — uma única vez;
 *  - "dia": no dia do vencimento, a partir das 7h (Bahia/Brasília);
 *  - "vencido": todo dia, a partir das 7h, até o prazo ser marcado como cumprido (ou cancelado).
 * Cada alerta tem uma chave (prazo + tipo + data) e nunca é enviado duas vezes; se o job rodar de novo
 * (ou atrasar), só vai o que faltou.
 */
import { dataBrasilia, somarDias } from "@/lib/integrations/fontes/datas";

export const HORA_ALERTA = 7;
export const DIAS_ANTECEDENCIA = 3;
export type TipoAlerta = "antes_3" | "dia" | "vencido";

export type PrazoParaAlerta = { id: string; dataFinal: string; status: string };
export type AlertaEnviado = { prazoId: string; tipo: TipoAlerta; dataRef: string };
export type AlertaDevido = { prazoId: string; tipo: TipoAlerta; dataRef: string };

export function horaBrasilia(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(d)) % 24;
}

export function situacaoDoPrazo(status: string, dataFinal: string, hoje: string): "aberto" | "cumprido" | "vencido" | "cancelado" {
  if (status === "cumprido" || status === "cancelado") return status;
  return dataFinal < hoje ? "vencido" : "aberto";
}

export function alertasDevidos(prazos: PrazoParaAlerta[], jaEnviados: AlertaEnviado[], agora: Date): AlertaDevido[] {
  if (horaBrasilia(agora) < HORA_ALERTA) return []; // antes das 7h ninguém é acordado
  const hoje = dataBrasilia(agora);
  const enviados = new Set(jaEnviados.map((a) => `${a.prazoId}|${a.tipo}|${a.dataRef}`));
  const devidos: AlertaDevido[] = [];
  for (const p of prazos) {
    if (p.status !== "aberto") continue;
    let tipo: TipoAlerta | null = null;
    let dataRef = hoje;
    if (hoje > p.dataFinal) tipo = "vencido";
    else if (hoje === p.dataFinal) tipo = "dia";
    else if (hoje >= somarDias(p.dataFinal, -DIAS_ANTECEDENCIA)) {
      tipo = "antes_3";
      dataRef = p.dataFinal; // um só por prazo, mesmo se o job atrasar um dia
    }
    if (tipo && !enviados.has(`${p.id}|${tipo}|${dataRef}`)) devidos.push({ prazoId: p.id, tipo, dataRef });
  }
  return devidos;
}

export const ROTULO_ALERTA: Record<TipoAlerta, string> = {
  antes_3: "vence em 3 dias",
  dia: "vence HOJE",
  vencido: "VENCIDO",
};
