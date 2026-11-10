import { strToU8, zipSync } from "fflate";

type Linha = Record<string, unknown>;

/** Valor de célula CSV. Texto que começaria com = + - @ ganha um apóstrofo (evita fórmula ao abrir no Excel). */
function celula(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV com BOM (Excel abre com acento certo). Colunas = união das chaves, na ordem em que aparecem. */
export function paraCsv(linhas: Linha[]): string {
  const colunas: string[] = [];
  for (const l of linhas) for (const k of Object.keys(l)) if (!colunas.includes(k)) colunas.push(k);
  if (colunas.length === 0) return "﻿";
  return "﻿" + [colunas.join(","), ...linhas.map((l) => colunas.map((c) => celula(l[c])).join(","))].join("\r\n") + "\r\n";
}

const nomeSeguro = (s: string) => s.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/\.{2,}/g, "_").replace(/^\./, "_").slice(0, 80) || "arquivo";

export type ArquivoAssinado = { envelopeId: string; titulo: string; nomeArquivo: string; original: Uint8Array; final: Uint8Array | null };

export function montarZip(p: {
  escritorio: string;
  geradoEm: Date;
  tabelas: Record<string, Linha[]>;
  assinaturas: Record<string, Linha[]>;
  arquivos: ArquivoAssinado[];
}): Uint8Array {
  const f: Record<string, Uint8Array> = {};
  const resumo: string[] = [];
  for (const [nome, linhas] of Object.entries({ ...p.tabelas, ...p.assinaturas })) {
    f[`tabelas/${nome}.csv`] = strToU8(paraCsv(linhas));
    resumo.push(`  ${nome}: ${linhas.length} linha(s)`);
  }
  for (const a of p.arquivos) {
    const base = `${a.envelopeId.slice(0, 8)}-${nomeSeguro(a.titulo)}`;
    f[`documentos-assinados/${base}/original-${nomeSeguro(a.nomeArquivo)}`] = a.original;
    if (a.final) f[`documentos-assinados/${base}/assinado-${nomeSeguro(a.nomeArquivo)}`] = a.final;
  }
  f["LEIA-ME.txt"] = strToU8([
    `Exportação do LAW — ${p.escritorio}`,
    `Gerada em ${p.geradoEm.toISOString()}`,
    "",
    "tabelas/                planilhas CSV (UTF-8) de todos os dados do escritório, uma por tabela.",
    "documentos-assinados/   PDF original e PDF final (com manifesto) de cada documento assinado.",
    "",
    "Não entram: senhas, chaves e tokens de integração (por segurança) e os arquivos que estão no seu Google Drive",
    "(esses continuam no seu Drive; as colunas de endereço/ID deles estão nas tabelas drive_*).",
    "",
    "Linhas por tabela:",
    ...resumo,
    "",
  ].join("\n"));
  return zipSync(f, { level: 6 });
}
