/**
 * Fonte de EXEMPLO, no formato exato da Comunica API do DJEN, com dados fictícios.
 * Só para testes e desenvolvimento local (DJEN_USAR_EXEMPLOS=1). Tudo o que ela grava sai com fonte = "exemplo",
 * para nunca ser confundido com publicação real. PENDENCIA P-014.
 */
import { calcularDigitoCnj } from "./cnj";
import { dataBrasilia, somarDias } from "./datas";
import { mapearItemDjen, type ItemDjen } from "./djen";
import type { FiltroPublicacoes, FonteJuridica, Publicacao } from "./tipos";

/** Monta um nº CNJ válido (com dígito verificador certo) a partir das partes. */
export function cnjExemplo(seq: string, ano: string, j: string, tr: string, origem: string) {
  const dd = calcularDigitoCnj(seq, ano, j, tr, origem);
  return { digitos: `${seq}${dd}${ano}${j}${tr}${origem}`, mascara: `${seq}-${dd}.${ano}.${j}.${tr}.${origem}` };
}

export const PROC_CIVEL = cnjExemplo("0801234", "2025", "8", "05", "0001"); // TJBA
export const PROC_TRABALHO = cnjExemplo("0000456", "2025", "5", "05", "0012"); // TRT5
export const PROC_CITADO = cnjExemplo("1002345", "2026", "8", "05", "0080"); // TJBA, só citado no texto

export function itensExemplo(oab: { numero: string; uf: string }, ate: string): ItemDjen[] {
  const ontem = somarDias(ate, -1);
  const advogado = { advogado: { nome: "ADVOGADA EXEMPLO", numero_oab: oab.numero, uf_oab: oab.uf } };
  return [
    {
      id: 910001,
      data_disponibilizacao: ate,
      siglaTribunal: "TJBA",
      tipoComunicacao: "Intimação",
      nomeOrgao: "3ª Vara Cível de Exemplo",
      texto: `<p>Processo ${PROC_CIVEL.mascara}. Intimação da parte autora para, no prazo de 15 dias, manifestar-se sobre a contestação.</p><script>alert(1)</script>`,
      numero_processo: PROC_CIVEL.digitos,
      link: "https://comunicaapi.pje.jus.br/exemplo/910001",
      tipoDocumento: "Despacho",
      nomeClasse: "PROCEDIMENTO COMUM CÍVEL",
      destinatarios: [{ nome: "PARTE AUTORA EXEMPLO", polo: "A" }],
      destinatarioadvogados: [advogado],
    },
    {
      id: 910002,
      data_disponibilizacao: ate,
      siglaTribunal: "TRT5",
      tipoComunicacao: "Intimação",
      nomeOrgao: "12ª Vara do Trabalho de Exemplo",
      texto: `Ficam as partes intimadas da audiência de instrução no processo ${PROC_TRABALHO.mascara}.`,
      numero_processo: PROC_TRABALHO.digitos,
      link: "https://comunicaapi.pje.jus.br/exemplo/910002",
      tipoDocumento: "Notificação",
      nomeClasse: "AÇÃO TRABALHISTA - RITO ORDINÁRIO",
      destinatarios: [{ nome: "RECLAMANTE EXEMPLO", polo: "A" }],
      destinatarioadvogados: [advogado],
    },
    {
      // Sem numero_processo: o nº vem do texto. Também cita um nº com dígito errado, que deve ser ignorado.
      id: 910003,
      data_disponibilizacao: ontem,
      siglaTribunal: "TJBA",
      tipoComunicacao: "Intimação",
      nomeOrgao: "Vara da Fazenda Pública de Exemplo",
      texto: `Notifique-se a autoridade coatora. Autos ${PROC_CITADO.mascara}. Referência antiga: 1234567-00.2020.8.05.0001.`,
      numero_processo: null,
      link: null,
      tipoDocumento: "Decisão",
      nomeClasse: "MANDADO DE SEGURANÇA CÍVEL",
      destinatarios: [],
      destinatarioadvogados: [advogado],
    },
    {
      // Sem nenhum nº de processo identificável: vai para "Publicações sem processo" (Prompt 3).
      id: 910004,
      data_disponibilizacao: ontem,
      siglaTribunal: "TJBA",
      tipoComunicacao: "Edital",
      nomeOrgao: "Diretoria de Exemplo",
      texto: "Edital de intimação de advogados cadastrados para atualização de dados.",
      numero_processo: null,
      link: null,
      tipoDocumento: "Edital",
      nomeClasse: null,
      destinatarios: [],
      destinatarioadvogados: [advogado],
    },
  ];
}

export class FonteExemplo implements FonteJuridica {
  readonly nome = "exemplo" as const;
  readonly capacidades = { publicacoes: true, processo: false, movimentacoes: false };

  async buscarPublicacoes(filtro: FiltroPublicacoes): Promise<Publicacao[]> {
    if (!filtro.oab) return [];
    const desde = dataBrasilia(filtro.desde);
    const ate = dataBrasilia(filtro.ate ?? new Date());
    return itensExemplo(filtro.oab, ate)
      .filter((i) => (i.data_disponibilizacao ?? "") >= desde)
      .map((i) => mapearItemDjen(i, "exemplo"))
      .filter((p): p is Publicacao => p !== null);
  }

  async buscarProcesso(): Promise<null> {
    return null;
  }

  async buscarMovimentacoes(): Promise<[]> {
    return [];
  }
}
