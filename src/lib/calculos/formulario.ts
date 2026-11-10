/**
 * Formulário dos cálculos: leitura e validação dos campos (servidor) e valores iniciais para editar (tela).
 * MÓDULO PURO. O mesmo conjunto de nomes de campo vale para os três tipos.
 */
import { z } from "zod";
import { paraCentavos } from "@/lib/dinheiro";
import { dataValida, INDICES_CORRECAO, type CodigoIndice } from "./base";
import type { ParametrosArt523, ParametrosAtualizacao, ParametrosHonorarios, TipoCalculo } from "./calculos";
import type { TipoDesligamento } from "./rescisao";
import type { ParametrosTrabalhista } from "./trabalhista";

export type ModoRegimes = "padrao" | "escolher";
export type Valores = {
  titulo: string; processo: string; partes: string;
  valor: string; data_base: string; juros: "vencimento" | "citacao" | "sem_juros"; data_citacao: string; data_final: string;
  data_ajuizamento: string; data_transito: string;
  modo_regimes: ModoRegimes; regimes: string[]; indices: Record<string, string>;
  data_intimacao: string; pagamento_valor: string; pagamento_data: string;
  modalidade: ParametrosHonorarios["modalidade"]; forma: ParametrosHonorarios["forma"]; base_tipo: ParametrosHonorarios["baseTipo"];
  base_valor: string; percentual: string; valor_fixo: string; fazenda_publica: boolean;
  com_rescisao: boolean; admissao: string; saida: string; tipo_desligamento: TipoDesligamento; aviso_indenizado: boolean;
  salario: string; medias: string; ferias_vencidas: string; ferias_dobro: string; saldo_fgts: string;
  verbas: { descricao: string; valor: string; vencimento: string }[];
};

export const VALORES_VAZIOS: Valores = {
  titulo: "", processo: "", partes: "", valor: "", data_base: "", juros: "vencimento", data_citacao: "", data_final: "",
  data_ajuizamento: "", data_transito: "", modo_regimes: "padrao", regimes: [], indices: {},
  data_intimacao: "", pagamento_valor: "", pagamento_data: "",
  modalidade: "sucumbencia", forma: "percentual", base_tipo: "condenacao", base_valor: "", percentual: "10", valor_fixo: "", fazenda_publica: false,
  com_rescisao: true, admissao: "", saida: "", tipo_desligamento: "sem_justa_causa", aviso_indenizado: true,
  salario: "", medias: "", ferias_vencidas: "0", ferias_dobro: "0", saldo_fgts: "", verbas: [],
};

/** Centavos → "1.234,56" (sem "R$"), para preencher campo. */
export function centavosParaCampo(c: number | null | undefined): string {
  if (c === null || c === undefined) return "";
  return `${Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(c % 100).padStart(2, "0")}`;
}

const data = (rotulo: string) => z.string().refine(dataValida, `${rotulo}: data inválida.`);
const dataOpcional = z.string().transform((v) => v.trim()).refine((v) => v === "" || dataValida(v), "Data inválida.").transform((v) => v || null);
const dinheiro = (rotulo: string) => z.string().transform((v, ctx) => {
  const c = paraCentavos(v);
  if (c === null || c <= 0) {
    ctx.addIssue({ code: "custom", message: `${rotulo}: informe um valor maior que zero.` });
    return z.NEVER;
  }
  return c;
});
const indiceOuPadrao = z.union([z.enum([...INDICES_CORRECAO, "nenhuma"] as [string, ...string[]]), z.literal("")]);

const comum = z.object({
  titulo: z.string().trim().min(2, "Dê um título ao cálculo.").max(160, "Título muito longo."),
  processo: z.union([z.uuid(), z.literal("")]).transform((v) => v || null),
  partes: z.string().trim().max(500, "Partes: texto muito longo.").transform((v) => v || null),
});

const atualizacao = z.object({
  valor: dinheiro("Valor"),
  data_base: data("Data-base"),
  juros: z.enum(["vencimento", "citacao", "sem_juros"]),
  data_citacao: dataOpcional,
  data_final: data("Data final"),
  data_ajuizamento: dataOpcional,
  data_transito: dataOpcional,
  modo_regimes: z.enum(["padrao", "escolher"]),
});

