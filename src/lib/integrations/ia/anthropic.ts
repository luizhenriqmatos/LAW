import { z } from "zod";
import type { BlocoFerramenta, BlocoTexto, DefinicaoFerramenta, MensagemIa, RespostaConversa, ResultadoIa, ServicoIa, ServicoIaFerramentas } from "./index";

const Resposta = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) });

const RespostaFerramentas = z.object({
  stop_reason: z.string().nullable().optional(),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1), input: z.unknown() }),
      // Outros tipos de bloco (ex.: thinking) são ignorados.
      z.object({ type: z.enum(["thinking", "redacted_thinking"]) }).loose(),
    ]),
  ),
});

const URL = "https://api.anthropic.com/v1/messages";

export class IaAnthropic implements ServicoIa, ServicoIaFerramentas {
  constructor(private chave: string, readonly modelo: string, private f: typeof fetch = fetch) {}

  private cabecalhos() {
    return { "x-api-key": this.chave, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  }

  async gerarTexto(p: { sistema: string; usuario: string; maxTokens: number }): Promise<ResultadoIa> {
    try {
      const r = await this.f(URL, {
        method: "POST",
        headers: this.cabecalhos(),
        body: JSON.stringify({ model: this.modelo, max_tokens: p.maxTokens, system: p.sistema, messages: [{ role: "user", content: p.usuario }] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) return { ok: false, motivo: `Anthropic respondeu ${r.status}.` };
      const j = Resposta.safeParse(await r.json());
      if (!j.success) return { ok: false, motivo: "Resposta da IA em formato inesperado." };
      const texto = j.data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
      return texto ? { ok: true, texto } : { ok: false, motivo: "A IA devolveu texto vazio." };
    } catch {
      return { ok: false, motivo: "Não foi possível falar com a IA." };
    }
  }

  async conversar(p: { sistema: string; mensagens: MensagemIa[]; ferramentas: DefinicaoFerramenta[]; maxTokens: number }): Promise<RespostaConversa> {
    try {
      const r = await this.f(URL, {
        method: "POST",
        headers: this.cabecalhos(),
        body: JSON.stringify({ model: this.modelo, max_tokens: p.maxTokens, system: p.sistema, tools: p.ferramentas, messages: p.mensagens }),
        signal: AbortSignal.timeout(60_000),
      });
      if (r.status === 429) return { ok: false, motivo: "A IA está sobrecarregada agora. Tente de novo em um minuto." };
      if (!r.ok) return { ok: false, motivo: `A IA respondeu com erro (${r.status}).` };
      const j = RespostaFerramentas.safeParse(await r.json());
      if (!j.success) return { ok: false, motivo: "Resposta da IA em formato inesperado." };
      const blocos: (BlocoTexto | BlocoFerramenta)[] = [];
      for (const b of j.data.content) {
        if (b.type === "text") blocos.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") blocos.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      }
      return { ok: true, blocos, parada: j.data.stop_reason ?? "end_turn" };
    } catch {
      return { ok: false, motivo: "Não foi possível falar com a IA." };
    }
  }
}
