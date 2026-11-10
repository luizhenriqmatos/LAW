import { IaAnthropic } from "./anthropic";

/**
 * Interface de IA do LAW. A regra de negócio nunca chama o SDK/API do provedor direto.
 * PENDENCIA P-055: ANTHROPIC_API_KEY. Sem ela o resumo do portal não é gerado (o advogado escreve à mão) e a
 * assistente Lia fica desligada (a tela avisa).
 */
export type ResultadoIa = { ok: true; texto: string } | { ok: false; motivo: string };

export interface ServicoIa {
  readonly modelo: string;
  gerarTexto(p: { sistema: string; usuario: string; maxTokens: number }): Promise<ResultadoIa>;
}

// ---- Conversa com uso de ferramentas (tool use)

export type BlocoTexto = { type: "text"; text: string };
export type BlocoFerramenta = { type: "tool_use"; id: string; name: string; input: unknown };
export type BlocoResultado = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type MensagemIa =
  | { role: "user"; content: string | BlocoResultado[] }
  | { role: "assistant"; content: string | (BlocoTexto | BlocoFerramenta)[] };

export type DefinicaoFerramenta = { name: string; description: string; input_schema: Record<string, unknown> };

export type RespostaConversa =
  | { ok: true; blocos: (BlocoTexto | BlocoFerramenta)[]; parada: string }
  | { ok: false; motivo: string };

export interface ServicoIaFerramentas {
  readonly modelo: string;
  conversar(p: { sistema: string; mensagens: MensagemIa[]; ferramentas: DefinicaoFerramenta[]; maxTokens: number }): Promise<RespostaConversa>;
}

export function servicoIa(): ServicoIa | null {
  const chave = process.env.ANTHROPIC_API_KEY;
  return chave ? new IaAnthropic(chave, process.env.ANTHROPIC_MODEL_RESUMO || "claude-haiku-5-5") : null;
}

/** IA da assistente Lia (Prompt 11). Modelo próprio porque usa ferramentas e precisa raciocinar melhor que o resumo. */
export function servicoIaAssistente(): ServicoIaFerramentas | null {
  const chave = process.env.ANTHROPIC_API_KEY;
  return chave ? new IaAnthropic(chave, process.env.ANTHROPIC_MODEL_ASSISTENTE || "claude-sonnet-5-5") : null;
}
