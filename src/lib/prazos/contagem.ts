/**
 * Contagem de prazos processuais. MÓDULO PURO: sem banco, sem relógio, sem rede.
 * Datas são texto AAAA-MM-DD (calendário de Brasília). O resultado é sempre SUGERIDO:
 * quem confirma é o advogado, que confere no sistema oficial do tribunal.
 *
 * Regras (CPC):
 *  - Publicação = primeiro dia útil seguinte à disponibilização (art. 224, § 2º e § 3º; Lei 11.419/2006, art. 4º, § 3º).
 *  - O prazo começa no primeiro dia útil seguinte à publicação; esse dia é o dia 1 (art. 224, caput e § 3º).
 *  - Dias úteis por padrão (art. 219). Corridos só se o usuário escolher.
 *  - Suspensão de 20/12 a 20/01, inclusive (art. 220): vale para prazos úteis e corridos.
 *  - Vencimento em dia não útil prorroga para o próximo dia útil (art. 224, § 1º).
 */
import { somarDias } from "@/lib/integrations/fontes/datas";

export const AVISO_PRAZO = "Prazo sugerido. Confira no sistema oficial do tribunal.";

export type TipoContagem = "util" | "corrido";
export type Escopo = "nacional" | "estadual" | "municipal" | "tribunal";

/** Linha do calendário forense. `dataFim` preenchida = suspensão que cobre o intervalo inclusive. */
export type EntradaCalendario = {
  data: string;
  dataFim?: string | null;
  escopo: Escopo;
  tribunal?: string | null;
  uf?: string | null;
  tipo: "feriado" | "suspensao";
  descricao: string;
};

export type MotivoPulo = "fim_de_semana" | "feriado" | "suspensao" | "recesso";
export type DiaPulado = { data: string; motivo: MotivoPulo; descricao: string };

export type PassoRaciocinio = { rotulo: string; data: string | null; explicacao: string };

export type ResultadoPrazo = {
  disponibilizacao: string;
  publicacao: string;
  inicioContagem: string;
  dataFinal: string;
  /** Vencimento antes de prorrogar (igual a dataFinal se não prorrogou). */
  vencimentoBruto: string;
  prorrogado: boolean;
  dias: number;
  tipo: TipoContagem;
  diasPulados: DiaPulado[];
  passos: PassoRaciocinio[];
  aviso: typeof AVISO_PRAZO;
};

export class ErroContagem extends Error {}

const DATA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIAS = 365;
const LIMITE_BUSCA = 800; // trava contra calendário com intervalo absurdo

export function diaDaSemana(iso: string): number {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
}

const NOMES_SEMANA = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
export const nomeDoDia = (iso: string) => NOMES_SEMANA[diaDaSemana(iso)];

/** Recesso forense: 20/12 a 20/01 (CPC, art. 220). */
export function emRecesso(iso: string): boolean {
  const md = iso.slice(5);
  return md >= "12-20" || md <= "01-20";
}

/** UF do tribunal a partir da sigla (TJBA → BA; TRT5 → BA). Sem UF conhecida, só vale o que é nacional ou do tribunal. */
export function ufDoTribunal(sigla: string | null | undefined): string | null {
  const s = (sigla ?? "").toUpperCase();
  const tj = /^TJ([A-Z]{2})$/.exec(s);
  if (tj) return tj[1];
  const TRT_UF: Record<string, string> = { "5": "BA" }; // PENDENCIA P-007: demais TRTs/TRFs entram com o calendário deles
  const trt = /^TRT(\d+)$/.exec(s);
  return trt ? TRT_UF[trt[1]] ?? null : null;
}

/** Entradas do calendário que valem para um processo daquele tribunal. */
export function entradasDoTribunal(todas: EntradaCalendario[], tribunal: string | null | undefined): EntradaCalendario[] {
  const sigla = (tribunal ?? "").toUpperCase();
  const uf = ufDoTribunal(sigla);
  return todas.filter((e) => {
    switch (e.escopo) {
      case "nacional":
        return true;
      case "estadual":
        return !!uf && (e.uf ?? "").toUpperCase() === uf;
      case "tribunal":
      case "municipal": // municipal é cadastrado para um tribunal (comarca) e vale para ele
        return !!sigla && (e.tribunal ?? "").toUpperCase() === sigla;
    }
  });
}

