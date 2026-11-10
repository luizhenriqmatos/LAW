import { createHash } from "node:crypto";
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { formatarCpf } from "./cpf";

export const LIMITE_PDF_BYTES = 4 * 1024 * 1024;
export const LIMITE_PAGINAS = 300;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type ValidacaoPdf = { ok: true; paginas: number } | { ok: false; motivo: "vazio" | "grande" | "nao_pdf" | "protegido" | "paginas" };

/** Confere que é um PDF legível, sem senha, para o manifesto poder ser anexado no fim. */
export async function validarPdf(bytes: Uint8Array): Promise<ValidacaoPdf> {
  if (bytes.byteLength === 0) return { ok: false, motivo: "vazio" };
  if (bytes.byteLength > LIMITE_PDF_BYTES) return { ok: false, motivo: "grande" };
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") return { ok: false, motivo: "nao_pdf" };
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
    if (doc.getPageCount() > LIMITE_PAGINAS) return { ok: false, motivo: "paginas" };
    return { ok: true, paginas: doc.getPageCount() };
  } catch (e) {
    return { ok: false, motivo: e instanceof Error && /encrypt/i.test(e.message) ? "protegido" : "nao_pdf" };
  }
}

export type DadosManifesto = {
  titulo: string;
  nomeArquivo: string;
  escritorio: string;
  envelopeId: string;
  hashOriginal: string;
  criadoEm: string;
  signatarios: { ordem: number; nome: string; email: string; cpf: string; assinadoEm: string; ip: string | null; userAgent: string | null }[];
};

export function dataHoraBrasilia(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Bahia", dateStyle: "short", timeStyle: "medium" }) + " (Brasília)";
}

/** Fonte padrão do PDF só desenha Latin-1: o resto vira "?" (o nome completo continua no banco). */
function seguro(fonte: PDFFont, texto: string): string {
  let saida = "";
  for (const c of texto.replace(/[\r\n\t]+/g, " ")) {
    try {
      fonte.widthOfTextAtSize(c, 10);
      saida += c;
    } catch {
      saida += "?";
    }
  }
  return saida;
}

function quebrar(fonte: PDFFont, texto: string, tamanho: number, largura: number): string[] {
  const linhas: string[] = [];
  let atual = "";
  for (const palavra of seguro(fonte, texto).split(" ")) {
    // Palavra maior que a linha (hash, user-agent) é cortada em pedaços.
    let resto = palavra;
    while (fonte.widthOfTextAtSize(resto, tamanho) > largura) {
      let corte = resto.length;
      while (corte > 1 && fonte.widthOfTextAtSize(resto.slice(0, corte), tamanho) > largura) corte--;
      if (atual) { linhas.push(atual); atual = ""; }
      linhas.push(resto.slice(0, corte));
      resto = resto.slice(corte);
    }
    const tentativa = atual ? `${atual} ${resto}` : resto;
    if (fonte.widthOfTextAtSize(tentativa, tamanho) <= largura) atual = tentativa;
    else { linhas.push(atual); atual = resto; }
  }
  if (atual) linhas.push(atual);
  return linhas;
}

/**
 * PDF final = o PDF original + páginas de manifesto (nome, e-mail, CPF informado, data/hora, IP, navegador, hash do original).
 * O hash do próprio PDF final não pode estar dentro dele: fica registrado no banco e aparece na tela e na verificação.
 */
export async function montarPdfFinal(original: Uint8Array, m: DadosManifesto): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const LARGURA = 595.28, ALTURA = 841.89, MARGEM = 48, UTIL = LARGURA - 2 * MARGEM;
  let pagina: PDFPage = doc.addPage([LARGURA, ALTURA]);
  let y = ALTURA - MARGEM;

  const nova = () => { pagina = doc.addPage([LARGURA, ALTURA]); y = ALTURA - MARGEM; };
  const linha = (texto: string, o: { fonte?: PDFFont; tamanho?: number; cor?: [number, number, number]; recuo?: number; depois?: number } = {}) => {
    const fonte = o.fonte ?? normal, tamanho = o.tamanho ?? 10, recuo = o.recuo ?? 0;
    for (const l of quebrar(fonte, texto, tamanho, UTIL - recuo)) {
      if (y < MARGEM + tamanho) nova();
      pagina.drawText(l, { x: MARGEM + recuo, y: y - tamanho, size: tamanho, font: fonte, color: rgb(...(o.cor ?? [0.1, 0.1, 0.1])) });
      y -= tamanho * 1.45;
    }
    y -= o.depois ?? 0;
  };

  linha("Manifesto de assinaturas eletrônicas", { fonte: negrito, tamanho: 17, depois: 4 });
  linha("Assinatura eletrônica AVANÇADA (Lei 14.063/2020, art. 4º, II). Não é assinatura qualificada com certificado ICP-Brasil (art. 4º, III).", { tamanho: 9, cor: [0.35, 0.35, 0.35], depois: 10 });

  linha("Documento", { fonte: negrito, tamanho: 11, depois: 2 });
  linha(`Título: ${m.titulo}`);
  linha(`Arquivo original: ${m.nomeArquivo}`);
  linha(`Escritório: ${m.escritorio}`);
  linha(`Envelope: ${m.envelopeId}`);
  linha(`Criado em: ${dataHoraBrasilia(m.criadoEm)}`);
  linha("Hash SHA-256 do documento original:", { depois: 0 });
  linha(m.hashOriginal, { fonte: mono, tamanho: 9, depois: 12 });

  linha(`Signatários (${m.signatarios.length})`, { fonte: negrito, tamanho: 11, depois: 4 });
  for (const s of m.signatarios) {
    if (y < 190) nova();
    linha(seguro(negrito, s.nome), { fonte: negrito, tamanho: 11 });
    linha(`E-mail: ${s.email}`, { recuo: 12 });
    linha(`CPF informado: ${formatarCpf(s.cpf)}`, { recuo: 12 });
    linha(`Data e hora da assinatura: ${dataHoraBrasilia(s.assinadoEm)}  |  UTC ${new Date(s.assinadoEm).toISOString()}`, { recuo: 12 });
    linha(`Endereço IP: ${s.ip ?? "não registrado"}`, { recuo: 12 });
    linha(`Navegador: ${s.userAgent ?? "não registrado"}`, { recuo: 12 });
    linha("Aceite: leu o documento e concordou, por assinatura eletrônica avançada.", { recuo: 12, depois: 8 });
  }

  linha("Como verificar", { fonte: negrito, tamanho: 11, depois: 2 });
  linha("O hash SHA-256 deste PDF final fica registrado no sistema, junto com as evidências de cada etapa (envio, abertura, visualização, aceite e assinatura). Para conferir, envie este arquivo na página de verificação do LAW: qualquer alteração, mesmo de 1 byte, faz a verificação falhar.", { tamanho: 9 });

  doc.setTitle(`${m.titulo} (assinado eletronicamente)`);
  doc.setProducer("LAW (pdf-lib)");
  return await doc.save();
}
