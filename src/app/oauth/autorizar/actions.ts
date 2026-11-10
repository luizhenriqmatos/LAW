"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { codigoDeErro } from "@/lib/erros";
import { recursoMcp, TODOS_ESCOPOS, urlBase } from "@/lib/oauth/config";
import { hashSegredo, novoSegredo } from "@/lib/oauth/cripto";
import { criarClienteServidor } from "@/lib/supabase/servidor";

const Pedido = z.object({
  client_id: z.string().min(1).max(100),
  redirect_uri: z.string().url().max(500),
  state: z.string().max(500).default(""),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  escritorio: z.uuid(),
  resource: z.string().max(500).default(""),
});

/** Só redireciona para endereço de retorno CADASTRADO pelo cliente (nunca para um endereço qualquer da URL). */
async function retornoValido(clientId: string, redirectUri: string) {
  const supabase = await criarClienteServidor();
  const { data } = await supabase.rpc("oauth_cliente_publico", { p_cliente: clientId });
  const c = data as { redirect_uris: string[] } | null;
  return { supabase, ok: !!c && c.redirect_uris.includes(redirectUri) };
}

function voltarAoCliente(redirectUri: string, params: Record<string, string>): never {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  redirect(u.toString());
}

export async function aprovarAcesso(dados: FormData) {
  const bruto = Object.fromEntries(dados.entries());
  const r = Pedido.safeParse(bruto);
  if (!r.success) redirect("/oauth/autorizar?erro=pedido_invalido");
  const p = r.data;
  const base = urlBase();
  if (!base) redirect("/oauth/autorizar?erro=nao_configurado");
  const { supabase, ok } = await retornoValido(p.client_id, p.redirect_uri);
  if (!ok) redirect("/oauth/autorizar?erro=cliente_invalido");
  const escopos = dados.getAll("escopo").map(String).filter((e) => (TODOS_ESCOPOS as string[]).includes(e));

  const codigo = novoSegredo();
  const { error } = await supabase.rpc("oauth_autorizar", {
    p_cliente: p.client_id, p_escritorio: p.escritorio, p_escopos: escopos, p_redirect_uri: p.redirect_uri,
    p_code_challenge: p.code_challenge, p_code_hash: hashSegredo(codigo), p_recurso: recursoMcp(base),
  });
  if (error) {
    const volta = new URLSearchParams({ ...Object.fromEntries(Object.entries(bruto).filter(([k, v]) => k !== "escopo" && typeof v === "string")) as Record<string, string> });
    volta.set("erro", codigoDeErro(error) === "falha" ? (error.message.match(/[a-z_]{6,}/)?.[0] ?? "falha") : codigoDeErro(error));
    redirect(`/oauth/autorizar?${volta.toString()}`);
  }
  voltarAoCliente(p.redirect_uri, { code: codigo, state: p.state, iss: base });
}

export async function negarAcesso(dados: FormData) {
  const clientId = String(dados.get("client_id") ?? "");
  const redirectUri = String(dados.get("redirect_uri") ?? "");
  const { ok } = await retornoValido(clientId, redirectUri);
  if (!ok) redirect("/app");
  voltarAoCliente(redirectUri, { error: "access_denied", error_description: "O usuário não autorizou.", state: String(dados.get("state") ?? ""), iss: urlBase() ?? "" });
}
