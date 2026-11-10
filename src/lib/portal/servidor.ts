import "server-only";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";
import { DocumentoPortal, InicioPortal, ProcessoPortal } from "./tipos";
import { hashDaSessao, ipAtual } from "./sessao";

export { servicoConfigurado as portalConfigurado };

/** Lista do cliente. null = sem sessão válida (o chamador manda para a tela de entrar). */
export async function carregarInicio() {
  const hash = await hashDaSessao();
  if (!hash || !servicoConfigurado()) return null;
  const r = InicioPortal.parse(await rpcServico()("portal_inicio", { p_sessao_hash: hash, p_ip: await ipAtual() }));
  return r.ok ? r : null;
}

export type ResultadoProcesso = { estado: "sem_sessao" } | { estado: "nao_encontrado" } | { estado: "ok"; dados: Extract<ProcessoPortal, { ok: true }> };

export async function carregarProcesso(processoId: string): Promise<ResultadoProcesso> {
  const hash = await hashDaSessao();
  if (!hash || !servicoConfigurado()) return { estado: "sem_sessao" };
  const r = ProcessoPortal.parse(await rpcServico()("portal_processo", { p_sessao_hash: hash, p_processo: processoId, p_ip: await ipAtual() }));
  if (r.ok) return { estado: "ok", dados: r };
  // O banco responde igual para "não liberado", "segredo de justiça" e "não existe".
  return { estado: r.motivo === "sessao" ? "sem_sessao" : "nao_encontrado" };
}

export async function obterDocumento(processoId: string, documentoId: string) {
  const hash = await hashDaSessao();
  if (!hash || !servicoConfigurado()) return null;
  const r = DocumentoPortal.parse(
    await rpcServico()("portal_documento_obter", { p_sessao_hash: hash, p_processo: processoId, p_documento: documentoId, p_ip: await ipAtual() }),
  );
  return r.ok ? r : null;
}
