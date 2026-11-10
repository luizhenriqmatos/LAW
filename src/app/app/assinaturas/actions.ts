"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { byteaDeBytes } from "@/lib/assinatura/bytea";
import { finalizarEnvelope } from "@/lib/assinatura/finalizar";
import { LIMITE_PDF_BYTES, sha256Hex, validarPdf } from "@/lib/assinatura/pdf";
import { EnvelopeCriado, LinkEmitido, SignatarioEntrada } from "@/lib/assinatura/tipos";
import { exigirModulo } from "@/lib/contexto";
import { baixarArquivo } from "@/lib/drive/arquivos";
import { depsDriveDoAmbiente, driveConfigurado } from "@/lib/drive/ambiente";
import { codigoDeErro } from "@/lib/erros";
import { servicoEmail } from "@/lib/integrations/email";
import { hashDoToken, novoToken } from "@/lib/portal/token";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

const RAIZ = "/app/assinaturas";
const uuid = z.uuid();

async function origem() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

function voltar(destino: string, aviso: string): never {
  revalidatePath(RAIZ, "layout");
  redirect(`${destino}${destino.includes("?") ? "&" : "?"}aviso=${encodeURIComponent(aviso)}`);
}

/** Gera o link de UM signatário, manda o e-mail e registra o envio como evidência. Devolve o link (para copiar se o e-mail falhar). */
async function emitirEEnviar(
  signatarioId: string,
  emitir: (hash: string) => Promise<unknown>,
): Promise<{ enviado: boolean; link: string }> {
  const token = novoToken();
  const r = LinkEmitido.parse(await emitir(hashDoToken(token)));
  const link = `${await origem()}/assinar/${token}`;
  const envio = await servicoEmail().enviarLinkAssinatura({ para: r.email, nome: r.nome, escritorio: r.escritorio, titulo: r.titulo, link, validadeDias: 7 });
  await rpcServico()("assinatura_registrar_envio", { p_signatario: signatarioId, p_enviado: envio.enviado, p_motivo: envio.enviado ? null : envio.motivo });
  return { enviado: envio.enviado, link };
}

type Cliente = Awaited<ReturnType<typeof exigirModulo>>["supabase"];

/** Emite o link PELO usuário logado: o banco confere a permissão do módulo Assinaturas. */
const emissor = (supabase: Cliente, signatarioId: string) => async (hash: string): Promise<unknown> => {
  const { data, error } = await supabase.rpc("assinatura_emitir_link", { p_signatario: signatarioId, p_token_hash: hash });
  if (error) throw error;
  return data;
};

function lerSignatarios(d: FormData) {
  const nomes = d.getAll("sig_nome"), emails = d.getAll("sig_email"), ordens = d.getAll("sig_ordem");
  const lista = [];
  for (let i = 0; i < nomes.length; i++) {
    const nome = String(nomes[i] ?? "").trim(), email = String(emails[i] ?? "").trim();
    if (!nome && !email) continue; // linha vazia do formulário
    const ordem = String(ordens[i] ?? "").trim();
    lista.push({ nome, email, ordem: ordem === "" ? 1 : Number(ordem) });
  }
  return z.array(SignatarioEntrada).min(1).max(20).safeParse(lista);
}

/**
 * Cria o envelope: valida o PDF, o banco calcula o hash e congela o arquivo, e cada signatário que já está na vez recebe o link.
 * O PDF vem do upload ou de um arquivo da pasta do processo no Drive.
 */
