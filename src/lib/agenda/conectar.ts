import type { ChamarRpc } from "@/lib/captura/job";
import type { GoogleAgendaApi } from "@/lib/integrations/google/agenda-api";
import { ErroGoogle } from "@/lib/integrations/google/erro";
import { cifrar, decifrar } from "@/lib/integrations/google/cripto";
import type { Tokens } from "@/lib/integrations/google/oauth";

export const NOME_CALENDARIO = "LAW";

/** Se o usuário tem mais de um escritório, o nome leva o escritório para os calendários não se confundirem. */
export function nomeDoCalendario(nomeEscritorio: string, variosEscritorios: boolean): string {
  return variosEscritorios ? `${NOME_CALENDARIO} – ${nomeEscritorio}`.slice(0, 100) : NOME_CALENDARIO;
}

/**
 * Fecha a conexão depois do consentimento: cria (ou reaproveita) o calendário "LAW" no Google do usuário,
 * grava os tokens CIFRADOS e deixa a primeira carga na fila.
 */
export async function concluirConexao(p: {
  rpc: ChamarRpc; api: GoogleAgendaApi; chave: Buffer;
  escritorioId: string; usuarioId: string; nomeCalendario: string;
  tokens: Tokens;
}): Promise<{ calendarioId: string; reaproveitado: boolean }> {
  const { rpc, api, chave, tokens } = p;
  const existente = await rpc<{ calendario_id: string; refresh_token_cifrado: string } | null>("google_conexao_obter", {
    p_usuario: p.usuarioId, p_escritorio: p.escritorioId,
  });
  // O Google só devolve refresh token no 1º consentimento (ou com prompt=consent). Sem ele não dá para sincronizar depois.
  let refresh = tokens.refreshToken;
  if (!refresh && existente) refresh = decifrar(existente.refresh_token_cifrado, chave);
  if (!refresh) throw new ErroGoogle("sem_refresh", "O Google não enviou a permissão de uso contínuo. Tente conectar de novo.");

  let calendarioId: string | null = null;
  let reaproveitado = false;
  if (existente?.calendario_id && (await api.calendarioExiste(tokens.accessToken, existente.calendario_id))) {
    calendarioId = existente.calendario_id;
    reaproveitado = true;
  }
  if (!calendarioId) calendarioId = (await api.criarCalendario(tokens.accessToken, p.nomeCalendario)).id;

  await rpc("google_conexao_salvar", {
    p_escritorio: p.escritorioId,
    p_usuario: p.usuarioId,
    p_calendario_id: calendarioId,
    p_calendario_nome: p.nomeCalendario,
    p_refresh_cifrado: cifrar(refresh, chave),
    p_access_cifrado: cifrar(tokens.accessToken, chave),
    p_expira: tokens.expiraEm.toISOString(),
  });
  return { calendarioId, reaproveitado };
}
