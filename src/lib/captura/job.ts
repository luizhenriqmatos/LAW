/**
 * Job de captura: para cada escritório ativo, busca publicações nas fontes, grava sem duplicar
 * e enriquece os processos citados com o DataJud.
 *
 * Regras:
 *  - Período: desde a última captura bem-sucedida, com 2 dias de sobreposição; na primeira vez, 30 dias.
 *  - As publicações são gravadas ANTES do enriquecimento: falha no DataJud nunca impede a gravação.
 *  - Falha de uma fonte ou de um alvo não derruba os outros; tudo fica registrado em captura_execucao.
 *  - "Última captura OK" só avança se todas as buscas de publicação deram certo.
 *  - No fim, a triagem automática liga publicações a processos e cria os provisórios (Prompt 3).
 */
import { dataBrasilia, dataPublicacaoEstimada, somarDias } from "@/lib/integrations/fontes/datas";
import { ErroFonte } from "@/lib/integrations/fontes/fila";
import { hashPublicacao } from "@/lib/integrations/fontes/normalizar";
import type { Fontes } from "@/lib/integrations/fontes";
import type { FiltroPublicacoes, Publicacao } from "@/lib/integrations/fontes/tipos";

/** Chama uma função do banco (RPC). Em produção: Supabase com service_role. Nos testes: Postgres embutido. */
export type ChamarRpc = <T>(funcao: string, args: Record<string, unknown>) => Promise<T>;

export type Origem = "agendada" | "onboarding" | "manual" | "teste";

type Alvo = { tipo: "oab" | "sociedade"; oab_numero: string | null; oab_uf: string | null; cnpj: string | null; nome: string | null };
type EscritorioAlvos = { escritorio_id: string; ultima_captura_ate: string | null; alvos: Alvo[] };

export type ErroCaptura = { fonte: string; codigo: string; mensagem: string; alvo?: string };

export type ResumoCaptura = {
  escritorioId: string;
  execucaoId: string | null;
  status: "sucesso" | "parcial" | "erro";
  desde: string;
  ate: string;
  encontradas: number;
  novas: number;
  duplicadas: number;
  enriquecidos: number;
  /** Resultado da triagem automática (null se não rodou). */
  triagem: ResumoTriagem | null;
  erros: ErroCaptura[];
};

export type ResumoTriagem = {
  processos_novos: number;
  processos_reabertos: number;
  clientes_novos: number;
  ligadas: number;
  aguardando: number;
  sem_processo: number;
};

export type DepsCaptura = {
  fontes: Fontes;
  rpc: ChamarRpc;
  agora?: () => Date;
  diasPrimeiraCaptura?: number;
  diasSobreposicao?: number;
  /** Teto de processos consultados no DataJud por execução (o resto fica para a próxima). */
  maxEnriquecimentos?: number;
};

const LOTE = 200;
const meioDia = (iso: string) => new Date(`${iso}T15:00:00Z`); // 12h em Brasília: nunca cai no dia vizinho

function descreverAlvo(a: Alvo): string {
  return a.tipo === "oab" ? `OAB ${a.oab_numero}/${a.oab_uf}` : a.nome ? `Sociedade ${a.nome}` : `CNPJ ${a.cnpj}`;
}

function paraErro(fonte: string, e: unknown, alvo?: string): ErroCaptura {
  if (e instanceof ErroFonte) return { fonte, codigo: e.codigo, mensagem: e.message, alvo };
  return { fonte, codigo: "outro", mensagem: e instanceof Error ? e.message : String(e), alvo };
}

/** Linha no formato que captura_salvar_publicacoes() espera. */
export function paraLinha(p: Publicacao) {
  return {
    fonte: p.fonte,
    id_externo: p.idExterno,
    hash: hashPublicacao({ tribunal: p.tribunal, numeroCnj: p.numeroCnj, dataDisponibilizacao: p.dataDisponibilizacao, texto: p.texto }),
    data_disponibilizacao: p.dataDisponibilizacao,
    data_publicacao: dataPublicacaoEstimada(p.dataDisponibilizacao),
    tribunal: p.tribunal,
    orgao: p.orgao,
    tipo_comunicacao: p.tipoComunicacao,
    tipo_documento: p.tipoDocumento,
    classe: p.classe,
    texto: p.texto,
    numero_cnj: p.numeroCnj,
    numeros_citados: p.numerosCitados,
    advogados: p.advogados,
    destinatarios: p.destinatarios,
    link: p.link,
    bruto: p.bruto,
  };
}

