export const TIPOS = { receita: "Receita", despesa: "Despesa" } as const;
export type TipoLancamento = keyof typeof TIPOS;

export const CATEGORIAS = {
  honorarios_contratuais: "Honorários contratuais",
  exito: "Êxito",
  custas: "Custas",
  reembolso: "Reembolso",
  despesa_fixa: "Despesa fixa",
  outros: "Outros",
} as const;
export type Categoria = keyof typeof CATEGORIAS;

export const FORMAS = {
  pix: "Pix",
  transferencia: "Transferência",
  boleto: "Boleto",
  cartao: "Cartão",
  dinheiro: "Dinheiro",
  cheque: "Cheque",
  outro: "Outro",
} as const;
export type Forma = keyof typeof FORMAS;

export const STATUS_PARCELA = {
  aberta: "Aberta",
  paga: "Paga",
  parcial: "Parcial",
  atrasada: "Atrasada",
  cancelada: "Cancelada",
} as const;

export const SITUACOES_LANCAMENTO = { aberto: "Com saldo em aberto", atrasado: "Com parcela atrasada", quitado: "Quitado", cancelado: "Cancelado" } as const;
export const SITUACOES_PARCELA = { em_aberto: "Em aberto", atrasada: "Atrasada", paga: "Paga", cancelada: "Cancelada" } as const;

export const ehCategoria = (v: unknown): v is Categoria => typeof v === "string" && v in CATEGORIAS;
export const ehTipo = (v: unknown): v is TipoLancamento => v === "receita" || v === "despesa";
export const ehForma = (v: unknown): v is Forma => typeof v === "string" && v in FORMAS;
