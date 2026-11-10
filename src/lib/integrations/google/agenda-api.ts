import { ErroGoogle } from "./erro";
import type { Fetch } from "./oauth";

export type DataGoogle = { date?: string; dateTime?: string; timeZone?: string };
export type EventoGoogle = {
  summary: string;
  description?: string;
  location?: string;
  start: DataGoogle;
  end: DataGoogle;
  status?: "confirmed";
};

/** O que o LAW usa do Google Agenda. A implementação real é `apiGoogleAgenda`; os testes usam uma falsa em memória. */
export interface GoogleAgendaApi {
  criarCalendario(token: string, nome: string): Promise<{ id: string }>;
  calendarioExiste(token: string, calendarioId: string): Promise<boolean>;
  inserirEvento(token: string, calendarioId: string, eventId: string, evento: EventoGoogle): Promise<void>; // 409 => ErroGoogle("conflito")
  atualizarEvento(token: string, calendarioId: string, eventId: string, evento: EventoGoogle): Promise<void>; // 404/410 => ErroGoogle("nao_encontrado")
  apagarEvento(token: string, calendarioId: string, eventId: string): Promise<void>; // 404/410 contam como já apagado
}

const BASE = "https://www.googleapis.com/calendar/v3";

async function chamar(f: Fetch, token: string, metodo: string, caminho: string, corpo?: unknown) {
  let res: Response;
  try {
    res = await f(`${BASE}${caminho}`, {
      method: metodo,
      headers: { authorization: `Bearer ${token}`, ...(corpo ? { "content-type": "application/json" } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  } catch {
    throw new ErroGoogle("indisponivel", "Sem resposta do Google Agenda.");
  }
  return res;
}

async function falha(res: Response, contexto: "evento" | "calendario" | "criar_evento"): Promise<never> {
  const json = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[]; message?: string } };
  const motivo = json.error?.errors?.[0]?.reason ?? "";
  const msg = `Google Agenda (${res.status}${motivo ? `: ${motivo}` : ""}).`;
  if (res.status === 401) throw new ErroGoogle("nao_autorizado", msg);
  if (res.status === 409) throw new ErroGoogle("conflito", msg);
  if (res.status === 429 || (res.status === 403 && /ratelimit|quota/i.test(motivo))) throw new ErroGoogle("limite", msg);
  if (res.status === 403) throw new ErroGoogle("revogado", msg);
  if (res.status === 404 || res.status === 410) {
    throw new ErroGoogle(contexto === "evento" ? "nao_encontrado" : "calendario_removido", msg);
  }
  if (res.status >= 500) throw new ErroGoogle("indisponivel", msg);
  throw new ErroGoogle("outro", msg);
}

export function apiGoogleAgenda(f: Fetch = fetch): GoogleAgendaApi {
  const cal = (id: string) => encodeURIComponent(id);
  return {
    async criarCalendario(token, nome) {
      const res = await chamar(f, token, "POST", "/calendars", { summary: nome, timeZone: "America/Sao_Paulo" });
      if (!res.ok) await falha(res, "calendario");
      const json = (await res.json()) as { id: string };
      return { id: json.id };
    },
    async calendarioExiste(token, calendarioId) {
      const res = await chamar(f, token, "GET", `/calendars/${cal(calendarioId)}`);
      if (res.ok) return true;
      if (res.status === 404 || res.status === 410) return false;
      return falha(res, "calendario");
    },
    async inserirEvento(token, calendarioId, eventId, evento) {
      const res = await chamar(f, token, "POST", `/calendars/${cal(calendarioId)}/events`, { ...evento, id: eventId });
      if (!res.ok) await falha(res, "criar_evento");
    },
    async atualizarEvento(token, calendarioId, eventId, evento) {
      const res = await chamar(f, token, "PUT", `/calendars/${cal(calendarioId)}/events/${encodeURIComponent(eventId)}`, { ...evento, status: "confirmed" });
      if (!res.ok) await falha(res, "evento");
    },
    async apagarEvento(token, calendarioId, eventId) {
      const res = await chamar(f, token, "DELETE", `/calendars/${cal(calendarioId)}/events/${encodeURIComponent(eventId)}`);
      if (res.ok || res.status === 404 || res.status === 410) return;
      await falha(res, "evento");
    },
  };
}
