"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { criarClienteServidor } from "@/lib/supabase/servidor";
import { caminhoSeguro, mensagemDeErro } from "@/lib/erros";
import { esquemaLogin } from "@/lib/validacao";
import type { EstadoFormulario } from "@/components/formulario";

async function origem() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

export async function entrarComSenha(_: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  const r = esquemaLogin.safeParse({ email: dados.get("email"), senha: dados.get("senha") });
  if (!r.success) return { erro: r.error.issues[0].message };
  const supabase = await criarClienteServidor();
  const { error } = await supabase.auth.signInWithPassword({ email: r.data.email, password: r.data.senha });
  if (error) return { erro: mensagemDeErro(error) };
  redirect(caminhoSeguro(String(dados.get("proximo") ?? "")));
}

export async function enviarLinkDeAcesso(_: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  const email = z.string().trim().toLowerCase().email("E-mail inválido.").safeParse(dados.get("email"));
  if (!email.success) return { erro: email.error.issues[0].message };
  const proximo = caminhoSeguro(String(dados.get("proximo") ?? ""));
  const supabase = await criarClienteServidor();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.data,
    options: { emailRedirectTo: `${await origem()}/auth/confirmar?proximo=${encodeURIComponent(proximo)}`, shouldCreateUser: true },
  });
  if (error) return { erro: mensagemDeErro(error) };
  return { ok: "Enviamos um link de acesso para o seu e-mail. Abra no mesmo aparelho." };
}

export async function cadastrar(_: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  const r = esquemaLogin.safeParse({ email: dados.get("email"), senha: dados.get("senha") });
  if (!r.success) return { erro: r.error.issues[0].message };
  const proximo = caminhoSeguro(String(dados.get("proximo") ?? ""), "/onboarding");
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.auth.signUp({
    email: r.data.email,
    password: r.data.senha,
    options: { emailRedirectTo: `${await origem()}/auth/confirmar?proximo=${encodeURIComponent(proximo)}` },
  });
  if (error) return { erro: mensagemDeErro(error) };
  if (data.session) redirect(proximo);
  return { ok: "Conta criada. Confirme pelo link que enviamos para o seu e-mail." };
}

export async function sair() {
  const supabase = await criarClienteServidor();
  await supabase.auth.signOut();
  redirect("/entrar");
}