/** Motivo de o dia NÃO ser útil, ou null se for útil. */
export function motivoNaoUtil(iso: string, calendario: EntradaCalendario[]): DiaPulado | null {
  const dow = diaDaSemana(iso);
  if (dow === 0 || dow === 6) return { data: iso, motivo: "fim_de_semana", descricao: nomeDoDia(iso) };
  if (emRecesso(iso)) return { data: iso, motivo: "recesso", descricao: "Recesso forense (20/12 a 20/01, CPC art. 220)" };
  for (const e of calendario) {
    const fim = e.dataFim && e.dataFim >= e.data ? e.dataFim : e.data;
    if (iso >= e.data && iso <= fim) {
      return { data: iso, motivo: e.tipo === "suspensao" ? "suspensao" : "feriado", descricao: e.descricao };
    }
  }
  return null;
}

export const ehDiaUtil = (iso: string, calendario: EntradaCalendario[]) => motivoNaoUtil(iso, calendario) === null;

/** Primeiro dia útil estritamente depois de `iso`; registra os dias pulados no caminho. */
function proximoDiaUtil(iso: string, calendario: EntradaCalendario[], pulados: DiaPulado[]): string {
  let d = somarDias(iso, 1);
  for (let i = 0; i < LIMITE_BUSCA; i++, d = somarDias(d, 1)) {
    const m = motivoNaoUtil(d, calendario);
    if (!m) return d;
    pulados.push(m);
  }
  throw new ErroContagem("Calendário sem dia útil nos próximos 800 dias. Confira as suspensões cadastradas.");
}

export type EntradaPrazo = {
  disponibilizacao: string;
  /** A data informada já é a da intimação (ex.: art. 523): não há o passo "publicação = dia útil seguinte". */
  intimado?: boolean;
  dias: number;
  tipo?: TipoContagem;
  calendario: EntradaCalendario[];
};

function validar(e: EntradaPrazo) {
  if (!DATA.test(e.disponibilizacao) || Number.isNaN(Date.parse(e.disponibilizacao))) {
    throw new ErroContagem("Data de disponibilização inválida.");
  }
  if (!Number.isInteger(e.dias) || e.dias < 1 || e.dias > MAX_DIAS) {
    throw new ErroContagem(`A quantidade de dias deve ser um número inteiro de 1 a ${MAX_DIAS}.`);
  }
}

const br = (iso: string) => iso.split("-").reverse().join("/");
const comSemana = (iso: string) => `${nomeDoDia(iso)}, ${br(iso)}`;

function resumirPulos(pulados: DiaPulado[]): string {
  if (!pulados.length) return "nenhum";
  return pulados.map((p) => `${br(p.data)} (${p.descricao})`).join("; ");
}

