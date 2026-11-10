"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { dispararCaptura } from "@/lib/captura/disparar";
import { COOKIE_ESCRITORIO, exigirDono, obterContexto } from "@/lib/contexto";
import { mensagemDeErro } from "@/lib/erros";
import { esquemaEscritorio, esquemaMonitoramento } from "@/lib/validacao";
import type { EstadoFormulario } from "@/components/formulario";

export async function criarEscritorio(_: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  const r = esquemaEscritorio.safeParse({ nome: dados.get("nome"), cnpj: dados.get("cnpj") ?? "", plano: dados.get("plano") });
  if (!r.success) return { erro: r.error.issues[0].message };
  const { supabase } = await obterContexto();
  const { data, error } = await supabase.rpc("criar_escritorio", { p_nome: r.data.nome, p_cnpj: r.data.cnpj, p_plano: r.data.plano });
  if (error) return { erro: mensagemDeErro(error) };
  (await cookies()).set(COOKIE_ESCRITORIO, String(data), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  redirect("/onboarding/monitoramento");
}

export async function salvarMonitoramento(_: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  let bruto: unknown;
  try {
    bruto = JSON.parse(String(dados.get("dados") ?? ""));
  } catch {
    return { erro: "Não foi possível ler o formulário. Tente de novo." };
  }
  const r = esquemaMonitoramento.safeParse(bruto);
  if (!r.success) return { erro: r.error.issues[0].message };
  const { supabase, vinculo } = await exigirDono();
  const alvos = r.data.modo === "oab" ? r.data.oabs : [{ cnpj: r.data.cnpj, nome: r.data.nome }];
  const { error } = await supabase.rpc("salvar_monitoramento", { p_escritorio: vinculo.escritorioId, p_modo: r.data.modo, p_alvos: alvos });
  if (error) return { erro: mensagemDeErro(error) };
  // Primeira captura logo após o onboarding, sem segurar a resposta. Falha fica registrada em captura_execucao.
  const escritorioId = vinculo.escritorioId;
  after(async () => {
    try {
      await dispararCaptura(escritorioId, "onboarding");
    } catch {
      // registrado pelo job; a tela "buscando" mostra o status
    }
  });
  redirect("/onboarding/buscando");
}
