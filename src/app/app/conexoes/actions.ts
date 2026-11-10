"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { exigirEscritorio } from "@/lib/contexto";
import { codigoDeErro } from "@/lib/erros";

const voltar = (aviso: string): never => {
  revalidatePath("/app/conexoes");
  redirect(`/app/conexoes?aviso=${encodeURIComponent(aviso)}`);
};

/** Corta o acesso NA HORA: concessão revogada e todos os tokens dela invalidados no banco. */
export async function revogarConexao(id: string) {
  if (!z.uuid().safeParse(id).success) voltar("erro_nao_encontrado");
  const { supabase } = await exigirEscritorio();
  const { error } = await supabase.rpc("conexao_revogar", { p_concessao: id });
  voltar(error ? `erro_${codigoDeErro(error)}` : "conexao_revogada");
}

export async function configurarConectores(dados: FormData) {
  const { supabase, vinculo } = await exigirEscritorio();
  const { error } = await supabase.rpc("conectores_configurar", {
    p_escritorio: vinculo.escritorioId, p_ativos: dados.get("ativos") === "on", p_expor_sigilo: dados.get("expor_sigilo") === "on",
  });
  voltar(error ? `erro_${codigoDeErro(error)}` : "conectores_salvos");
}
