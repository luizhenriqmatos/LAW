"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exigirDono } from "@/lib/contexto";
import { rodarRotinaEncerramento } from "@/lib/conta/rotina";
import { codigoDeErro } from "@/lib/erros";
import { servicoEmail } from "@/lib/integrations/email";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

const voltar = (aviso: string): never => {
  revalidatePath("/app", "layout");
  redirect(`/app/conta?aviso=${encodeURIComponent(aviso)}`);
};

/** Pedido de encerramento: o dono precisa digitar o nome do escritório. Começa o prazo de 30 dias (somente leitura). */
export async function solicitarEncerramento(dados: FormData) {
  const { supabase, vinculo } = await exigirDono();
  const digitado = String(dados.get("confirmacao") ?? "").trim();
  if (digitado.toLowerCase() !== vinculo.escritorioNome.trim().toLowerCase()) voltar("erro_confirmacao");
  const { error } = await supabase.rpc("encerramento_solicitar", { p_escritorio: vinculo.escritorioId });
  if (error) voltar(`erro_${codigoDeErro(error)}`);
  // Avisa na hora (a rotina diária repete se o e-mail não sair agora).
  if (servicoConfigurado()) {
    try { await rodarRotinaEncerramento(rpcServico(), servicoEmail(), new Date(), vinculo.escritorioId); } catch { /* a rotina diária tenta de novo */ }
  }
  voltar("encerramento_pedido");
}

export async function cancelarEncerramento() {
  const { supabase, vinculo } = await exigirDono();
  const { error } = await supabase.rpc("encerramento_cancelar", { p_escritorio: vinculo.escritorioId });
  voltar(error ? `erro_${codigoDeErro(error)}` : "encerramento_cancelado");
}