export type Lido = {
  titulo: string; processoId: string | null; partes: string | null; modoRegimes: ModoRegimes;
  parametros: ParametrosAtualizacao | ParametrosArt523 | ParametrosHonorarios | ParametrosTrabalhista;
};

const primeiroErro = (e: z.ZodError) => e.issues[0]?.message ?? "Dados inválidos.";

/**
 * Lê o formulário. `regimesPadrao`: ids usados quando o modo é "padrão". `regimesValidos`: ids que o escritório enxerga.
 */
export function lerFormulario(tipo: TipoCalculo, fd: FormData, regimesPadrao: string[], regimesValidos: string[]): Lido | { erro: string } {
  const campo = (k: string) => String(fd.get(k) ?? "");
  const c = comum.safeParse({ titulo: campo("titulo"), processo: campo("processo"), partes: campo("partes") });
  if (!c.success) return { erro: primeiroErro(c.error) };
  const base = { titulo: c.data.titulo, processoId: c.data.processo, partes: c.data.partes };

  if (tipo === "honorarios") {
    const h = z.object({
      modalidade: z.enum(["sucumbencia", "contratuais", "exito"]),
      forma: z.enum(["percentual", "fixo"]),
      base_tipo: z.enum(["condenacao", "proveito_economico", "valor_causa", "valor_recebido", "outro"]),
    }).safeParse({ modalidade: campo("modalidade"), forma: campo("forma") || "percentual", base_tipo: campo("base_tipo") || "outro" });
    if (!h.success) return { erro: primeiroErro(h.error) };
    const fixo = h.data.modalidade === "contratuais" && h.data.forma === "fixo";
    const baseC = fixo ? null : paraCentavos(campo("base_valor"));
    const fixoC = fixo ? paraCentavos(campo("valor_fixo")) : null;
    if (!fixo && (baseC === null || baseC <= 0)) return { erro: "Informe o valor da base de cálculo." };
    if (fixo && (fixoC === null || fixoC <= 0)) return { erro: "Informe o valor fixo dos honorários." };
    const pct = campo("percentual").trim().replace(",", ".");
    if (!fixo && !/^\d{1,3}(\.\d{1,4})?$/.test(pct)) return { erro: "Informe o percentual (ex.: 15 ou 12,5)." };
    return {
      ...base, modoRegimes: "padrao",
      parametros: {
        modalidade: h.data.modalidade, forma: h.data.modalidade === "contratuais" ? h.data.forma : "percentual",
        baseTipo: h.data.modalidade === "exito" ? "valor_recebido" : h.data.base_tipo,
        baseCentavos: baseC, percentual: fixo ? null : pct, valorFixoCentavos: fixoC, fazendaPublica: fd.get("fazenda_publica") === "on",
      } satisfies ParametrosHonorarios,
    };
  }

  if (tipo === "trabalhista") {
    const r = lerTrabalhista(fd, regimesPadrao, regimesValidos);
    return "erro" in r ? r : { ...base, ...r };
  }

  const a = atualizacao.safeParse(Object.fromEntries(["valor", "data_base", "juros", "data_citacao", "data_final", "data_ajuizamento", "data_transito", "modo_regimes"].map((k) => [k, campo(k)])));
  if (!a.success) return { erro: primeiroErro(a.error) };
  if (a.data.juros === "citacao" && !a.data.data_citacao) return { erro: "Informe a data da citação (início dos juros)." };
  if (a.data.data_final < a.data.data_base) return { erro: "A data final não pode ser anterior à data-base." };

  const regimeIds = a.data.modo_regimes === "padrao" ? regimesPadrao : fd.getAll("regimes").map(String).filter((id) => regimesValidos.includes(id));
  if (!regimeIds.length) return { erro: "Escolha ao menos um regime." };
  const indicesSubstitutos: Record<string, CodigoIndice | "nenhuma"> = {};
  for (const id of regimeIds) {
    const v = indiceOuPadrao.safeParse(campo(`indice__${id}`));
    if (v.success && v.data) indicesSubstitutos[id] = v.data as CodigoIndice | "nenhuma";
  }
  const p: ParametrosAtualizacao = {
    valorCentavos: a.data.valor, dataBase: a.data.data_base, juros: a.data.juros,
    dataCitacao: a.data.data_citacao, dataFinal: a.data.data_final,
    regimeIds, indicesSubstitutos, dataAjuizamento: a.data.data_ajuizamento, dataTransito: a.data.data_transito,
  };
  if (tipo === "atualizacao") return { ...base, modoRegimes: a.data.modo_regimes, parametros: p };

  const intimacao = campo("data_intimacao");
  if (!dataValida(intimacao)) return { erro: "Informe a data da intimação para pagamento." };
  const pv = campo("pagamento_valor").trim(), pd = campo("pagamento_data").trim();
  let pagamento: ParametrosArt523["pagamento"] = null;
  if (pv || pd) {
    const valorPago = paraCentavos(pv);
    if (valorPago === null || valorPago <= 0) return { erro: "Pagamento parcial: informe o valor pago." };
    if (!dataValida(pd)) return { erro: "Pagamento parcial: informe a data do pagamento." };
    pagamento = { valorCentavos: valorPago, data: pd };
  }
  return { ...base, modoRegimes: a.data.modo_regimes, parametros: { ...p, dataIntimacao: intimacao, pagamento } satisfies ParametrosArt523 };
}

