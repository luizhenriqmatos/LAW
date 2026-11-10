import type { ChamarRpc } from "@/lib/captura/job";
import type { ServicoWhatsapp } from "@/lib/integrations/whatsapp";
import type { EntradaZap, StatusZap } from "./payload";
import { categoriaDaResposta, classificarPorPalavras, decidir, numeroDoMenu, type Conversa, type Decisao, type EstadoConversa } from "./recepcionista";
import type { Categoria } from "./textos";

export type DepsRecepcao = {
  /** RPC com a chave de serviço (webhook não tem usuário logado). */
  rpc: ChamarRpc;
  whatsapp: ServicoWhatsapp;
  /** IA opcional: devolve SÓ uma categoria. Nunca escreve para o contato. */
  classificar?: (texto: string) => Promise<Categoria | null>;
};

type EstadoRpc = {
  conversa_id: string;
  estado: EstadoConversa;
  versao: number;
  categoria: Categoria | null;
  nome: string | null;
  resumo: string | null;
  tentativas: number;
  identificado: boolean;
  phone_number_id: string;
  telefone: string;
  escritorio_nome: string;
  prazo_resposta_texto: string | null;
  horario_texto: string | null;
  mensagem_id?: string;
};
type Recebida = EstadoRpc | { ignorado: "numero_desconhecido" | "recepcao_desativada" | "duplicada" };
type Aplicada = { atendimento_id: string | null; saidas: { id: string; texto: string }[]; notificados: string[] };

export type ResultadoEvento =
  | { situacao: "ignorada"; motivo: string }
  | { situacao: "tratada"; conversaId: string; atendimentoId: string | null; enviadas: number; falhas: number };

const TENTATIVAS_CONCORRENCIA = 3;

function paraConversa(e: EstadoRpc): Conversa {
  return { estado: e.estado, categoria: e.categoria, nome: e.nome, resumo: e.resumo, tentativas: e.tentativas, identificado: e.identificado };
}

/** A IA só entra quando as palavras-chave não acharam nada e o texto é longo o bastante para ter motivo. */
async function categoriaPorIa(deps: DepsRecepcao, conv: Conversa, e: EntradaZap): Promise<Categoria | null> {
  if (!deps.classificar || !e.texto) return null;
  if (conv.estado !== "novo" && conv.estado !== "aguardando_motivo") return null;
  if (numeroDoMenu(e.texto) || classificarPorPalavras(e.texto) !== "outro") return null;
  if (e.texto.trim().split(/\s+/).length < 4) return null;
  try {
    return await deps.classificar(e.texto);
  } catch {
    return null; // IA fora do ar: cai em "outro", a conversa segue
  }
}

export async function tratarMensagem(deps: DepsRecepcao, e: EntradaZap): Promise<ResultadoEvento> {
  const recebida = await deps.rpc<Recebida>("recepcao_receber", {
    p_phone_number_id: e.phoneNumberId, p_wa_id: e.waId, p_wamid: e.wamid, p_tipo: e.tipo,
    p_texto: e.texto, p_nome_perfil: e.nomePerfil, p_enviada_em: e.enviadaEm?.toISOString() ?? null,
  });
  if ("ignorado" in recebida) return { situacao: "ignorada", motivo: recebida.ignorado };

  let estado: EstadoRpc = recebida;
  const mensagemId = recebida.mensagem_id!;
  for (let i = 0; i < TENTATIVAS_CONCORRENCIA; i++) {
    const conv = paraConversa(estado);
    if (conv.estado === "humano" || conv.estado === "encerrada") {
      await deps.rpc("recepcao_marcar_processada", { p_mensagem: mensagemId });
      return { situacao: "tratada", conversaId: estado.conversa_id, atendimentoId: null, enviadas: 0, falhas: 0 };
    }
    const decisao: Decisao = decidir(
      conv,
      { tipo: e.tipo, texto: e.texto },
      { escritorio: estado.escritorio_nome, prazoTexto: estado.prazo_resposta_texto, horarioTexto: estado.horario_texto },
      await categoriaPorIa(deps, conv, e),
    );
    try {
      const r = await deps.rpc<Aplicada>("recepcao_aplicar", {
        p_conversa: estado.conversa_id, p_versao: estado.versao, p_estado: decisao.estado, p_categoria: decisao.categoria,
        p_nome: decisao.nome, p_resumo: decisao.resumo, p_tentativas: decisao.tentativas,
        p_respostas: decisao.respostas, p_transferir: decisao.transferir, p_mensagem: mensagemId,
      });
      let enviadas = 0;
      let falhas = 0;
      // O estado já está gravado (inclusive "humano"). Se o envio falhar, a mensagem fica "falhou" na tela da equipe.
      for (const s of r.saidas) {
        const res = await deps.whatsapp.enviarTexto({ phoneNumberId: estado.phone_number_id, para: estado.telefone, texto: s.texto });
        await deps.rpc("recepcao_saida_resultado", {
          p_mensagem: s.id, p_wamid: res.ok ? res.wamid : null, p_ok: res.ok, p_erro: res.ok ? null : res.motivo,
        });
        if (res.ok) enviadas++; else falhas++;
      }
      return { situacao: "tratada", conversaId: estado.conversa_id, atendimentoId: r.atendimento_id, enviadas, falhas };
    } catch (erro) {
      if (!(erro instanceof Error) || !erro.message.includes("conversa_mudou")) throw erro;
      estado = { ...(await deps.rpc<EstadoRpc>("recepcao_estado", { p_conversa: estado.conversa_id })), mensagem_id: mensagemId };
    }
  }
  throw new Error("Conversa mudou várias vezes ao mesmo tempo; a Meta vai reenviar.");
}

export async function tratarRecibo(deps: DepsRecepcao, r: StatusZap): Promise<void> {
  await deps.rpc("recepcao_status_webhook", { p_wamid: r.wamid, p_status: r.status, p_erro: r.erro });
}

export async function processarEventos(deps: DepsRecepcao, ev: { mensagens: EntradaZap[]; recibos: StatusZap[] }) {
  const resultados: ResultadoEvento[] = [];
  // Em ordem: duas mensagens seguidas do mesmo contato precisam ser tratadas uma depois da outra.
  for (const m of ev.mensagens) resultados.push(await tratarMensagem(deps, m));
  for (const r of ev.recibos) await tratarRecibo(deps, r);
  return resultados;
}

const PROMPT_CLASSIFICAR =
  "Você classifica a primeira mensagem de uma pessoa que escreveu para um escritório de advocacia. " +
  "Responda com UMA palavra, exatamente uma destas: novo_caso, andamento, financeiro, agendamento, outro. " +
  "novo_caso = quer contratar o escritório ou apresentar um caso novo; andamento = pergunta sobre processo já existente; " +
  "financeiro = honorários, boleto, pagamento; agendamento = marcar, remarcar ou cancelar reunião ou atendimento; " +
  "outro = qualquer coisa diferente. Não explique, não responda à pessoa, não dê opinião. Só a palavra.";

/** Monta o classificador com a IA do LAW. A resposta só vale se for exatamente uma das cinco categorias. */
export function classificadorComIa(ia: { gerarTexto(p: { sistema: string; usuario: string; maxTokens: number }): Promise<{ ok: true; texto: string } | { ok: false; motivo: string }> }) {
  return async (texto: string): Promise<Categoria | null> => {
    const r = await ia.gerarTexto({ sistema: PROMPT_CLASSIFICAR, usuario: texto.slice(0, 1000), maxTokens: 10 });
    return r.ok ? categoriaDaResposta(r.texto) : null;
  };
}
