"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { exigirEscritorio } from "@/lib/contexto";
import { codigoDeErro } from "@/lib/erros";
import { servicoWhatsapp } from "@/lib/integrations/whatsapp";

const ver = (id: string, aviso: string): never => {
  revalidatePath(`/app/atendimentos/${id}`);
  redirect(`/app/atendimentos/${id}?aviso=${encodeURIComponent(aviso)}`);
};
const voltarConfig = (aviso: string): never => {
  revalidatePath("/app/atendimentos/configurar");
  redirect(`/app/atendimentos/configurar?aviso=${encodeURIComponent(aviso)}`);
};
const uuid = z.uuid();

export async function assumirAtendimento(id: string) {
  if (!uuid.safeParse(id).success) redirect("/app/atendimentos");
  const { supabase } = await exigirEscritorio();
  const { error } = await supabase.rpc("atendimento_assumir", { p_id: id });
  ver(id, error ? `erro_${codigoDeErro(error)}` : "assumido");
}

/** Encerrar devolve a conversa à recepcionista: a próxima mensagem da pessoa abre um atendimento novo. */
export async function encerrarAtendimento(id: string) {
  if (!uuid.safeParse(id).success) redirect("/app/atendimentos");
  const { supabase } = await exigirEscritorio();
  const { error } = await supabase.rpc("atendimento_encerrar", { p_id: id });
  ver(id, error ? `erro_${codigoDeErro(error)}` : "encerrado");
}

type Preparo = {
  mensagem_id: string; modo: "texto" | "modelo"; telefone: string; phone_number_id: string; texto: string | null;
  modelo: string | null; idioma: string; escritorio_nome: string;
};

/**
 * Resposta do humano. Dentro de 24 h da última mensagem da pessoa vai o texto; fora, o banco recusa o texto e só
 * o modelo aprovado pode ser enviado (campo "texto" vazio).
 */
export async function responderAtendimento(id: string, dados: FormData) {
  if (!uuid.safeParse(id).success) redirect("/app/atendimentos");
  const texto = String(dados.get("texto") ?? "").slice(0, 4096);
  const { supabase } = await exigirEscritorio();
  const { data, error } = await supabase.rpc("atendimento_preparar_envio", { p_id: id, p_texto: texto.trim() ? texto : null });
  if (error) ver(id, `erro_${codigoDeErro(error)}`);
  const p = data as Preparo;
  const zap = servicoWhatsapp();
  const r = p.modo === "texto"
    ? await zap.enviarTexto({ phoneNumberId: p.phone_number_id, para: p.telefone, texto: p.texto ?? "" })
    : await zap.enviarModelo({ phoneNumberId: p.phone_number_id, para: p.telefone, modelo: p.modelo ?? "", idioma: p.idioma, parametros: [] });
  await supabase.rpc("atendimento_envio_resultado", {
    p_mensagem: p.mensagem_id, p_wamid: r.ok ? r.wamid : null, p_ok: r.ok, p_erro: r.ok ? null : r.motivo,
  });
  ver(id, r.ok ? "enviado" : "erro_envio_falhou");
}

export async function lerAtendimento(id: string) {
  if (!uuid.safeParse(id).success) return;
  const { supabase } = await exigirEscritorio();
  await supabase.rpc("atendimento_marcar_lido", { p_id: id });
}

const configSchema = z.object({
  ativa: z.boolean(),
  responsavel_id: z.union([z.uuid(), z.literal("")]),
  prazo_resposta_texto: z.string().max(160),
  horario_texto: z.string().max(160),
  modelo_retomada: z.string().max(200).regex(/^[a-z0-9_]*$/),
  modelo_idioma: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/),
});

export async function salvarConfiguracao(dados: FormData) {
  const { supabase, vinculo } = await exigirEscritorio();
  const p = configSchema.safeParse({
    ativa: dados.get("ativa") === "on",
    responsavel_id: String(dados.get("responsavel_id") ?? ""),
    prazo_resposta_texto: String(dados.get("prazo_resposta_texto") ?? "").trim(),
    horario_texto: String(dados.get("horario_texto") ?? "").trim(),
    modelo_retomada: String(dados.get("modelo_retomada") ?? "").trim(),
    modelo_idioma: String(dados.get("modelo_idioma") ?? "pt_BR").trim() || "pt_BR",
  });
  if (!p.success) return voltarConfig("erro_dados_invalidos");
  const { error } = await supabase.rpc("recepcao_config_salvar", { p_escritorio: vinculo.escritorioId, p_dados: p.data });
  voltarConfig(error ? `erro_${codigoDeErro(error)}` : "config_salva");
}

export async function salvarNumero(dados: FormData) {
  const { supabase, vinculo } = await exigirEscritorio();
  const p = z.object({ phone_number_id: z.string().regex(/^\d{5,24}$/), exibicao: z.string().max(30) })
    .safeParse({ phone_number_id: String(dados.get("phone_number_id") ?? "").trim(), exibicao: String(dados.get("exibicao") ?? "").trim() });
  if (!p.success) return voltarConfig("erro_dados_invalidos");
  const { error } = await supabase.rpc("whatsapp_numero_salvar", {
    p_escritorio: vinculo.escritorioId, p_phone_number_id: p.data.phone_number_id, p_numero_exibicao: p.data.exibicao, p_ativo: dados.get("ativo") === "on",
  });
  voltarConfig(error ? `erro_${codigoDeErro(error)}` : "numero_salvo");
}
