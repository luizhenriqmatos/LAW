/**
 * Contrato único das fontes jurídicas (DJEN, DataJud e, no futuro, um provedor pago como Judit, Escavador ou Codilo).
 * A regra de negócio (job de captura) só conhece esta interface.
 */

export type NomeFonte = "djen" | "datajud" | "exemplo" | (string & {});

export type FiltroPublicacoes = {
  oab?: { numero: string; uf: string };
  nomeParte?: string;
  nomeAdvogado?: string;
  cnpj?: string;
  /** Primeiro dia de disponibilização incluído (horário de Brasília). */
  desde: Date;
  /** Último dia incluído. Padrão: hoje. */
  ate?: Date;
};

export type AdvogadoCitado = { nome: string; oab: string | null; uf: string | null };
export type Destinatario = { nome: string; polo: string | null };

export type Publicacao = {
  fonte: NomeFonte;
  /** Id da comunicação na fonte (no DJEN, `id`). */
  idExterno: string | null;
  dataDisponibilizacao: string; // AAAA-MM-DD
  tribunal: string;
  orgao: string | null;
  tipoComunicacao: string | null;
  tipoDocumento: string | null;
  classe: string | null;
  /** Texto puro, já sem HTML. */
  texto: string;
  /** Nº CNJ (20 dígitos) informado pela fonte ou extraído do texto, só se o dígito verificador conferir. */
  numeroCnj: string | null;
  /** Todos os nº CNJ válidos citados no texto. */
  numerosCitados: string[];
  advogados: AdvogadoCitado[];
  destinatarios: Destinatario[];
  link: string | null;
  /** Item original, como a fonte mandou. */
  bruto: unknown;
};

export type ProcessoMetadados = {
  numeroCnj: string;
  tribunal: string;
  classe: { codigo: string | null; nome: string | null };
  assuntos: { codigo: string | null; nome: string | null }[];
  orgaoJulgador: string | null;
  grau: string | null;
  dataAjuizamento: string | null;
  nivelSigilo: number | null;
  /** O DataJud público não traz partes; fica vazio quando a fonte não informa. */
  partes: { nome: string; polo: string | null }[];
  movimentos: Movimentacao[];
  bruto: unknown;
};

export type Movimentacao = { dataHora: string; codigo: string | null; nome: string; complementos: string[] };

export type Capacidades = { publicacoes: boolean; processo: boolean; movimentacoes: boolean };

export interface FonteJuridica {
  readonly nome: NomeFonte;
  readonly capacidades: Capacidades;
  buscarPublicacoes(filtro: FiltroPublicacoes): Promise<Publicacao[]>;
  buscarProcesso(numeroCnj: string): Promise<ProcessoMetadados | null>;
  buscarMovimentacoes(numeroCnj: string, desde?: Date): Promise<Movimentacao[]>;
}
