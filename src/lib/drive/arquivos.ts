import { ErroGoogle } from "@/lib/integrations/google/erro";
import { linkDoDriveSeguro, MIME_PASTA, type ArquivoBaixado, type ArquivoDrive } from "@/lib/integrations/google/drive-api";
import { nomeDeArquivo } from "./nomes";
import { abrirSessao, obterConexao, type DepsDrive } from "./token";

/**
 * Limite por arquivo enviado pelo LAW. A Vercel recusa corpo de requisição acima de 4,5 MB em funções, então 4 MB deixa folga
 * para o formulário. Acima disso o escritório sobe direto no Drive (a pasta tem link). PENDENCIA P-038: envio direto do navegador.
 */
export const LIMITE_ARQUIVO_BYTES = 4 * 1024 * 1024;

export type ArquivoLista = { id: string; nome: string; pasta: boolean; tamanho: number | null; modificadoEm: string | null; link: string | null };

export type Resultado<T> = { ok: true; dados: T } | { ok: false; codigo: "drive_desconectado" | "drive_pasta_sumiu" | "drive_indisponivel" | "arquivo_grande" | "arquivo_vazio" | "erro_drive" };

/** Teto de um download pelo portal. PENDENCIA P-058: acima disso o cliente é orientado a pedir o arquivo ao escritório. */
export const LIMITE_DOWNLOAD_BYTES = 25 * 1024 * 1024;

function traduzir(e: unknown): Extract<Resultado<never>, { ok: false }> {
  if (e instanceof ErroGoogle) {
    if (e.codigo === "nao_encontrado") return { ok: false, codigo: "drive_pasta_sumiu" };
    if (e.codigo === "revogado") return { ok: false, codigo: "drive_desconectado" };
    if (e.codigo === "indisponivel" || e.codigo === "limite") return { ok: false, codigo: "drive_indisponivel" };
  }
  console.error("Drive:", e instanceof Error ? e.message : e);
  return { ok: false, codigo: "erro_drive" };
}

export function paraLista(a: ArquivoDrive): ArquivoLista {
  return {
    id: a.id,
    nome: a.name,
    pasta: a.mimeType === MIME_PASTA,
    tamanho: a.size ? Number(a.size) : null,
    modificadoEm: a.modifiedTime ?? null,
    link: linkDoDriveSeguro(a.webViewLink),
  };
}

/** Lista o que está dentro de uma pasta do LAW (só o que o próprio LAW criou/enviou: limite do escopo drive.file). */
export async function listarArquivos(deps: DepsDrive, escritorioId: string, pastaDriveId: string): Promise<Resultado<ArquivoLista[]>> {
  try {
    const c = await obterConexao(deps.rpc, escritorioId);
    if (!c || c.status !== "ativa") return { ok: false, codigo: "drive_desconectado" };
    const itens = await abrirSessao(deps, c).comToken((t) => deps.api.listar(t, pastaDriveId));
    return { ok: true, dados: itens.map(paraLista) };
  } catch (e) {
    return traduzir(e);
  }
}

export async function enviarArquivo(
  deps: DepsDrive, escritorioId: string, pastaDriveId: string,
  arquivo: { nome: string; tipo: string; dados: Uint8Array },
): Promise<Resultado<ArquivoLista>> {
  if (arquivo.dados.byteLength === 0) return { ok: false, codigo: "arquivo_vazio" };
  if (arquivo.dados.byteLength > LIMITE_ARQUIVO_BYTES) return { ok: false, codigo: "arquivo_grande" };
  try {
    const c = await obterConexao(deps.rpc, escritorioId);
    if (!c || c.status !== "ativa") return { ok: false, codigo: "drive_desconectado" };
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(arquivo.tipo) ? arquivo.tipo : "application/octet-stream";
    const criado = await abrirSessao(deps, c).comToken((t) => deps.api.enviar(t, pastaDriveId, nomeDeArquivo(arquivo.nome), mime, arquivo.dados));
    return { ok: true, dados: paraLista(criado) };
  } catch (e) {
    if (e instanceof ErroGoogle && e.codigo === "revogado") {
      await deps.rpc("drive_conexao_falhou", { p_escritorio: escritorioId, p_status: "revogada", p_erro: e.message });
    }
    return traduzir(e);
  }
}

/** Baixa UM arquivo do Drive do escritório para entregar ao cliente no portal. Quem autoriza é o banco (portal_documento_obter). */
export async function baixarArquivo(deps: DepsDrive, escritorioId: string, arquivoDriveId: string): Promise<Resultado<ArquivoBaixado>> {
  try {
    const c = await obterConexao(deps.rpc, escritorioId);
    if (!c || c.status !== "ativa") return { ok: false, codigo: "drive_desconectado" };
    const a = await abrirSessao(deps, c).comToken((t) => deps.api.baixar(t, arquivoDriveId));
    if (a.tamanho !== null && a.tamanho > LIMITE_DOWNLOAD_BYTES) {
      await a.corpo.cancel().catch(() => undefined);
      return { ok: false, codigo: "arquivo_grande" };
    }
    return { ok: true, dados: a };
  } catch (e) {
    return traduzir(e);
  }
}