/** Parâmetros salvos → valores do formulário (para editar). */
export function valoresDe(c: { titulo: string; processo_id: string | null; partes: string | null; parametros: Record<string, unknown>; regimes: string[] }): Valores {
  const p = c.parametros as Partial<ParametrosArt523 & ParametrosHonorarios & { modoRegimes: ModoRegimes }> & Partial<Pick<ParametrosTrabalhista, "rescisao" | "verbas">>;
  const r = p.rescisao;
  const trab = {
    com_rescisao: p.rescisao !== undefined ? !!r : true,
    admissao: r?.admissao ?? "", saida: r?.saida ?? "", tipo_desligamento: r?.tipo ?? "sem_justa_causa", aviso_indenizado: r?.avisoIndenizado ?? true,
    salario: centavosParaCampo(r?.salarioCentavos), medias: r?.mediasCentavos ? centavosParaCampo(r.mediasCentavos) : "",
    ferias_vencidas: String(r?.feriasVencidas ?? 0), ferias_dobro: String(r?.feriasVencidasEmDobro ?? 0),
    saldo_fgts: r?.saldoFgtsCentavos === null || r?.saldoFgtsCentavos === undefined ? "" : centavosParaCampo(r.saldoFgtsCentavos),
    verbas: (p.verbas ?? []).map((v) => ({ descricao: v.descricao, valor: centavosParaCampo(v.valorCentavos), vencimento: v.vencimento })),
  } satisfies Partial<Valores>;
  return {
    ...VALORES_VAZIOS,
    ...trab,
    titulo: c.titulo, processo: c.processo_id ?? "", partes: c.partes ?? "",
    valor: centavosParaCampo(p.valorCentavos), data_base: p.dataBase ?? "", juros: p.juros ?? "vencimento", data_citacao: p.dataCitacao ?? "",
    data_final: p.dataFinal ?? "", data_ajuizamento: p.dataAjuizamento ?? "", data_transito: p.dataTransito ?? "",
    modo_regimes: p.modoRegimes ?? "padrao", regimes: c.regimes ?? [], indices: (p.indicesSubstitutos ?? {}) as Record<string, string>,
    data_intimacao: p.dataIntimacao ?? "", pagamento_valor: centavosParaCampo(p.pagamento?.valorCentavos), pagamento_data: p.pagamento?.data ?? "",
    modalidade: p.modalidade ?? "sucumbencia", forma: p.forma ?? "percentual", base_tipo: p.baseTipo ?? "condenacao",
    base_valor: centavosParaCampo(p.baseCentavos), percentual: p.percentual?.replace(".", ",") ?? "10", valor_fixo: centavosParaCampo(p.valorFixoCentavos),
    fazenda_publica: !!p.fazendaPublica,
  };
}