export function calcularPrazo(entrada: EntradaPrazo): ResultadoPrazo {
  validar(entrada);
  const tipo: TipoContagem = entrada.tipo ?? "util";
  const { calendario, dias, disponibilizacao } = entrada;
  const diasPulados: DiaPulado[] = [];

  // 1) Publicação.
  const puladosPublicacao: DiaPulado[] = [];
  const publicacao = entrada.intimado ? disponibilizacao : proximoDiaUtil(disponibilizacao, calendario, puladosPublicacao);
  diasPulados.push(...puladosPublicacao);

  // 2) Início da contagem (dia 1).
  const puladosInicio: DiaPulado[] = [];
  const inicioContagem = proximoDiaUtil(publicacao, calendario, puladosInicio);
  diasPulados.push(...puladosInicio);

  // 3) Contagem. Úteis: só dias úteis. Corridos: todos os dias, menos o recesso (art. 220).
  const puladosContagem: DiaPulado[] = [];
  let restantes = dias - 1; // o dia de início já é o dia 1
  let atual = inicioContagem;
  for (let i = 0; restantes > 0; i++) {
    if (i > LIMITE_BUSCA * 2) throw new ErroContagem("Não foi possível fechar a contagem. Confira o calendário.");
    atual = somarDias(atual, 1);
    const m = motivoNaoUtil(atual, calendario);
    if (tipo === "util") {
      if (m) {
        puladosContagem.push(m);
        continue;
      }
    } else if (emRecesso(atual)) {
      // Corridos: só o recesso suspende. Checa direto, pois sábado/domingo dentro do recesso também não contam.
      puladosContagem.push({ data: atual, motivo: "recesso", descricao: "Recesso forense (20/12 a 20/01, CPC art. 220)" });
      continue;
    }
    restantes--;
  }
  const vencimentoBruto = atual;
  diasPulados.push(...puladosContagem);

  // 4) Prorrogação: vencimento em dia não útil vai para o próximo dia útil (art. 224, § 1º).
  let dataFinal = vencimentoBruto;
  const puladosProrrogacao: DiaPulado[] = [];
  const bruto = motivoNaoUtil(vencimentoBruto, calendario);
  if (bruto) {
    puladosProrrogacao.push(bruto);
    dataFinal = proximoDiaUtil(vencimentoBruto, calendario, puladosProrrogacao);
    diasPulados.push(...puladosProrrogacao);
  }
  const prorrogado = dataFinal !== vencimentoBruto;

  // Dias pulados sem repetição, em ordem.
  const vistos = new Set<string>();
  const unicos = diasPulados.filter((p) => (vistos.has(p.data) ? false : (vistos.add(p.data), true))).sort((a, b) => a.data.localeCompare(b.data));

  const passos: PassoRaciocinio[] = entrada.intimado
    ? [{ rotulo: "Intimação", data: disponibilizacao, explicacao: `Intimação em ${comSemana(disponibilizacao)}.` }]
    : [
    { rotulo: "Disponibilização", data: disponibilizacao, explicacao: `O tribunal disponibilizou a comunicação em ${comSemana(disponibilizacao)}.` },
    {
      rotulo: "Publicação",
      data: publicacao,
      explicacao: `Considera-se publicada no primeiro dia útil seguinte à disponibilização: ${comSemana(publicacao)}.${puladosPublicacao.length ? ` Dias pulados: ${resumirPulos(puladosPublicacao)}.` : ""}`,
    },
    {
      rotulo: "Início da contagem",
      data: inicioContagem,
      explicacao: `O prazo começa no primeiro dia útil seguinte à ${entrada.intimado ? "intimação" : "publicação"}: ${comSemana(inicioContagem)} (dia 1).${puladosInicio.length ? ` Dias pulados: ${resumirPulos(puladosInicio)}.` : ""}`,
    },
    {
      rotulo: "Contagem",
      data: vencimentoBruto,
      explicacao:
        tipo === "util"
          ? `${dias} dia(s) útil(eis) (CPC, art. 219), excluindo fins de semana, feriados e suspensões. Dias pulados na contagem: ${resumirPulos(puladosContagem)}.`
          : `${dias} dia(s) corrido(s), excluindo apenas o recesso de 20/12 a 20/01 (CPC, art. 220). Dias pulados na contagem: ${resumirPulos(puladosContagem)}.`,
    },
  ];
  if (prorrogado) {
    passos.push({
      rotulo: "Prorrogação",
      data: dataFinal,
      explicacao: `O vencimento caiu em ${comSemana(vencimentoBruto)} (${bruto!.descricao}); prorroga para o próximo dia útil (CPC, art. 224, § 1º): ${comSemana(dataFinal)}.`,
    });
  }
  passos.push({ rotulo: "Data final sugerida", data: dataFinal, explicacao: `${comSemana(dataFinal)}. ${AVISO_PRAZO}` });

  return { disponibilizacao, publicacao, inicioContagem, dataFinal, vencimentoBruto, prorrogado, dias, tipo, diasPulados: unicos, passos, aviso: AVISO_PRAZO };
}

/**
 * Sugere a quantidade de dias a partir do texto da publicação ("prazo de 15 dias", "no prazo de 5 (cinco) dias úteis").
 * É só uma sugestão: o advogado confirma. Sem número claro, devolve null.
 */
export function sugerirDiasDoTexto(texto: string): { dias: number; tipo: TipoContagem | null; trecho: string } | null {
  const re = /prazo\s+(?:legal\s+|comum\s+|sucessivo\s+)?(?:de|em)\s+(\d{1,3})\s*(?:\([^)]{1,40}\)\s*)?dias?(?:\s+(úteis|uteis|corridos))?/i;
  const m = re.exec(texto);
  if (!m) return null;
  const dias = Number(m[1]);
  if (dias < 1 || dias > MAX_DIAS) return null;
  const marca = (m[2] ?? "").toLowerCase();
  return { dias, tipo: marca.startsWith("ú") || marca === "uteis" ? "util" : marca === "corridos" ? "corrido" : null, trecho: m[0] };
}
