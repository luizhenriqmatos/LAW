import { createHash } from "node:crypto";
import { formatarCnj } from "@/lib/integrations/fontes/cnj";
import type { EventoGoogle } from "@/lib/integrations/google/agenda-api";

export type Origem = "tarefa" | "prazo" | "compromisso";

/** Item como a função `sync_item` do banco devolve. */
export type ItemSync = {
  origem: Origem;
  escritorio_id: string;
  ativo: boolean;
  usuarios: string[];
  titulo: string;
  descricao: string;
  feita: boolean;
  dia_inteiro: boolean;
  data?: string | null; // yyyy-mm-dd (tarefa, prazo)
  inicio?: string | null; // timestamptz (compromisso)
  fim?: string | null;
  tipo?: "audiencia" | "reuniao" | "outro";
  local?: string;
  numero_cnj: string | null;
  restrito: boolean;
};

export const FUSO = "America/Sao_Paulo";

const PREFIXO_COMPROMISSO = { audiencia: "Audiência: ", reuniao: "Reunião: ", outro: "" } as const;

const CAMINHO: Record<Origem, (id: string) => string> = {
  tarefa: (id) => `/app/tarefas/${id}`,
  prazo: () => "/app/prazos",
  compromisso: () => "/app/agenda",
};

function somarDia(data: string, n: number): string {
  const d = new Date(`${data}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Id do evento no Google, determinístico: o mesmo item na mesma conexão sempre gera o mesmo id.
 * Assim, se o LAW cair entre "criar no Google" e "anotar o id", a nova tentativa NÃO duplica (o Google responde 409).
 * O Google aceita só letras a-v e dígitos (base32hex); hexadecimal cabe nisso.
 */
export function idEvento(conexaoId: string, origem: Origem, origemId: string, geracao = 0): string {
  return "e" + createHash("sha256").update(`${conexaoId}|${origem}|${origemId}|${geracao}`).digest("hex").slice(0, 40);
}

export function hashEvento(evento: EventoGoogle): string {
  return createHash("sha256").update(JSON.stringify(evento)).digest("hex");
}

/**
 * Monta o evento do Google. Segredo de justiça: nada do conteúdo real sai do LAW (só um marcador e o link).
 * Prazo vai com o aviso de que é sugestão (regra do produto).
 */
export function montarEvento(item: ItemSync, origemId: string, urlBase: string): { evento: EventoGoogle; hash: string } {
  const link = `${urlBase.replace(/\/+$/, "")}${CAMINHO[item.origem](origemId)}`;
  const partes: string[] = [];
  let titulo: string;
  let local: string | undefined;

  if (item.restrito) {
    titulo = "LAW: item restrito";
    partes.push("Item ligado a processo em segredo de justiça. Abra no LAW para ver os detalhes.");
  } else {
    if (item.origem === "tarefa") titulo = `${item.feita ? "✔ " : ""}${item.titulo}`;
    else if (item.origem === "prazo") titulo = `Prazo: ${item.titulo}`;
    else titulo = `${PREFIXO_COMPROMISSO[item.tipo ?? "outro"]}${item.titulo}`;
    if (item.descricao.trim()) partes.push(item.descricao.trim());
    if (item.numero_cnj) partes.push(`Processo: ${formatarCnj(item.numero_cnj)}`);
    if (item.local?.trim()) local = item.local.trim();
  }
  partes.push(`Abrir no LAW: ${link}`);

  let start: EventoGoogle["start"];
  let end: EventoGoogle["end"];
  if (item.dia_inteiro) {
    if (!item.data) throw new Error("Item de dia inteiro sem data.");
    start = { date: item.data };
    end = { date: somarDia(item.data, 1) }; // no Google o fim de evento de dia inteiro é exclusivo
  } else {
    if (!item.inicio) throw new Error("Compromisso sem início.");
    const ini = new Date(item.inicio);
    let fim = new Date(item.fim ?? item.inicio);
    if (fim.getTime() <= ini.getTime()) fim = new Date(ini.getTime() + 60 * 60 * 1000);
    start = { dateTime: ini.toISOString(), timeZone: FUSO };
    end = { dateTime: fim.toISOString(), timeZone: FUSO };
  }

  const evento: EventoGoogle = { summary: titulo, description: partes.join("\n\n"), start, end, ...(local ? { location: local } : {}) };
  return { evento, hash: hashEvento(evento) };
}
