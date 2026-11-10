import { NextResponse } from "next/server";
import { servicoWhatsapp } from "@/lib/integrations/whatsapp";
import { servicoIa } from "@/lib/integrations/ia";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";
import { assinaturaValida, desafioDeVerificacao } from "@/lib/whatsapp/assinatura";
import { extrairEventos } from "@/lib/whatsapp/payload";
import { classificadorComIa, processarEventos } from "@/lib/whatsapp/processar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";

/** Verificação do webhook (a Meta chama uma vez ao cadastrar a URL). */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const desafio = desafioDeVerificacao(
    { modo: u.searchParams.get("hub.mode"), token: u.searchParams.get("hub.verify_token"), desafio: u.searchParams.get("hub.challenge") },
    process.env.WHATSAPP_VERIFY_TOKEN ?? "",
  );
  return desafio === null ? new NextResponse("Forbidden", { status: 403 }) : new NextResponse(desafio, { status: 200, headers: { "Content-Type": "text/plain" } });
}

/**
 * Mensagens e recibos. A assinatura é conferida ANTES de ler o JSON: sem ela (ou com segredo errado) nada é gravado.
 * Resposta 200 diz "recebi"; 5xx faz a Meta reenviar (a mensagem é idempotente pelo id dela).
 */
export async function POST(req: Request) {
  const segredo = process.env.WHATSAPP_APP_SECRET ?? "";
  if (!segredo || !servicoConfigurado()) return NextResponse.json({ erro: "nao_configurado" }, { status: 503 });
  const bruto = await req.text();
  if (bruto.length > 1_000_000) return NextResponse.json({ erro: "grande_demais" }, { status: 413 });
  if (!assinaturaValida(bruto, req.headers.get("x-hub-signature-256"), segredo)) {
    return NextResponse.json({ erro: "assinatura_invalida" }, { status: 401 });
  }
  let eventos;
  try {
    eventos = extrairEventos(JSON.parse(bruto));
  } catch {
    // Assinatura boa mas formato desconhecido: 200 para a Meta não ficar reenviando algo que nunca vamos entender.
    return NextResponse.json({ ok: true, ignorado: "formato" }, { status: 200 });
  }
  try {
    const ia = servicoIa();
    await processarEventos(
      { rpc: rpcServico(), whatsapp: servicoWhatsapp(), classificar: ia ? classificadorComIa(ia) : undefined },
      eventos,
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    console.error("[whatsapp] falha ao tratar webhook:", e instanceof Error ? e.message : e);
    return NextResponse.json({ erro: "falha_interna" }, { status: 500 });
  }
}
