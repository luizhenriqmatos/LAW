import { CATEGORIAS, FORMAS, TIPOS, STATUS_PARCELA } from "./rotulos";
import { situacaoParcela, type StatusParcela } from "./parcelas";

/** Linha vinda de `financeiro_parcelas` (valores em centavos). */
export type LinhaParcela = {
  id: string; lancamento_id: string; numero: number; total_parcelas: number;
  valor_centavos: number; valor_pago_centavos: number; vencimento: string; data_pagamento: string | null;
  forma_pagamento: string | null; status: StatusParcela;
  tipo: "receita" | "despesa"; categoria: string; descricao: string; data_competencia: string;
  cliente_nome: string | null; numero_cnj: string | null;
};

/**
 * Planilha aberta no Excel brasileiro: separador ";" e vírgula decimal. Texto que começaria com = + - @ vira texto
 * (prefixo apóstrofo), porque "=cmd|..." numa descrição viraria fórmula ao abrir (injeção de fórmula em CSV).
 */
export function celula(valor: string | number | null | undefined): string {
  let t = valor === null || valor === undefined ? "" : String(valor);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export const reais = (centavos: number) => `${centavos < 0 ? "-" : ""}${Math.floor(Math.abs(centavos) / 100)},${String(Math.abs(centavos) % 100).padStart(2, "0")}`;
const dataBr = (d: string | null) => (d ? d.split("-").reverse().join("/") : "");

export const CABECALHO_CSV = [
  "Tipo", "Categoria", "Descrição", "Cliente", "Processo", "Competência", "Parcela", "Vencimento",
  "Valor (R$)", "Pago (R$)", "Saldo (R$)", "Data do pagamento", "Forma de pagamento", "Situação",
];

export function gerarCsv(linhas: LinhaParcela[], hoje: string): string {
  const corpo = linhas.map((l) => {
    const saldo = l.status === "paga" || l.status === "cancelada" ? 0 : l.valor_centavos - l.valor_pago_centavos;
    return [
      TIPOS[l.tipo], CATEGORIAS[l.categoria as keyof typeof CATEGORIAS] ?? l.categoria, l.descricao, l.cliente_nome ?? "", l.numero_cnj ?? "",
      dataBr(l.data_competencia), `${l.numero}/${l.total_parcelas}`, dataBr(l.vencimento),
      reais(l.valor_centavos), reais(l.valor_pago_centavos), reais(saldo), dataBr(l.data_pagamento),
      l.forma_pagamento ? FORMAS[l.forma_pagamento as keyof typeof FORMAS] ?? l.forma_pagamento : "",
      STATUS_PARCELA[situacaoParcela(l.status, l.vencimento, hoje)],
    ].map(celula).join(";");
  });
  // BOM no começo: sem ele o Excel abre os acentos errados.
  return "﻿" + [CABECALHO_CSV.map(celula).join(";"), ...corpo].join("\r\n") + "\r\n";
}
