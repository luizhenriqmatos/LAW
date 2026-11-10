/**
 * Interface do WhatsApp (Cloud API oficial da Meta). A regra de negócio só fala com esta interface.
 * PENDENCIA P-076: WHATSAPP_ACCESS_TOKEN (token permanente do usuário do sistema), WHATSAPP_APP_SECRET (assinatura do
 * webhook), WHATSAPP_VERIFY_TOKEN (verificação do webhook) e número aprovado. Sem o token, nada é enviado e a
 * mensagem fica registrada como "falhou" para a equipe ver na tela.
 */
export type ResultadoZap = { ok: true; wamid: string | null } | { ok: false; motivo: string };

export interface ServicoWhatsapp {
  enviarTexto(p: { phoneNumberId: string; para: string; texto: string }): Promise<ResultadoZap>;
  /** Mensagem de modelo (template) aprovado. Única forma de falar fora da janela de 24 h. */
  enviarModelo(p: { phoneNumberId: string; para: string; modelo: string; idioma: string; parametros: string[] }): Promise<ResultadoZap>;
}

const VERSAO_API = process.env.WHATSAPP_API_VERSION || "v21.0";

class WhatsappMeta implements ServicoWhatsapp {
  constructor(private token: string) {}

  private async enviar(phoneNumberId: string, corpo: Record<string, unknown>): Promise<ResultadoZap> {
    try {
      const r = await fetch(`https://graph.facebook.com/${VERSAO_API}/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...corpo }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = (await r.json().catch(() => ({}))) as { messages?: { id?: string }[]; error?: { code?: number; message?: string } };
      if (!r.ok) return { ok: false, motivo: `Meta ${r.status}${j.error ? ` ${j.error.code ?? ""} ${j.error.message ?? ""}` : ""}`.trim() };
      return { ok: true, wamid: j.messages?.[0]?.id ?? null };
    } catch (e) {
      return { ok: false, motivo: e instanceof Error ? e.message : "Falha de rede ao falar com a Meta." };
    }
  }

  enviarTexto(p: { phoneNumberId: string; para: string; texto: string }) {
    return this.enviar(p.phoneNumberId, { to: p.para, type: "text", text: { preview_url: false, body: p.texto } });
  }

  enviarModelo(p: { phoneNumberId: string; para: string; modelo: string; idioma: string; parametros: string[] }) {
    return this.enviar(p.phoneNumberId, {
      to: p.para,
      type: "template",
      template: {
        name: p.modelo,
        language: { code: p.idioma },
        ...(p.parametros.length ? { components: [{ type: "body", parameters: p.parametros.map((t) => ({ type: "text", text: t })) }] } : {}),
      },
    });
  }
}

class WhatsappNaoConfigurado implements ServicoWhatsapp {
  async enviarTexto(): Promise<ResultadoZap> {
    return { ok: false, motivo: "O WhatsApp ainda não está configurado (WHATSAPP_ACCESS_TOKEN)." };
  }
  async enviarModelo(): Promise<ResultadoZap> {
    return { ok: false, motivo: "O WhatsApp ainda não está configurado (WHATSAPP_ACCESS_TOKEN)." };
  }
}

export function servicoWhatsapp(): ServicoWhatsapp {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  return token ? new WhatsappMeta(token) : new WhatsappNaoConfigurado();
}

export function whatsappConfigurado(): boolean {
  return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_APP_SECRET && process.env.WHATSAPP_VERIFY_TOKEN);
}