function lerIndices(fd: FormData, ids: string[]): Record<string, CodigoIndice | "nenhuma"> {
  const out: Record<string, CodigoIndice | "nenhuma"> = {};
  for (const id of ids) {
    const v = indiceOuPadrao.safeParse(String(fd.get(`indice__${id}`) ?? ""));
    if (v.success && v.data) out[id] = v.data as CodigoIndice | "nenhuma";
  }
  return out;
}

const TIPOS_DESLIGAMENTO: TipoDesligamento[] = ["sem_justa_causa", "pedido_demissao", "justa_causa", "acordo_484a"];

function lerTrabalhista(fd: FormData, regimesPadrao: string[], regimesValidos: string[]): { modoRegimes: ModoRegimes; parametros: ParametrosTrabalhista } | { erro: string } {
  const campo = (k: string) => String(fd.get(k) ?? "").trim();
  const ajuizamento = campo("data_ajuizamento"), final = campo("data_final");
  if (!dataValida(ajuizamento)) return { erro: "Informe a data de ajuizamento da ação (obrigatória no cálculo trabalhista)." };
  if (!dataValida(final)) return { erro: "Data final: data inválida." };
  const modo: ModoRegimes = campo("modo_regimes") === "escolher" ? "escolher" : "padrao";
  const regimeIds = modo === "padrao" ? regimesPadrao : fd.getAll("regimes").map(String).filter((id) => regimesValidos.includes(id));
  if (!regimeIds.length) return { erro: "Escolha ao menos um regime." };

  let rescisao: ParametrosTrabalhista["rescisao"] = null;
  if (fd.get("com_rescisao") === "on") {
    const tipo = campo("tipo_desligamento") as TipoDesligamento;
    if (!TIPOS_DESLIGAMENTO.includes(tipo)) return { erro: "Escolha o tipo de desligamento." };
    if (!dataValida(campo("admissao")) || !dataValida(campo("saida"))) return { erro: "Rescisão: informe as datas de admissão e de saída." };
    const salario = paraCentavos(campo("salario"));
    if (salario === null || salario <= 0) return { erro: "Rescisão: informe o último salário." };
    const medias = campo("medias") ? paraCentavos(campo("medias")) : 0;
    if (medias === null || medias < 0) return { erro: "Rescisão: médias de variáveis inválidas." };
    const saldo = campo("saldo_fgts") ? paraCentavos(campo("saldo_fgts")) : null;
    if (campo("saldo_fgts") && (saldo === null || saldo < 0)) return { erro: "Rescisão: saldo do FGTS inválido." };
    const fv = Number(campo("ferias_vencidas") || "0"), fd2 = Number(campo("ferias_dobro") || "0");
    rescisao = {
      admissao: campo("admissao"), saida: campo("saida"), tipo, avisoIndenizado: fd.get("aviso_indenizado") === "on",
      salarioCentavos: salario, mediasCentavos: medias, feriasVencidas: fv, feriasVencidasEmDobro: fd2, saldoFgtsCentavos: saldo,
    };
  }

  const desc = fd.getAll("verba_descricao").map(String), val = fd.getAll("verba_valor").map(String), venc = fd.getAll("verba_vencimento").map(String);
  const verbas: ParametrosTrabalhista["verbas"] = [];
  for (let i = 0; i < desc.length; i++) {
    const d = desc[i]?.trim() ?? "", v = val[i]?.trim() ?? "", ve = venc[i]?.trim() ?? "";
    if (!d && !v && !ve) continue;
    const c = paraCentavos(v);
    if (!d || d.length > 120) return { erro: `Verba ${i + 1}: informe a descrição (até 120 letras).` };
    if (c === null || c <= 0) return { erro: `Verba "${d}": informe o valor.` };
    if (!dataValida(ve)) return { erro: `Verba "${d}": informe o vencimento.` };
    verbas.push({ descricao: d, valorCentavos: c, vencimento: ve });
  }
  if (!rescisao && !verbas.length) return { erro: "Informe os dados da rescisão ou ao menos uma verba." };
  return { modoRegimes: modo, parametros: { dataAjuizamento: ajuizamento, dataFinal: final, regimeIds, indicesSubstitutos: lerIndices(fd, regimeIds), rescisao, verbas } };
}
