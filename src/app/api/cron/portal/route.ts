import { timingSafeEqual } from "node:crypto";
import { servicoIa } from "@/lib/integrations/ia";
import { gerarResumo } from "@/lib/portal/gerar";
import type { Movimento } from "@/lib/portal/linguagem";
import { impressaoDasMovimentacoes } from "@/lib/portal/resumo";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

/**
 * Job diário: gera resumo em linguagem simples dos processos liberados cujas movimentações mudaram desde o último resumo.
 * O banco decide o destino: rascunho (modo "revisar", ou qualquer alerta) ou publicação direta (modo "direto", sem alerta).
 * Processo em segredo de justiça nunca é listado por `portal_resumos_pendentes`, então a IA nunca recebe o conteúdo dele.
 * Limite de 20 por execução para controlar custo e tempo. PENDENCIA P-055: ANTHROPIC_API_KEY.
 */
function autorizado(cabecalho: string | null): boolean {
  const segredo = process.env.CRON_SECRET;
  if (!segredo || !cabecalho) return false;
  const a = Buffer.from(cabecalho), b = Buffer.from(`Bearer ${segredo}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Pendente = { escritorio_id: string; processo_id: string; classe: string | null; ultimo_base_hash: string | null; movimentos: Movimento[] };

export async function GET(request: Request) {
  if (!autorizado(request.headers.get("authorization"))) return Response.json({ erro: "não autorizado" }, { status: 401 });
  if (!servicoConfigurado()) return Response.json({ erro: "Supabase de serviço não configurado" }, { status: 503 });
  const ia = servicoIa();
  if (!ia) return Response.json({ geradas: 0, aviso: "ia_nao_configurada" });

  const rpc = rpcServico();
  let geradas = 0, publicadas = 0, falhas = 0;
  try {
    const pendentes = await rpc<Pendente[]>("portal_resumos_pendentes", { p_limite: 20 });
    for (const p of pendentes) {
      if (p.movimentos.length === 0 || p.ultimo_base_hash === impressaoDasMovimentacoes(p.movimentos)) continue;
      const r = await gerarResumo(ia, { classe: p.classe, movimentos: p.movimentos });
      if (!r.ok) { falhas++; continue; }
      const gravado = await rpc<{ status: string }>("portal_resumo_salvar_servico", {
        p_escritorio: p.escritorio_id, p_processo: p.processo_id, p_texto: r.texto, p_modelo: r.modelo, p_base_hash: r.baseHash, p_alertas: r.alertas,
      });
      geradas++;
      if (gravado.status === "publicado") publicadas++;
    }
    return Response.json({ geradas, publicadas, falhas });
  } catch {
    return Response.json({ erro: "falha ao gerar resumos", geradas, falhas }, { status: 500 });
  }
}
