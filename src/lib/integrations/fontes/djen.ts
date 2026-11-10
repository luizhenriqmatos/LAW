/**
 * Adaptador do DJEN (Diário de Justiça Eletrônico Nacional, CNJ) — Comunica API.
 *
 * Documentação oficial: https://comunicaapi.pje.jus.br/swagger/index.html (atualizada em 29/05/2025)
 *  - GET /api/v1/comunicacao — pública, sem chave.
 *  - Filtros: numeroOab + ufOab, nomeAdvogado, nomeParte, numeroProcesso (20 dígitos), siglaTribunal,
 *    dataDisponibilizacaoInicio / dataDisponibilizacaoFim (aaaa-mm-dd), meio (D = diário, E = edital),
 *    pagina, itensPorPagina (só 5 ou 100).
 *  - Pesquisas por OAB, nome ou texto, ou com datas diferentes, param em 10.000 resultados.
 *  - Limite por IP (cabeçalhos x-ratelimit-limit / x-ratelimit-remaining). Após HTTP 429, esperar 1 minuto.
 *    Usar vários IPs para contornar o limite é uso abusivo.
 *  - Resposta: { status, message, count, items: [...] }; o texto vem em HTML.
 *  - Recusa acesso de fora do Brasil (HTTP 403, testado em 09/11/2026): rodar só em gru1/sa-east-1. PENDENCIA P-014.
 *  - Não aceita CNPJ como filtro: para sociedade, a busca é pelo nome (nomeParte). PENDENCIA P-018.
 */
import { cnjValido, extrairNumerosCnj, somenteDigitosCnj } from "./cnj";
import { brParaIso, dataBrasilia, listarDias } from "./datas";
import { ErroFonte, FilaRequisicoes, lerJson } from "./fila";
import { htmlParaTexto } from "./normalizar";
import type { FiltroPublicacoes, FonteJuridica, Publicacao } from "./tipos";

export const DJEN_URL = "https://comunicaapi.pje.jus.br/api/v1/comunicacao";
const POR_PAGINA = 100;
const TETO_RESULTADOS = 10000;
const MAX_PAGINAS = TETO_RESULTADOS / POR_PAGINA;

/** Item como a Comunica API devolve (só os campos que usamos; o resto fica no bruto). */
export type ItemDjen = {
  id: number | string;
  data_disponibilizacao?: string | null;
  datadisponibilizacao?: string | null;
  siglaTribunal?: string | null;
  tipoComunicacao?: string | null;
  nomeOrgao?: string | null;
  texto?: string | null;
  numero_processo?: string | null;
  link?: string | null;
  tipoDocumento?: string | null;
  nomeClasse?: string | null;
  destinatarios?: { nome?: string | null; polo?: string | null }[] | null;
  destinatarioadvogados?: { advogado?: { nome?: string | null; numero_oab?: string | null; uf_oab?: string | null } | null }[] | null;
};

type RespostaDjen = { status?: string; message?: string; count?: number; items?: ItemDjen[] };

/** Converte um item do DJEN no formato do LAW. Compartilhado com o adaptador de exemplo. */
export function mapearItemDjen(item: ItemDjen, fonte: Publicacao["fonte"] = "djen"): Publicacao | null {
  const data = item.data_disponibilizacao?.slice(0, 10) || brParaIso(item.datadisponibilizacao);
  const tribunal = (item.siglaTribunal ?? "").trim().toUpperCase();
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !tribunal) return null;

  const texto = htmlParaTexto(item.texto);
  const informado = somenteDigitosCnj(item.numero_processo);
  const citados = extrairNumerosCnj(texto);
  const numeroCnj = informado && cnjValido(informado) ? informado : citados[0] ?? null;
  const numerosCitados = [...new Set([...(numeroCnj ? [numeroCnj] : []), ...citados])];

  const advogados = (item.destinatarioadvogados ?? [])
    .map((d) => d?.advogado)
    .filter((a): a is NonNullable<typeof a> => !!a && !!a.nome)
    .map((a) => ({ nome: String(a.nome).trim(), oab: a.numero_oab ? String(a.numero_oab).trim() : null, uf: a.uf_oab ? String(a.uf_oab).trim().toUpperCase() : null }));
  const destinatarios = (item.destinatarios ?? [])
    .filter((d) => d && d.nome)
    .map((d) => ({ nome: String(d.nome).trim(), polo: d.polo ?? null }));
  const link = item.link && /^https:\/\//i.test(item.link) ? item.link : null;

  return {
    fonte,
    idExterno: item.id != null ? String(item.id) : null,
    dataDisponibilizacao: data,
    tribunal,
    orgao: item.nomeOrgao?.trim() || null,
    tipoComunicacao: item.tipoComunicacao?.trim() || null,
    tipoDocumento: item.tipoDocumento?.trim() || null,
    classe: item.nomeClasse?.trim() || null,
    texto,
    numeroCnj,
    numerosCitados,
    advogados,
    destinatarios,
    link,
    bruto: item,
  };
}

