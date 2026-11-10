/**
 * Movimentação do tribunal em linguagem simples.
 * Dicionário FIXO e revisável (nada de IA aqui): cada frase só descreve o que aconteceu, sem opinião e sem prever resultado.
 * PENDENCIA P-057: advogado revisar as frases e ampliar a lista com os movimentos mais comuns da TPU do CNJ.
 * O que não está na lista aparece com o nome oficial do tribunal, sem tradução.
 */
export type Movimento = { data_hora: string; codigo: string | null; nome: string };

const REGRAS: [RegExp, string][] = [
  [/transito em julgado/, "A decisão não pode mais ser contestada por recurso (trânsito em julgado)."],
  [/sentenca/, "O juiz proferiu a sentença, que é a decisão sobre o caso nesta etapa. Fale com seu advogado para entender o conteúdo e os próximos passos."],
  [/conclus/, "O processo foi enviado ao juiz, que vai analisá-lo."],
  [/homologa/, "O juiz confirmou oficialmente um acordo, um cálculo ou um ato do processo."],
  [/decisao|decisorio|liminar|tutela/, "O juiz tomou uma decisão no processo. Fale com seu advogado para entender o que ela significa."],
  [/despacho/, "O juiz deu uma ordem sobre o andamento do processo."],
  [/audiencia.*(designad|marcad|agendad)|(designad|marcad|agendad).*audiencia/, "Foi marcada uma audiência."],
  [/audiencia.*(realizad|ocorrid)|(realizad|ocorrid).*audiencia/, "A audiência aconteceu."],
  [/audiencia/, "Houve um registro sobre uma audiência no processo."],
  [/citacao/, "A outra parte foi comunicada oficialmente sobre o processo (citação)."],
  [/intimacao/, "Alguém envolvido no processo foi avisado oficialmente de algo (intimação)."],
  [/mandado/, "A Justiça emitiu uma ordem para ser cumprida por um oficial de justiça."],
  [/alvara|pagamento|levantamento/, "Houve um registro sobre pagamento ou liberação de valores no processo. Seu advogado pode explicar os detalhes."],
  [/acordo/, "Houve um registro sobre um acordo no processo."],
  [/pericia|perito|laudo/, "Houve um registro sobre o exame técnico (perícia) do processo."],
  [/recurso|apelacao|agravo|embargos/, "Houve um registro sobre um recurso, que é um pedido para a Justiça rever uma decisão."],
  [/suspens|sobrest/, "O andamento do processo foi suspenso por um tempo."],
  [/arquiv|baixa definitiva/, "O processo foi arquivado. Fale com seu advogado se tiver dúvida sobre o que isso significa."],
  [/vista/, "O processo foi enviado para uma das partes ou para o Ministério Público se manifestar."],
  [/juntada|juntad/, "Um documento ou uma petição foi juntado ao processo."],
  [/peticao/, "Foi apresentado um pedido ou uma manifestação no processo."],
  [/cumprimento/, "Uma ordem da Justiça foi cumprida."],
  [/ato ordinatorio/, "A secretaria praticou um ato de rotina para dar andamento ao processo."],
  [/expedic/, "A Justiça emitiu um documento ou uma comunicação."],
  [/publicac|disponibiliza/, "Uma informação do processo foi publicada no diário oficial."],
  [/distribui/, "O processo foi registrado e encaminhado ao setor responsável."],
  [/autua|protocol|recebimento da inicial/, "O processo foi cadastrado no sistema da Justiça."],
  [/remessa|remetid|encaminhad/, "O processo foi enviado a outro setor ou órgão da Justiça."],
  [/recebid|recebimento/, "O processo foi recebido por um setor ou órgão da Justiça."],
];

const semAcento = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export type Traducao = { texto: string; traduzido: boolean; oficial: string };

export function traduzirMovimentacao(nome: string): Traducao {
  const limpo = nome.replace(/\s+/g, " ").trim();
  const chave = semAcento(limpo);
  for (const [regra, texto] of REGRAS) {
    if (regra.test(chave)) return { texto, traduzido: true, oficial: limpo };
  }
  return { texto: limpo, traduzido: false, oficial: limpo };
}

const FORMATO_DATA = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });
const FORMATO_DATA_HORA = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});

/** "dd/mm/aaaa" no horário de Brasília. Aceita data ISO com ou sem hora; texto que não é data volta como veio. */
export function dataBR(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : FORMATO_DATA.format(d);
}

export function dataHoraBR(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : FORMATO_DATA_HORA.format(d).replace(", ", " às ");
}

export type SituacaoAtual = { texto: string; origem: "advogado" | "movimentacao" | "vazia"; data: string | null };

/** "Situação atual": o texto que o advogado escreveu; sem ele, a última movimentação traduzida. */
export function situacaoAtual(situacaoTexto: string | null | undefined, ultima: Movimento | null | undefined): SituacaoAtual {
  if (situacaoTexto?.trim()) return { texto: situacaoTexto.trim(), origem: "advogado", data: null };
  if (ultima) return { texto: traduzirMovimentacao(ultima.nome).texto, origem: "movimentacao", data: ultima.data_hora };
  return { texto: "Ainda não há andamentos para mostrar aqui.", origem: "vazia", data: null };
}

const TIPOS_COMPROMISSO: Record<string, string> = { audiencia: "Audiência", reuniao: "Reunião", outro: "Compromisso" };
export const rotuloCompromisso = (tipo: string) => TIPOS_COMPROMISSO[tipo] ?? "Compromisso";

export function tamanhoLegivel(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}
