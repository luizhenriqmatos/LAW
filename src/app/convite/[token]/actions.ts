"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { COOKIE_ESCRITORIO } from "@/lib/contexto";
import { mensagemDeErro } from "@/lib/erros";
import { criarClienteServidor } from "@/lib/supabase/servidor";
import type { EstadoFormulario } from "@/components/formulario";

export async function aceitarConvite(_: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  const token = z.string().regex(/^[0-9a-f]{64}$/).safeParse(dados.get("token"));
  if (!token.success) return { erro: "Convite inválido." };
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc("aceitar_convite", { p_token: token.data });
  if (error) return { erro: mensagemDeErro(error) };
  (await cookies()).set(COOKIE_ESCRITORIO, String(data), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  redirect("/app");
}
