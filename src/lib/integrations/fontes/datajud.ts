/**
 * Adaptador da API Pública do DataJud (CNJ) — metadados e movimentos por número CNJ.
 * Documentação: https://datajud-wiki.cnj.jus.br/api-publica/
 *  - POST https://api-publica.datajud.cnj.jus.br/api_publica_<tribunal>/_search (um endpoint por tribunal).
 *  - Cabeçalho: Authorization: APIKey <chave pública divulgada pelo CNJ>. O CNJ pode trocar a chave a qualquer momento:
 *    HTTP 401 aqui = chave vencida (atualizar DATAJUD_API_KEY).
 *  - Não traz texto de intimação nem partes, e não devolve processos em segredo de justiça.
 *  - Instável sob carga: responde 429 com o servidor cheio (visto em 09/11/2026) — fila com espera crescente.
 */
import { somenteDigitosCnj, tribunalDataJud } from "./cnj";
import { ErroFonte, FilaRequisicoes, lerJson } from "./fila";
import type { FonteJuridica, Movimentacao, ProcessoMetadados } from "./tipos";

export const DATAJUD_URL = "https://api-publica.datajud.cnj.jus.br";

type Codigo = { codigo?: number | string | null; nome?: string | null };
type OrigemDataJud = {
  numeroProcesso?: string;
  tribunal?: string;
  grau?: string;
  dataAjuizamento?: string;
  nivelSigilo?: number;
  classe?: Codigo;
  orgaoJulgador?: Codigo;
  assuntos?: (Codigo | Codigo[])[];
  movimentos?: { codigo?: number | string; nome?: string; dataHora?: string; complementosTabelados?: { nome?: string; descricao?: string }[] }[];
};
type RespostaDataJud = { hits?: { hits?: { _source?: OrigemDataJud }[] } };

/** "20190514000000" → "2019-05-14T00:00:00"; ISO passa direto. */
function dataDataJud(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : v;
}

const cod = (c: Codigo | undefined | null) => ({ codigo: c?.codigo != null ? String(c.codigo) : null, nome: c?.nome ?? null });

export function mapearDataJud(numero: string, fontes: OrigemDataJud[]): ProcessoMetadados | null {
  if (!fontes.length) return null;
  const principal = fontes[0];
  const movimentos: Movimentacao[] = [];
  const vistos = new Set<string>();
  for (const f of fontes) {
    for (const m of f.movimentos ?? []) {
      const chave = `${m.dataHora}|${m.codigo}|${m.nome}`;
      if (vistos.has(chave) || !m.nome) continue;
      vistos.add(chave);
      movimentos.push({
        dataHora: dataDataJud(m.dataHora) ?? "",
        codigo: m.codigo != null ? String(m.codigo) : null,
        nome: m.nome,
        complementos: (m.complementosTabelados ?? []).map((c) => [c.nome, c.descricao].filter(Boolean).join(": ")).filter(Boolean),
      });
    }
  }
  movimentos.sort((a, b) => a.dataHora.localeCompare(b.dataHora));
  return {
    numeroCnj: numero,
    tribunal: (principal.tribunal ?? "").toUpperCase(),
    classe: cod(principal.classe),
    assuntos: (principal.assuntos ?? []).flat().map(cod),
    orgaoJulgador: principal.orgaoJulgador?.nome ?? null,
    grau: principal.grau ?? null,
    dataAjuizamento: dataDataJud(principal.dataAjuizamento),
    nivelSigilo: typeof principal.nivelSigilo === "number" ? principal.nivelSigilo : null,
    partes: [],
    movimentos,
    bruto: fontes,
  };
}

export type OpcoesDataJud = { apiKey: string | undefined; fetch?: typeof fetch; fila?: FilaRequisicoes; url?: string };

export function filaPadraoDataJud(): FilaRequisicoes {
  return new FilaRequisicoes({
    fonte: "DataJud",
    intervaloMinimoMs: 300,
    maxTentativas: 5,
    backoffBaseMs: 2000,
    esperaApos429Ms: 10_000,
    timeoutMs: 60_000, // buscas amplas passam de 50 s
  });
}

export class FonteDataJud implements FonteJuridica {
  readonly nome = "datajud" as const;
  readonly capacidades = { publicacoes: false, processo: true, movimentacoes: true };
  private readonly fetch: typeof fetch;
  private readonly fila: FilaRequisicoes;
  private readonly url: string;

  constructor(private readonly op: OpcoesDataJud) {
    this.fetch = op.fetch ?? globalThis.fetch;
    this.fila = op.fila ?? filaPadraoDataJud();
    this.url = op.url ?? DATAJUD_URL;
  }

  async buscarPublicacoes(): Promise<[]> {
    return []; // o DataJud não traz publicações
  }

  async buscarProcesso(numeroCnj: string): Promise<ProcessoMetadados | null> {
    const numero = somenteDigitosCnj(numeroCnj);
    if (!numero) return null;
    const tribunal = tribunalDataJud(numero);
    if (!tribunal) return null; // STF/CNJ ou segmento sem índice público
    if (!this.op.apiKey) {
      throw new ErroFonte("DataJud", "chave_recusada", "Chave do DataJud não configurada (DATAJUD_API_KEY).");
    }
    const resp = await this.fila.executar((sinal) =>
      this.fetch(`${this.url}/api_publica_${tribunal}/_search`, {
        method: "POST",
        headers: { Authorization: `APIKey ${this.op.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ size: 10, query: { match: { numeroProcesso: numero } } }),
        signal: sinal,
      }),
    );
    const corpo = await lerJson<RespostaDataJud>("DataJud", resp);
    const fontes = (corpo.hits?.hits ?? []).map((h) => h._source).filter((s): s is OrigemDataJud => !!s);
    return mapearDataJud(numero, fontes);
  }

  async buscarMovimentacoes(numeroCnj: string, desde?: Date): Promise<Movimentacao[]> {
    const p = await this.buscarProcesso(numeroCnj);
    if (!p) return [];
    if (!desde) return p.movimentos;
    const corte = desde.toISOString().slice(0, 19);
    return p.movimentos.filter((m) => m.dataHora >= corte);
  }
}
