"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { exigirDono } from "@/lib/contexto";
import { mensagemDeErro } from "@/lib/erros";
import { IDS_MODULOS, type ModuloId } from "@/lib/modulos";
import { esquemaConvite } from "@/lib/validacao";
import { servicoEmail } from "@/lib/integrations/email";
import type { EstadoFormulario } from "@/components/formulario";

const modulosDoForm = (dados: FormData) => dados.getAll("modulos").map(String);

async function origem() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

export async function convidar(_: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  const r = esquemaConvite.safeParse({ email: dados.get("email"), modulos: modulosDoForm(dados) });
  if (!r.success) return { erro: r.error.issues[0].message };
  const { supabase, vinculo } = await exigirDono();
  const { data: token, error } = await supabase.rpc("criar_convite", {
    p_escritorio: vinculo.escritorioId,
    p_email: r.data.email,
    p_modulos: r.data.modulos,
  });
  if (error) return { erro: mensagemDeErro(error) };

  const link = `${await origem()}/convite/${token}`;
  const validade = new Date(Date.now() + 7 * 864e5).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const envio = await servicoEmail().enviarConvite({ para: r.data.email, escritorio: vinculo.escritorioNome, link, validade });
  revalidatePath("/app/equipe");
  return envio.enviado
    ? { ok: `Convite enviado para ${r.data.email}. Vale até ${validade}.` }
    : { ok: `Convite criado, mas o e-mail NÃO foi enviado (${envio.motivo}). Copie o link abaixo e mande para ${r.data.email}. Vale até ${validade}.`, link };
}

export async function cancelarConvite(dados: FormData) {
  const id = z.string().uuid().parse(dados.get("id"));
  const { supabase, vinculo } = await exigirDono();
  await supabase.from("convite").update({ cancelado_em: new Date().toISOString() }).eq("id", id).eq("escritorio_id", vinculo.escritorioId);
  revalidatePath("/app/equipe");
}

export async function salvarPermissoes(_: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  const membroId = z.string().uuid().safeParse(dados.get("membro"));
  const pedidos = z.array(z.enum(IDS_MODULOS as [ModuloId, ...ModuloId[]])).safeParse(modulosDoForm(dados));
  if (!membroId.success || !pedidos.success) return { erro: "Dados inválidos." };
  const { supabase, vinculo } = await exigirDono();

  const { data: atuais, error: erroLeitura } = await supabase
    .from("permissao_tela")
    .select("modulo")
    .eq("membro_id", membroId.data)
    .eq("escritorio_id", vinculo.escritorioId);
  if (erroLeitura) return { erro: mensagemDeErro(erroLeitura) };

  const tem = new Set((atuais ?? []).map((p: { modulo: string }) => p.modulo));
  const quer = new Set<string>(pedidos.data);
  const remover = [...tem].filter((m) => !quer.has(m));
  const incluir = [...quer].filter((m) => !tem.has(m));

  if (remover.length) {
    const { error } = await supabase.from("permissao_tela").delete().eq("membro_id", membroId.data).in("modulo", remover);
    if (error) return { erro: mensagemDeErro(error) };
  }
  if (incluir.length) {
    const { error } = await supabase
      .from("permissao_tela")
      .insert(incluir.map((modulo) => ({ membro_id: membroId.data, escritorio_id: vinculo.escritorioId, modulo })));
    if (error) return { erro: mensagemDeErro(error) };
  }
  revalidatePath("/app/equipe");
  return { ok: "Permissões salvas." };
}

export async function removerMembro(dados: FormData) {
  const id = z.string().uuid().parse(dados.get("membro"));
  const { supabase, vinculo } = await exigirDono();
  await supabase.from("membro").delete().eq("id", id).eq("escritorio_id", vinculo.escritorioId).eq("papel", "membro");
  revalidatePath("/app/equipe");
}
