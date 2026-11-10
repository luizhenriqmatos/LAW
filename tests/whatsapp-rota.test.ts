import { beforeEach, describe, expect, it, vi } from "vitest";
import { assinar } from "@/lib/whatsapp/assinatura";

const processar = vi.fn(async () => []);
vi.mock("@/lib/whatsapp/processar", async (orig) => ({ ...(await orig<typeof import("@/lib/whatsapp/processar")>()), processarEventos: processar }));
vi.mock("@/lib/supabase/servico", () => ({ rpcServico: () => async () => null, servicoConfigurado: () => true }));
vi.mock("@/lib/integrations/ia", () => ({ servicoIa: () => null }));

const SEGREDO = "segredo-do-app";
const corpo = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "1000001" }, messages: [{ id: "wamid.1", from: "5571999990001", type: "text", text: { body: "Oi" } }] } }] }],
});
const post = (c: string, assinatura: string | null) =>
  new Request("https://app.law.test/api/whatsapp", { method: "POST", headers: assinatura ? { "x-hub-signature-256": assinatura } : {}, body: c });

beforeEach(() => {
  processar.mockClear();
  process.env.WHATSAPP_APP_SECRET = SEGREDO;
  process.env.WHATSAPP_VERIFY_TOKEN = "token-de-verificacao";
});

describe("/api/whatsapp", () => {
  it("sem assinatura, com assinatura errada ou corpo alterado: 401 e nada é processado", async () => {
    const { POST } = await import("@/app/api/whatsapp/route");
    expect((await POST(post(corpo, null))).status).toBe(401);
    expect((await POST(post(corpo, assinar(corpo, "outro-segredo")))).status).toBe(401);
    expect((await POST(post(corpo + " ", assinar(corpo, SEGREDO)))).status).toBe(401);
    expect(processar).not.toHaveBeenCalled();
  });

  it("assinatura certa: 200 e a mensagem vai para a recepcionista", async () => {
    const { POST } = await import("@/app/api/whatsapp/route");
    expect((await POST(post(corpo, assinar(corpo, SEGREDO)))).status).toBe(200);
    expect(processar).toHaveBeenCalledTimes(1);
  });

  it("assinatura certa mas formato desconhecido: 200 (a Meta não reenvia) e nada é processado", async () => {
    const { POST } = await import("@/app/api/whatsapp/route");
    const estranho = JSON.stringify({ object: "instagram", entry: [] });
    expect((await POST(post(estranho, assinar(estranho, SEGREDO)))).status).toBe(200);
    expect(processar).not.toHaveBeenCalled();
  });

  it("falha interna devolve 500 para a Meta reenviar", async () => {
    const { POST } = await import("@/app/api/whatsapp/route");
    processar.mockRejectedValueOnce(new Error("banco fora"));
    expect((await POST(post(corpo, assinar(corpo, SEGREDO)))).status).toBe(500);
  });

  it("sem segredo configurado: 503 (nunca aceita sem poder conferir)", async () => {
    const { POST } = await import("@/app/api/whatsapp/route");
    delete process.env.WHATSAPP_APP_SECRET;
    expect((await POST(post(corpo, assinar(corpo, "")))).status).toBe(503);
  });

  it("verificação GET: devolve o desafio só com o token certo", async () => {
    const { GET } = await import("@/app/api/whatsapp/route");
    const url = (t: string) => new Request(`https://app.law.test/api/whatsapp?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=777`);
    const ok = await GET(url("token-de-verificacao"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("777");
    expect((await GET(url("errado"))).status).toBe(403);
  });
});
