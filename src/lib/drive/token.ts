import type { ChamarRpc } from "@/lib/captura/job";
import { ErroGoogle } from "@/lib/integrations/google/erro";
import { cifrar, decifrar } from "@/lib/integrations/google/cripto";
import type { GoogleDriveApi } from "@/lib/integrations/google/drive-api";

export type Renovar = (refreshToken: string) => Promise<{ accessToken: string; expiraEm: Date }>;

export type DepsDrive = {
  rpc: ChamarRpc;
  api: GoogleDriveApi;
  renovar: Renovar;
  chave: Buffer;
  agora?: () => Date;
};

export type ConexaoDrive = {
  escritorio_id: string;
  usuario_id: string;
  refresh_token_cifrado: string;
  access_token_cifrado: string | null;
  access_expira_em: string | null;
  raiz_id: string;
  clientes_id: string;
  status: "ativa" | "revogada" | "erro";
  erro: string | null;
};

export async function obterConexao(rpc: ChamarRpc, escritorioId: string): Promise<ConexaoDrive | null> {
  return (await rpc<ConexaoDrive | null>("drive_conexao_obter", { p_escritorio: escritorioId })) ?? null;
}

/**
 * Sessão de uma conexão: entrega um token de acesso válido (renova se preciso, guardando cifrado) e repete uma vez
 * se o Google recusar o token (401). Falha de renovação por revogação sobe como ErroGoogle("revogado").
 */
export function abrirSessao(deps: DepsDrive, c: ConexaoDrive) {
  const agora = deps.agora ?? (() => new Date());
  let atual: string | null = null;

  async function token(forcar = false): Promise<string> {
    if (!forcar) {
      if (atual) return atual;
      if (c.access_token_cifrado && c.access_expira_em && new Date(c.access_expira_em).getTime() - agora().getTime() > 60_000) {
        atual = decifrar(c.access_token_cifrado, deps.chave);
        return atual;
      }
    }
    const novo = await deps.renovar(decifrar(c.refresh_token_cifrado, deps.chave));
    atual = novo.accessToken;
    c.access_token_cifrado = cifrar(novo.accessToken, deps.chave);
    c.access_expira_em = novo.expiraEm.toISOString();
    await deps.rpc("drive_conexao_tokens", { p_escritorio: c.escritorio_id, p_access_cifrado: c.access_token_cifrado, p_expira: c.access_expira_em });
    return atual;
  }

  async function comToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await token());
    } catch (e) {
      if (e instanceof ErroGoogle && e.codigo === "nao_autorizado") return fn(await token(true));
      throw e;
    }
  }
  return { comToken };
}
