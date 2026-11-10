"use server";

import { sha256Hex } from "@/lib/assinatura/pdf";
import { Verificacao } from "@/lib/assinatura/tipos";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

export type EstadoVerificacao = { erro?: string; hash?: string; resultado?: Verificacao } | undefined;

const LIMITE = 5 * 1024 * 1024;

/** Calcula o SHA-256 do arquivo enviado e confere com o que ficou registrado. O arquivo não é guardado. */
export async function verificarArquivo(_: EstadoVerificacao, dados: FormData): Promise<EstadoVerificacao> {
  const arquivo = dados.get("arquivo");
  if (!(arquivo instanceof File) || arquivo.size === 0) return { erro: "Escolha o PDF assinado que você quer conferir." };
  if (arquivo.size > LIMITE) return { erro: "O arquivo é grande demais (máximo 5 MB)." };
  if (!servicoConfigurado()) return { erro: "A verificação ainda não está disponível." };
  const hash = sha256Hex(new Uint8Array(await arquivo.arrayBuffer()));
  const resultado = Verificacao.parse(await rpcServico()("assinatura_verificar", { p_hash: hash }));
  return { hash, resultado };
}