async function capturar(esc: EscritorioAlvos, origem: Origem, deps: DepsCaptura): Promise<ResumoCaptura> {
  const agora = deps.agora?.() ?? new Date();
  const ate = dataBrasilia(agora);
  const desde = esc.ultima_captura_ate
    ? somarDias(esc.ultima_captura_ate, -(deps.diasSobreposicao ?? 2))
    : somarDias(ate, -(deps.diasPrimeiraCaptura ?? 30));
  const resumo: ResumoCaptura = {
    escritorioId: esc.escritorio_id, execucaoId: null, status: "erro", desde, ate,
    encontradas: 0, novas: 0, duplicadas: 0, enriquecidos: 0, triagem: null, erros: [],
  };

  let publicacoesOk = true;
  try {
    resumo.execucaoId = await deps.rpc<string>("captura_iniciar", {
      p_escritorio: esc.escritorio_id, p_origem: origem, p_desde: desde, p_ate: ate,
    });

    // 1) Publicações: cada fonte × cada alvo, isolados.
    const porHash = new Map<string, ReturnType<typeof paraLinha>>();
    for (const fonte of deps.fontes.publicacoes) {
      for (const alvo of esc.alvos) {
        const filtro: FiltroPublicacoes = { desde: meioDia(desde), ate: meioDia(ate) };
        if (alvo.tipo === "oab" && alvo.oab_numero && alvo.oab_uf) filtro.oab = { numero: alvo.oab_numero, uf: alvo.oab_uf };
        else if (alvo.tipo === "sociedade" && alvo.nome) filtro.nomeParte = alvo.nome;
        else {
          // PENDENCIA P-018: o DJEN não busca por CNPJ. Sem nome da sociedade, não há o que consultar.
          publicacoesOk = false;
          resumo.erros.push({ fonte: fonte.nome, codigo: "nao_suportado", mensagem: "O DJEN não busca por CNPJ. Cadastre o nome da sociedade.", alvo: descreverAlvo(alvo) });
          continue;
        }
        try {
          for (const p of await fonte.buscarPublicacoes(filtro)) {
            const linha = paraLinha(p);
            if (!porHash.has(linha.hash)) porHash.set(linha.hash, linha);
          }
        } catch (e) {
          publicacoesOk = false;
          resumo.erros.push(paraErro(fonte.nome, e, descreverAlvo(alvo)));
        }
      }
    }

    // 2) Grava ANTES de enriquecer.
    const linhas = [...porHash.values()];
    resumo.encontradas = linhas.length;
    for (let i = 0; i < linhas.length; i += LOTE) {
      resumo.novas += await deps.rpc<number>("captura_salvar_publicacoes", {
        p_escritorio: esc.escritorio_id, p_execucao: resumo.execucaoId, p_itens: linhas.slice(i, i + LOTE),
      });
    }
    resumo.duplicadas = resumo.encontradas - resumo.novas;

    // 3) Enriquecimento pelo DataJud. Erro aqui fica registrado e não desfaz nada acima.
    const fonteProcesso = deps.fontes.processos;
    const numeros = [...new Set(linhas.flatMap((l) => l.numeros_citados))];
    if (fonteProcesso && numeros.length) {
      try {
        const pendentes = await deps.rpc<string[]>("captura_numeros_pendentes", { p_escritorio: esc.escritorio_id, p_numeros: numeros });
        for (const numero of pendentes.slice(0, deps.maxEnriquecimentos ?? 200)) {
          try {
            const meta = await fonteProcesso.buscarProcesso(numero);
            await deps.rpc("captura_salvar_metadados", {
              p_escritorio: esc.escritorio_id, p_numero: numero, p_fonte: fonteProcesso.nome, p_dados: meta, p_erro: null,
            });
            if (meta) resumo.enriquecidos++;
          } catch (e) {
            const erro = paraErro(fonteProcesso.nome, e);
            resumo.erros.push({ ...erro, alvo: numero });
            await deps.rpc("captura_salvar_metadados", {
              p_escritorio: esc.escritorio_id, p_numero: numero, p_fonte: fonteProcesso.nome, p_dados: null, p_erro: erro.codigo,
            });
            // Chave recusada ou acesso bloqueado: não adianta tentar os próximos números.
            if (e instanceof ErroFonte && (e.codigo === "chave_recusada" || e.codigo === "bloqueado")) break;
          }
        }
      } catch (e) {
        resumo.erros.push(paraErro(fonteProcesso.nome, e));
      }
    }

    // 4) Triagem: processo confirmado liga sozinho; nº novo vira provisório; sem nº vai para a fila.
    //    Se falhar, as publicações ficam "pendente" e a próxima execução tenta de novo.
    try {
      resumo.triagem = await deps.rpc<ResumoTriagem>("triar_publicacoes", { p_escritorio: esc.escritorio_id });
    } catch (e) {
      resumo.erros.push({ ...paraErro("law", e), codigo: "triagem" });
    }

    resumo.status = publicacoesOk ? (resumo.erros.length ? "parcial" : "sucesso") : resumo.encontradas > 0 ? "parcial" : "erro";
  } catch (e) {
    publicacoesOk = false;
    resumo.status = "erro";
    resumo.erros.push(paraErro("law", e));
  }

  if (resumo.execucaoId) {
    try {
      await deps.rpc("captura_finalizar", {
        p_execucao: resumo.execucaoId, p_status: resumo.status, p_encontradas: resumo.encontradas, p_novas: resumo.novas,
        p_duplicadas: resumo.duplicadas, p_enriquecidos: resumo.enriquecidos, p_erros: resumo.erros, p_publicacoes_ok: publicacoesOk,
      });
    } catch (e) {
      resumo.erros.push(paraErro("law", e));
    }
  }
  return resumo;
}

/** Captura de um escritório (usada logo após o onboarding e para disparo manual). */
export async function capturarEscritorio(escritorioId: string, origem: Origem, deps: DepsCaptura): Promise<ResumoCaptura | null> {
  const lista = await deps.rpc<EscritorioAlvos[]>("captura_alvos", { p_escritorio: escritorioId });
  return lista[0] ? capturar(lista[0], origem, deps) : null;
}

/** Captura de todos os escritórios ativos, um por vez. Erro num escritório não para os outros. */
export async function capturarTodos(origem: Origem, deps: DepsCaptura): Promise<ResumoCaptura[]> {
  const lista = await deps.rpc<EscritorioAlvos[]>("captura_alvos", { p_escritorio: null });
  const resumos: ResumoCaptura[] = [];
  for (const esc of lista) resumos.push(await capturar(esc, origem, deps));
  return resumos;
}
