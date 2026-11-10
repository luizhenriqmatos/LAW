import { formatarCnj } from "@/lib/integrations/fontes/cnj";
import { formatarDocumento } from "@/lib/validacao";

/**
 * Minuta a partir de MODELO cadastrado pelo escritório. A IA não escreve o contrato: ela só escolhe o modelo e
 * sugere valores para os campos. O texto é montado aqui, trocando {{campo}} pelo valor. Campo sem valor vira
 * "[PREENCHER: campo]" e aparece como aviso.
 *
 * Campos automáticos (vêm do cadastro, no servidor do LAW; o CPF/CNPJ NÃO vai para a IA):
 */
export const CAMPOS_AUTOMATICOS = {
  escritorio_nome: "Nome do escritório",
  data_hoje: "Data de hoje por extenso",
  cliente_nome: "Nome do cliente",
  cliente_documento: "CPF ou CNPJ do cliente",
  cliente_email: "E-mail do cliente",
  cliente_telefone: "Telefone do cliente",
  processo_numero: "Número do processo",
  processo_tribunal: "Tribunal",
  processo_classe: "Classe do processo",
  processo_vara: "Vara / órgão julgador",
} as const;
export type CampoAutomatico = keyof typeof CAMPOS_AUTOMATICOS;

const CAMPO = /\{\{\s*([a-z0-9_]{1,40})\s*\}\}/g;
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export function camposDoModelo(texto: string): string[] {
  const vistos = new Set<string>();
  for (const m of texto.matchAll(CAMPO)) vistos.add(m[1]);
  return [...vistos];
}

/** Campos que a pessoa (ou a IA, como sugestão) precisa preencher: os do modelo que não são automáticos. */
export const camposManuais = (texto: string) => camposDoModelo(texto).filter((c) => !(c in CAMPOS_AUTOMATICOS));

export function dataPorExtenso(iso: string): string {
  const [a, m, d] = iso.split("-").map(Number);
  return `${d} de ${MESES[m - 1]} de ${a}`;
}

export type DadosCadastro = Partial<Record<CampoAutomatico, string | null>>;

export function valoresAutomaticos(bruto: Record<string, unknown>, hoje: string): DadosCadastro {
  const txt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const doc = txt(bruto.cliente_documento);
  const num = txt(bruto.processo_numero);
  return {
    escritorio_nome: txt(bruto.escritorio_nome),
    data_hoje: dataPorExtenso(hoje),
    cliente_nome: txt(bruto.cliente_nome),
    cliente_documento: doc ? formatarDocumento(doc) : null,
    cliente_email: txt(bruto.cliente_email),
    cliente_telefone: txt(bruto.cliente_telefone),
    processo_numero: num && /^\d{20}$/.test(num.replace(/\D/g, "")) ? formatarCnj(num.replace(/\D/g, "")) : num,
    processo_tribunal: txt(bruto.processo_tribunal),
    processo_classe: txt(bruto.processo_classe),
    processo_vara: txt(bruto.processo_vara),
  };
}

export type Montagem = { texto: string; faltando: string[] };

/** Troca cada {{campo}}. Valor manual nunca sobrescreve campo automático (o cadastro é a fonte). */
export function montarMinuta(modelo: string, automaticos: DadosCadastro, manuais: Record<string, string>): Montagem {
  const faltando = new Set<string>();
  const texto = modelo.replace(CAMPO, (_, campo: string) => {
    const auto = campo in CAMPOS_AUTOMATICOS ? automaticos[campo as CampoAutomatico] : undefined;
    const valor = campo in CAMPOS_AUTOMATICOS ? auto : manuais[campo]?.trim();
    if (valor) return valor;
    faltando.add(campo);
    return `[PREENCHER: ${campo}]`;
  });
  return { texto, faltando: [...faltando] };
}
