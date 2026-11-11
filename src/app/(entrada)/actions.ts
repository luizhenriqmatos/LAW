"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { criarClienteServidor } from "@/lib/supabase/servidor";
import { caminhoSeguro, mensagemDeErro } from "@/lib/erros";
import { esquemaLogin } from "@/lib/validacao";
import type { EstadoFormulario } from "@/components/formulario";

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Endereço do site para os links do e-mail. Vem de NEXT_PUBLIC_SITE_URL; em produção nunca devolve localhost. */
async function origem() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const hostLocal = LOCAL.test(host);
  const configurada = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (configurada && (hostLocal || !/\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(configurada))) return configurada;
  return `${hostLocal ? (h.get("x-forwarded-proto") ?? "http") : "https"}://${host}`;
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
  return { ok: `Enviamos um link de acesso para ${email.data}. Abra o link neste mesmo aparelho e navegador. Se não chegar em 2 minutos, olhe o spam.` };
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
  // Com confirmação de e-mail ligada, o Supabase devolve um usuário "de mentira" sem identidades quando o e-mail já tem conta.
  // Decisão do dono (P-097): avisar de forma explícita, mesmo que isso revele que o e-mail tem conta.
  if (data.user && (data.user.identities?.length ?? 0) === 0) {
    return { erro: "Este e-mail já tem conta. Entre com sua senha ou use o link no e-mail na tela de entrada." };
  }
  return {
    ok: `Falta um passo: confirme seu e-mail. Enviamos um link para ${r.data.email}. Abra o link neste mesmo aparelho e depois entre com sua senha. Se não chegar em 2 minutos, olhe o spam.`,
  };
}

export async function sair() {
  const supabase = await criarClienteServidor();
  await supabase.auth.signOut();
  redirect("/entrar");
}
