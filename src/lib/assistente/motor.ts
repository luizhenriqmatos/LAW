import type { BlocoFerramenta, BlocoResultado, BlocoTexto, MensagemIa, ServicoIaFerramentas } from "@/lib/integrations/ia";
import { definicoes, ferramentaPorNome, type CtxFerramenta } from "./ferramentas";
import { promptDoSistema } from "./prompt";
import type { Fonte } from "./tipos";

/**
 * Laço da conversa com ferramentas: a IA pede ferramentas, o LAW executa (leitura com o login do usuário; escrita
 * só prepara rascunho), devolve o resultado e repete até a IA responder em texto.
 */
// PENDENCIA P-068: limites fixos de custo (sem limite por plano nem medição de tokens).
export const MAX_RODADAS = 8;
export const MAX_FERRAMENTAS_POR_RODADA = 6;
const MAX_RESULTADO = 15_000;
const MAX_HISTORICO = 12;

export type RegistroFerramenta = { nome: string; entrada: unknown; ok: boolean; codigo?: string; itens?: number; rascunho_id?: string };

export type RespostaAssistente = {
  texto: string;
  fontes: Fonte[];
  ferramentas: RegistroFerramenta[];
  semPermissao: string[];
  rascunhos: string[];
  falhou: boolean;
};

export type MensagemHistorico = { papel: "usuario" | "assistente"; texto: string };

/** Histórico em texto, alternando usuário/assistente e começando pelo usuário (exigência da API). */
export function montarHistorico(historico: MensagemHistorico[], pergunta: string): MensagemIa[] {
  const recentes = historico.slice(-MAX_HISTORICO);
  const msgs: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of [...recentes, { papel: "usuario" as const, texto: pergunta }]) {
    const role = m.papel === "usuario" ? "user" : "assistant";
    const ultima = msgs[msgs.length - 1];
    if (ultima && ultima.role === role) ultima.content += `\n\n${m.texto}`;
    else msgs.push({ role, content: m.texto });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs as MensagemIa[];
}

const cortar = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…[cortado]` : s);

function resumoEntrada(entrada: unknown): unknown {
  const s = JSON.stringify(entrada ?? {});
  return s.length > 2000 ? { cortado: s.slice(0, 2000) } : entrada;
}

export async function responder(p: { ia: ServicoIaFerramentas; ctx: CtxFerramenta; historico: MensagemHistorico[]; pergunta: string }): Promise<RespostaAssistente> {
  const sistema = promptDoSistema(p.ctx.contexto);
  const mensagens = montarHistorico(p.historico, p.pergunta);
  const fontes = new Map<string, Fonte>();
  const registro: RegistroFerramenta[] = [];
  const semPermissao = new Set<string>();
  const rascunhos: string[] = [];
  const fim = (texto: string, falhou = false): RespostaAssistente => ({
    texto: cortar(texto.trim() || "Não encontrei uma resposta para isso.", 19_000),
    fontes: [...fontes.values()], ferramentas: registro, semPermissao: [...semPermissao], rascunhos, falhou,
  });

  for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
    const r = await p.ia.conversar({ sistema, mensagens, ferramentas: definicoes(), maxTokens: 2048 });
    if (!r.ok) return fim(`Não consegui responder agora: ${r.motivo}`, true);
    const textos = r.blocos.filter((b): b is BlocoTexto => b.type === "text").map((b) => b.text);
    const pedidos = r.blocos.filter((b): b is BlocoFerramenta => b.type === "tool_use");
    if (pedidos.length === 0) return fim(textos.join("\n"));

    mensagens.push({ role: "assistant", content: r.blocos });
    const resultados: BlocoResultado[] = [];
    for (const [i, pedido] of pedidos.entries()) {
      const ferramenta = ferramentaPorNome(pedido.name);
      if (!ferramenta || i >= MAX_FERRAMENTAS_POR_RODADA) {
        resultados.push({ type: "tool_result", tool_use_id: pedido.id, is_error: true, content: JSON.stringify({ erro: ferramenta ? "limite_de_ferramentas" : "ferramenta_inexistente" }) });
        continue;
      }
      const res = await ferramenta.executar(p.ctx, pedido.input);
      if (res.ok) {
        res.fontes.forEach((f) => fontes.set(f.ref, f));
        if (res.rascunhoId) rascunhos.push(res.rascunhoId);
        registro.push({ nome: pedido.name, entrada: resumoEntrada(pedido.input), ok: true, itens: res.itens, rascunho_id: res.rascunhoId });
        resultados.push({ type: "tool_result", tool_use_id: pedido.id, content: cortar(JSON.stringify(res.paraIa), MAX_RESULTADO) });
      } else {
        res.semPermissao.forEach((m) => semPermissao.add(m));
        registro.push({ nome: pedido.name, entrada: resumoEntrada(pedido.input), ok: false, codigo: res.codigo });
        resultados.push({ type: "tool_result", tool_use_id: pedido.id, is_error: true, content: JSON.stringify({ erro: res.codigo, mensagem: res.mensagem }) });
      }
    }
    mensagens.push({ role: "user", content: resultados });
  }
  return fim("Não consegui concluir a resposta (consultas demais). Tente uma pergunta mais específica.", true);
}
