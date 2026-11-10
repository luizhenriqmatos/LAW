import type { ChamarRpc } from "@/lib/captura/job";
import { ErroGoogle } from "@/lib/integrations/google/erro";
import { cifrar, decifrar } from "@/lib/integrations/google/cripto";
import type { GoogleDriveApi } from "@/lib/integrations/google/drive-api";
import type { Tokens } from "@/lib/integrations/google/oauth";
import { CLIENTES, marcaRaiz, RAIZ } from "./nomes";
import { obterConexao } from "./token";

/**
 * Fecha a conexão depois do consentimento: cria (ou reaproveita) "LAW" e "LAW/Clientes" no Drive do escritório,
 * grava os tokens CIFRADOS e deixa todos os clientes/processos já confirmados na fila.
 * Com drive.file o LAW só enxerga o que ele mesmo criou: uma pasta "LAW" feita à mão antes NÃO é vista (fica ao lado).
 */
// PENDENCIA P-035: pasta "LAW" criada à mão antes não é vista pelo app (limite do drive.file).
export async function concluirConexaoDrive(p: {
  rpc: ChamarRpc; api: GoogleDriveApi; chave: Buffer;
  escritorioId: string; usuarioId: string; tokens: Tokens;
}): Promise<{ raizId: string; clientesId: string }> {
  const { rpc, api, chave, tokens } = p;
  const existente = await obterConexao(rpc, p.escritorioId);
  let refresh = tokens.refreshToken;
  if (!refresh && existente) refresh = decifrar(existente.refresh_token_cifrado, chave);
  if (!refresh) throw new ErroGoogle("sem_refresh", "O Google não enviou a permissão de uso contínuo. Tente conectar de novo.");

  const t = tokens.accessToken;
  const garantir = async (nome: string, pai: string | null, marca: string) => {
    const achada = await api.buscarPorMarca(t, marca);
    return achada ? achada.id : (await api.criarPasta(t, nome, pai, marca)).id;
  };
  const raizId = await garantir(RAIZ, null, marcaRaiz(p.escritorioId, "raiz"));
  const clientesId = await garantir(CLIENTES, raizId, marcaRaiz(p.escritorioId, "clientes"));

  await rpc("drive_conexao_salvar", {
    p_escritorio: p.escritorioId, p_usuario: p.usuarioId,
    p_refresh_cifrado: cifrar(refresh, chave), p_access_cifrado: cifrar(t, chave), p_expira: tokens.expiraEm.toISOString(),
    p_raiz: raizId, p_clientes: clientesId,
  });
  return { raizId, clientesId };
}
