/**
 * Nomes de pasta no Drive. Regras:
 *  - cliente: "<Nome do cliente>"  (dentro de LAW/Clientes)
 *  - processo: "<número CNJ> - <classe>"  (dentro da pasta do cliente principal)
 * Limpa só o que atrapalha (barras, controle, espaços repetidos); acentos e maiúsculas ficam como o escritório escreveu.
 */
export const RAIZ = "LAW";
export const CLIENTES = "Clientes";

export function limparNome(texto: string | null | undefined, reserva: string, max = 120): string {
  const limpo = (texto ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "") // nome começando com ponto vira arquivo oculto em alguns sistemas
    .trim()
    .slice(0, max)
    .trim();
  return limpo || reserva;
}

export const nomePastaCliente = (nome: string | null | undefined) => limparNome(nome, "Cliente sem nome");

/** 20 dígitos viram o formato que o advogado reconhece: NNNNNNN-DD.AAAA.J.TR.OOOO. Outro formato fica como veio. */
export function cnjFormatado(numero: string | null | undefined): string {
  const d = (numero ?? "").trim();
  return /^\d{20}$/.test(d) ? `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d[13]}.${d.slice(14, 16)}.${d.slice(16)}` : d;
}

export function nomePastaProcesso(numeroCnj: string | null | undefined, classe: string | null | undefined): string {
  const partes = [cnjFormatado(numeroCnj), classe].map((p) => (p ?? "").trim()).filter(Boolean);
  return limparNome(partes.join(" - "), "Processo sem número");
}

/** Marca gravada na pasta (propriedade do app no Drive) para reencontrá-la sem duplicar. */
export const marcaDaPasta = (escritorioId: string, tipo: "cliente" | "processo", refId: string) => `${escritorioId}:${tipo}:${refId}`;
export const marcaRaiz = (escritorioId: string, nome: "raiz" | "clientes") => `${escritorioId}:${nome}`;

/** Nome de arquivo enviado: tira caminho/barras, limita o tamanho, mantém a extensão. */
export function nomeDeArquivo(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? "";
  const limpo = limparNome(base, "arquivo", 200);
  return limpo;
}
