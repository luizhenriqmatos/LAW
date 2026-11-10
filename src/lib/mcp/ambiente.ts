import "server-only";
import { createClient } from "@supabase/supabase-js";
import { montarCtx } from "@/lib/assistente/servidor";
import { LIMITE_POR_DIA, LIMITE_POR_MINUTO, TEMPO_JWT_SEG, urlBase } from "@/lib/oauth/config";
import { jwtHs256 } from "@/lib/oauth/cripto";
import { SUPABASE_CHAVE_PUBLICA, SUPABASE_URL } from "@/lib/supabase/config";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";
import type { Autenticado, DepsHttpMcp } from "./http";

/**
 * Liga o servidor MCP ao Supabase de verdade.
 *  - Token do conector: conferido pelo cliente de SERVIÇO (mcp_autenticar), só no servidor.
 *  - Ferramentas: rodam com um JWT de 5 minutos DO PRÓPRIO USUÁRIO (role authenticated, law_canal = mcp),
 *    assinado com SUPABASE_JWT_SECRET. Assim a RLS e as funções da Lia valem exatamente como na tela.
 * PENDENCIA P-071: SUPABASE_JWT_SECRET (segredo JWT do projeto Supabase). Sem ele o conector responde 503.
 */
export function mcpConfigurado(): boolean {
  return !!urlBase() && servicoConfigurado() && !!process.env.SUPABASE_JWT_SECRET && !!SUPABASE_CHAVE_PUBLICA;
}

function clienteDoUsuario(usuarioId: string) {
  const agora = Math.floor(Date.now() / 1000);
  const jwt = jwtHs256({ sub: usuarioId, role: "authenticated", aud: "authenticated", iat: agora, exp: agora + TEMPO_JWT_SEG, law_canal: "mcp" }, process.env.SUPABASE_JWT_SECRET!);
  return createClient(SUPABASE_URL, SUPABASE_CHAVE_PUBLICA, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function depsMcpDoAmbiente(): DepsHttpMcp {
  const base = mcpConfigurado() ? urlBase() : null;
  const servico = base ? rpcServico() : null;
  return {
    base,
    origens: ["https://claude.ai", "https://claude.com", "https://chatgpt.com"],
    autenticar: (hash) => servico!<Autenticado>("mcp_autenticar", { p_acesso_hash: hash, p_limite_minuto: LIMITE_POR_MINUTO, p_limite_dia: LIMITE_POR_DIA }),
    sessao: (a, b) => ({
      escopos: a.escopos,
      base: b,
      ctx: async () => ({ ...(await montarCtx(clienteDoUsuario(a.usuario_id), a.escritorio_id)), conversaId: a.conversa_id }),
      registrar: async (ferramenta, escrita, ok, codigo) => {
        await servico!("mcp_registrar_chamada", { p_concessao: a.concessao_id, p_ferramenta: ferramenta, p_escrita: escrita, p_ok: ok, p_codigo: codigo });
      },
    }),
  };
}

export function depsOAuthDoAmbiente() {
  const base = urlBase();
  return base && servicoConfigurado() ? { base, rpc: rpcServico() } : null;
}