export type OpcoesDjen = { fetch?: typeof fetch; fila?: FilaRequisicoes; url?: string };

export function filaPadraoDjen(): FilaRequisicoes {
  return new FilaRequisicoes({
    fonte: "DJEN",
    intervaloMinimoMs: 500,
    maxTentativas: 4,
    backoffBaseMs: 2000,
    esperaApos429Ms: 60_000,
    timeoutMs: 30_000,
  });
}

export class FonteDjen implements FonteJuridica {
  readonly nome = "djen" as const;
  readonly capacidades = { publicacoes: true, processo: false, movimentacoes: false };
  private readonly fetch: typeof fetch;
  private readonly fila: FilaRequisicoes;
  private readonly url: string;

  constructor(op: OpcoesDjen = {}) {
    this.fetch = op.fetch ?? globalThis.fetch;
    this.fila = op.fila ?? filaPadraoDjen();
    this.url = op.url ?? DJEN_URL;
  }

  async buscarPublicacoes(filtro: FiltroPublicacoes): Promise<Publicacao[]> {
    const base = new URLSearchParams();
    if (filtro.oab) {
      base.set("numeroOab", filtro.oab.numero.replace(/\D/g, ""));
      base.set("ufOab", filtro.oab.uf.toUpperCase());
    }
    if (filtro.nomeAdvogado) base.set("nomeAdvogado", filtro.nomeAdvogado.trim());
    if (filtro.nomeParte) base.set("nomeParte", filtro.nomeParte.trim());
    if (!base.has("numeroOab") && !base.has("nomeAdvogado") && !base.has("nomeParte")) {
      throw new ErroFonte("DJEN", "outro", "Informe OAB, nome do advogado ou nome da parte para buscar no DJEN.");
    }
    const desde = dataBrasilia(filtro.desde);
    const ate = dataBrasilia(filtro.ate ?? new Date());

    const primeira = await this.buscarPeriodo(base, desde, ate);
    // Acima do teto de 10.000, a API corta: refaz dia a dia.
    if (primeira.total >= TETO_RESULTADOS && desde !== ate) {
      const porDia: Publicacao[] = [];
      for (const dia of listarDias(desde, ate)) porDia.push(...(await this.buscarPeriodo(base, dia, dia)).itens);
      return porDia;
    }
    return primeira.itens;
  }

  private async buscarPeriodo(base: URLSearchParams, desde: string, ate: string) {
    const itens: Publicacao[] = [];
    let total = 0;
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      const q = new URLSearchParams(base);
      q.set("dataDisponibilizacaoInicio", desde);
      q.set("dataDisponibilizacaoFim", ate);
      q.set("pagina", String(pagina));
      q.set("itensPorPagina", String(POR_PAGINA));
      const resp = await this.fila.executar((sinal) =>
        this.fetch(`${this.url}?${q.toString()}`, { headers: { Accept: "application/json" }, signal: sinal }),
      );
      const corpo = await lerJson<RespostaDjen>("DJEN", resp);
      if (!Array.isArray(corpo.items)) throw new ErroFonte("DJEN", "resposta_invalida", "O DJEN respondeu sem a lista de comunicações.");
      total = Number(corpo.count ?? 0);
      for (const item of corpo.items) {
        const p = mapearItemDjen(item);
        if (p) itens.push(p);
      }
      const lidos = pagina * POR_PAGINA;
      if (corpo.items.length < POR_PAGINA || lidos >= total) break;
    }
    return { itens, total };
  }

  async buscarProcesso(): Promise<null> {
    return null; // o DJEN não traz metadados do processo
  }

  async buscarMovimentacoes(): Promise<[]> {
    return [];
  }
}