export async function criarEnvelope(dados: FormData) {
  const { supabase, vinculo } = await exigirModulo("assinaturas");
  if (!servicoConfigurado()) voltar(RAIZ, "erro_assinatura_nao_configurada");

  const titulo = z.string().trim().min(3).max(200).safeParse(dados.get("titulo"));
  if (!titulo.success) voltar(RAIZ, "erro_titulo_invalido");
  const sigs = lerSignatarios(dados);
  if (!sigs.success) voltar(RAIZ, "erro_signatarios_invalidos");
  const processoBruto = String(dados.get("processo") ?? "");
  const processo = uuid.safeParse(processoBruto).success ? processoBruto : null;

  let bytes: Uint8Array, nome: string;
  const arquivo = dados.get("arquivo");
  const doDrive = String(dados.get("arquivo_drive") ?? "");
  if (arquivo instanceof File && arquivo.size > 0) {
    if (arquivo.size > LIMITE_PDF_BYTES) voltar(RAIZ, "erro_pdf_invalido");
    bytes = new Uint8Array(await arquivo.arrayBuffer());
    nome = arquivo.name;
  } else if (doDrive && processo) {
    if (!driveConfigurado()) voltar(RAIZ, "erro_drive_nao_configurado");
    const { data: pasta, error } = await supabase.rpc("assinatura_pasta_processo", { p_processo: processo });
    if (error || !pasta) voltar(RAIZ, "erro_drive_sem_pasta");
    const baixado = await baixarArquivo(depsDriveDoAmbiente(), (pasta as { escritorio_id: string }).escritorio_id, doDrive);
    if (!baixado.ok) voltar(RAIZ, `erro_${baixado.codigo}`);
    const lido = new Uint8Array(await new Response(baixado.dados.corpo).arrayBuffer());
    bytes = lido;
    nome = baixado.dados.nome;
  } else {
    voltar(RAIZ, "erro_pdf_invalido");
  }
  if (!(await validarPdf(bytes)).ok) voltar(RAIZ, "erro_pdf_invalido");

  const { data, error } = await supabase.rpc("assinatura_criar", {
    p_escritorio: vinculo.escritorioId,
    p_titulo: titulo.data,
    p_nome_arquivo: nome,
    p_pdf: byteaDeBytes(bytes),
    p_processo: processo,
    p_signatarios: sigs.data,
  });
  if (error) voltar(RAIZ, `erro_${codigoDeErro(error)}`);
  const env = EnvelopeCriado.parse(data);
  // Confere: o hash que o banco calculou é o do arquivo que o servidor tinha.
  if (env.hash_original !== sha256Hex(bytes)) voltar(`${RAIZ}/${env.id}`, "erro_envelope_invalido");

  let falhas = 0;
  for (const s of env.signatarios.filter((x) => x.vez)) {
    const { enviado } = await emitirEEnviar(s.id, emissor(supabase, s.id));
    if (!enviado) falhas++;
  }
  voltar(`${RAIZ}/${env.id}`, falhas ? "assinatura_criada_sem_email" : "assinatura_criada");
}

/** Novo link para quem perdeu ou deixou vencer (o link anterior deixa de valer). */
export async function reenviarLink(envelopeId: string, signatarioId: string, dados: FormData) {
  void dados;
  const { supabase } = await exigirModulo("assinaturas");
  const destino = `${RAIZ}/${envelopeId}`;
  if (!uuid.safeParse(signatarioId).success || !servicoConfigurado()) voltar(destino, "erro_dados_invalidos");
  try {
    const r = await emitirEEnviar(signatarioId, emissor(supabase, signatarioId));
    voltar(destino, r.enviado ? "assinatura_reenviada" : "assinatura_reenviada_sem_email");
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // redirect do Next
    voltar(destino, `erro_${codigoDeErro(e as { message?: string })}`);
  }
}

export async function cancelarEnvelope(envelopeId: string) {
  const { supabase } = await exigirModulo("assinaturas");
  const destino = `${RAIZ}/${envelopeId}`;
  if (!uuid.safeParse(envelopeId).success) voltar(RAIZ, "erro_dados_invalidos");
  const { error } = await supabase.rpc("assinatura_cancelar", { p_envelope: envelopeId });
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "assinatura_cancelada");
}

/** Para o caso raro de todos terem assinado mas o PDF final não ter saído (queda no meio). Também roda no cron. */
export async function gerarPdfFinal(envelopeId: string) {
  const { supabase } = await exigirModulo("assinaturas");
  const destino = `${RAIZ}/${envelopeId}`;
  if (!uuid.safeParse(envelopeId).success || !servicoConfigurado()) voltar(destino, "erro_dados_invalidos");
  // Só quem enxerga o envelope (RLS) pode pedir.
  const { data } = await supabase.from("assinatura_envelope").select("id").eq("id", envelopeId).maybeSingle();
  if (!data) voltar(RAIZ, "erro_envelope_invalido");
  const r = await finalizarEnvelope(rpcServico(), envelopeId);
  voltar(destino, r.ok ? "assinatura_concluida" : "erro_envelope_encerrado");
}
