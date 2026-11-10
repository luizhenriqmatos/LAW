"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { enviarArquivo } from "@/lib/drive/arquivos";
import { depsDriveDoAmbiente, driveConfigurado } from "@/lib/drive/ambiente";
import { exigirDono, exigirEscritorio } from "@/lib/contexto";
import { caminhoSeguro, codigoDeErro } from "@/lib/erros";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

const uuid = z.uuid();
const DOCUMENTOS = "/app/documentos";

function voltar(destino: string, aviso: string): never {
  revalidatePath("/app/documentos", "layout");
  revalidatePath("/app/processos", "layout");
  const seguro = caminhoSeguro(destino, DOCUMENTOS).replace(/([?&])aviso=[^&]*&?/g, "$1").replace(/[?&]$/, "");
  redirect(`${seguro}${seguro.includes("?") ? "&" : "?"}aviso=${encodeURIComponent(aviso)}`);
}

/**
 * Envia um arquivo para a pasta do cliente/processo no Drive do escritório.
 * Quem pode: quem tem Processos ou Documentos (o banco confere em `drive_pasta_de`). O token do Drive nunca sai do servidor.
 */
export async function enviarArquivoDrive(tipo: "cliente" | "processo", refId: string, destino: string, dados: FormData) {
  if ((tipo !== "cliente" && tipo !== "processo") || !uuid.safeParse(refId).success) voltar(destino, "erro_dados_invalidos");
  const { supabase } = await exigirEscritorio();
  const arquivo = dados.get("arquivo");
  if (!(arquivo instanceof File) || arquivo.size === 0) voltar(destino, "erro_arquivo_vazio");
  if (!driveConfigurado() || !servicoConfigurado()) voltar(destino, "erro_drive_nao_configurado");

  const { data: pasta, error } = await supabase.rpc("drive_pasta_de", { p_tipo: tipo, p_ref: refId });
  if (error) voltar(destino, `erro_${codigoDeErro(error)}`);
  const p = pasta as { escritorio_id: string; drive_id: string } | null;
  if (!p) voltar(destino, "erro_drive_sem_pasta");

  const r = await enviarArquivo(depsDriveDoAmbiente(), p.escritorio_id, p.drive_id, {
    nome: arquivo.name,
    tipo: arquivo.type,
    dados: new Uint8Array(await arquivo.arrayBuffer()),
  });
  voltar(destino, r.ok ? "arquivo_enviado" : `erro_${r.codigo}`);
}

/**
 * Desconecta o Drive do escritório (só o dono). NÃO apaga nada no Drive: as pastas e arquivos continuam lá;
 * o LAW só desvincula. Não revoga o token no Google de propósito: o Google pode ligar o mesmo consentimento
 * ao Google Agenda da mesma pessoa, e revogar derrubaria os dois (PENDENCIA P-036).
 */
export async function desconectarDrive() {
  const { vinculo } = await exigirDono();
  if (servicoConfigurado()) await rpcServico()("drive_conexao_remover", { p_escritorio: vinculo.escritorioId });
  voltar(DOCUMENTOS, "drive_desconectado_ok");
}
