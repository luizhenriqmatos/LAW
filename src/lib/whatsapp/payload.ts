import { z } from "zod";

/** Payload do webhook da WhatsApp Cloud API. Só o que o LAW usa; o resto é ignorado. Toda entrada externa passa por aqui. */
const mensagem = z.object({
  id: z.string().min(1).max(200),
  from: z.string().regex(/^\d{8,16}$/),
  timestamp: z.string().regex(/^\d{1,12}$/).optional(),
  type: z.string().max(40),
  text: z.object({ body: z.string().max(8192) }).optional(),
  button: z.object({ text: z.string().max(1000).optional() }).optional(),
  interactive: z
    .object({
      button_reply: z.object({ title: z.string().max(1000).optional() }).optional(),
      list_reply: z.object({ title: z.string().max(1000).optional() }).optional(),
    })
    .optional(),
});

const status = z.object({
  id: z.string().min(1).max(200),
  status: z.string().max(30),
  errors: z.array(z.object({ code: z.number().optional(), title: z.string().max(300).optional(), message: z.string().max(500).optional() })).optional(),
});

const valor = z.object({
  metadata: z.object({ phone_number_id: z.string().regex(/^\d{5,24}$/) }),
  contacts: z.array(z.object({ wa_id: z.string().optional(), profile: z.object({ name: z.string().max(200).optional() }).optional() })).optional(),
  messages: z.array(mensagem).optional(),
  statuses: z.array(status).optional(),
});

export const payloadWhatsapp = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({ changes: z.array(z.object({ field: z.string(), value: valor })) })),
});

export type EntradaZap = {
  phoneNumberId: string;
  waId: string;
  wamid: string;
  tipo: "texto" | "outro";
  tipoOriginal: string;
  texto: string | null;
  nomePerfil: string | null;
  enviadaEm: Date | null;
};
export type StatusZap = { wamid: string; status: "enviada" | "entregue" | "lida" | "falhou"; erro: string | null };

const STATUS_META: Record<string, StatusZap["status"]> = { sent: "enviada", delivered: "entregue", read: "lida", failed: "falhou" };

/** Achata o payload em mensagens recebidas e recibos. Lança se o formato não for o esperado. */
export function extrairEventos(corpo: unknown): { mensagens: EntradaZap[]; recibos: StatusZap[] } {
  const p = payloadWhatsapp.parse(corpo);
  const mensagens: EntradaZap[] = [];
  const recibos: StatusZap[] = [];
  for (const e of p.entry) {
    for (const c of e.changes) {
      if (c.field !== "messages") continue;
      const v = c.value;
      const perfil = new Map((v.contacts ?? []).map((x) => [x.wa_id ?? "", x.profile?.name ?? null]));
      for (const m of v.messages ?? []) {
        // Botão e lista também viram texto (a recepcionista não envia botões, mas o contato pode responder a um modelo).
        const texto = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
        mensagens.push({
          phoneNumberId: v.metadata.phone_number_id,
          waId: m.from,
          wamid: m.id,
          tipo: texto ? "texto" : "outro",
          tipoOriginal: m.type,
          texto,
          nomePerfil: perfil.get(m.from) ?? null,
          enviadaEm: m.timestamp ? new Date(Number(m.timestamp) * 1000) : null,
        });
      }
      for (const s of v.statuses ?? []) {
        const st = STATUS_META[s.status];
        if (!st) continue;
        const err = s.errors?.[0];
        recibos.push({ wamid: s.id, status: st, erro: err ? [err.code, err.title ?? err.message].filter(Boolean).join(" ") : null });
      }
    }
  }
  return { mensagens, recibos };
}
