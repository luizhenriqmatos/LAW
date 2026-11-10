import type { EventoGoogle, GoogleAgendaApi } from "@/lib/integrations/google/agenda-api";
import { ErroGoogle } from "@/lib/integrations/google/erro";

/**
 * Google Agenda de mentira, em memória, com as mesmas regras que importam: id de evento único (409),
 * evento apagado responde 404, token recusado responde 401. Cada usuário tem os seus calendários.
 */
export class GoogleFalso implements GoogleAgendaApi {
  calendarios = new Map<string, { nome: string; dono: string; eventos: Map<string, EventoGoogle> }>();
  chamadas: string[] = [];
  tokensRecusados = new Set<string>(); // access tokens que dão 401
  refreshRevogados = new Set<string>(); // refresh tokens que o Google não aceita mais
  falhaTemporaria: "limite" | "indisponivel" | null = null;
  private n = 0;

  private dono(token: string) {
    return token.replace(/^acc-/, "").replace(/-\d+$/, "");
  }
  private checar(token: string) {
    if (this.tokensRecusados.has(token)) throw new ErroGoogle("nao_autorizado", "401");
    if (this.falhaTemporaria) throw new ErroGoogle(this.falhaTemporaria, this.falhaTemporaria);
  }
  private cal(token: string, id: string) {
    const c = this.calendarios.get(id);
    if (!c || c.dono !== this.dono(token)) throw new ErroGoogle("calendario_removido", "404");
    return c;
  }

  /** Para a conexão: o "usuário do Google" é o refresh token (ex.: "ana"); o access token vira acc-ana-N. */
  renovar = async (refresh: string) => {
    this.chamadas.push(`renovar:${refresh}`);
    if (this.refreshRevogados.has(refresh)) throw new ErroGoogle("revogado", "invalid_grant");
    return { accessToken: `acc-${refresh}-${++this.n}`, expiraEm: new Date(Date.now() + 3600_000) };
  };

  async criarCalendario(token: string, nome: string) {
    this.checar(token);
    const id = `cal-${this.dono(token)}-${++this.n}`;
    this.calendarios.set(id, { nome, dono: this.dono(token), eventos: new Map() });
    this.chamadas.push(`criarCalendario:${nome}`);
    return { id };
  }
  async calendarioExiste(token: string, id: string) {
    this.checar(token);
    return this.calendarios.get(id)?.dono === this.dono(token);
  }
  async inserirEvento(token: string, calendarioId: string, eventId: string, evento: EventoGoogle) {
    this.checar(token);
    const c = this.cal(token, calendarioId);
    this.chamadas.push(`inserir:${eventId}`);
    if (c.eventos.has(eventId)) throw new ErroGoogle("conflito", "409");
    c.eventos.set(eventId, evento);
  }
  async atualizarEvento(token: string, calendarioId: string, eventId: string, evento: EventoGoogle) {
    this.checar(token);
    const c = this.cal(token, calendarioId);
    this.chamadas.push(`atualizar:${eventId}`);
    if (!c.eventos.has(eventId)) throw new ErroGoogle("nao_encontrado", "404");
    c.eventos.set(eventId, evento);
  }
  async apagarEvento(token: string, calendarioId: string, eventId: string) {
    this.checar(token);
    const c = this.cal(token, calendarioId);
    this.chamadas.push(`apagar:${eventId}`);
    c.eventos.delete(eventId);
  }

  eventosDe(dono: string): EventoGoogle[] {
    return [...this.calendarios.values()].filter((c) => c.dono === dono).flatMap((c) => [...c.eventos.values()]);
  }
  total(): number {
    return [...this.calendarios.values()].reduce((s, c) => s + c.eventos.size, 0);
  }
}
