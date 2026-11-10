import type { CtxFerramenta } from "@/lib/assistente/ferramentas";
import { NOME_ASSISTENTE } from "@/lib/assistente/nome";
import { FERRAMENTAS_MCP, ferramentasDoEscopo } from "./ferramentas";

/**
 * Protocolo MCP (JSON-RPC 2.0) sem estado: initialize, ping, tools/list, tools/call. Sem SSE nem sessão.
 */
// PENDENCIA P-075: sem SSE, notificações, elicitação, resources e prompts.
export const VERSOES_MCP = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const VERSAO_SERVIDOR = "0.12.0";

export type SessaoMcp = {
  escopos: readonly string[];
  base: string;
  /** Contexto das ferramentas COM O LOGIN do usuário (criado só quando uma ferramenta roda). */
  ctx: () => Promise<CtxFerramenta>;
  registrar: (ferramenta: string, escrita: boolean, ok: boolean, codigo: string | null) => Promise<void>;
};

type Pedido = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const resposta = (id: Pedido["id"], result: unknown) => ({ jsonrpc: "2.0" as const, id: id ?? null, result });
export const erroRpc = (id: Pedido["id"] | undefined, code: number, message: string) => ({ jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } });

/** Troca links internos (/app/...) por endereço completo: o assistente externo abre no navegador. */
export function absolutizar(v: unknown, base: string): unknown {
  if (Array.isArray(v)) return v.map((x) => absolutizar(x, base));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "link" && typeof x === "string" && x.startsWith("/app/") ? `${base}${x}` : absolutizar(x, base)]));
  }
  return v;
}

const INSTRUCOES = `Servidor do LAW, sistema de gestão do escritório de advocacia. As ferramentas usam as permissões de quem conectou: se uma busca recusar por permissão, diga isso ao usuário e não tente contornar.
Responda só com o que as ferramentas devolveram e cite o "link" de cada item. Para "prazos da semana", use buscar_prazos com periodo="semana". Prazos são sugestões: lembre de conferir no sistema oficial do tribunal.
Ferramentas criar_* e gerar_minuta GRAVAM no LAW: sempre mostre ao usuário o que vai ser gravado e peça confirmação antes. Processos em segredo de justiça podem não aparecer por configuração do escritório. (A assistente interna do LAW se chama ${NOME_ASSISTENTE}.)`;

export async function tratarMcp(msg: unknown, s: SessaoMcp): Promise<object | null> {
  if (Array.isArray(msg)) return erroRpc(null, -32600, "Lotes (batch) não são aceitos.");
  if (!msg || typeof msg !== "object" || (msg as Pedido).jsonrpc !== "2.0") return erroRpc(null, -32600, "Pedido JSON-RPC inválido.");
  const p = msg as Pedido;
  if (typeof p.method !== "string") {
    // Resposta do cliente a algo que não pedimos: ignorar.
    return null;
  }
  const notificacao = p.id === undefined;
  if (notificacao) return null; // notifications/initialized, notifications/cancelled...

  switch (p.method) {
    case "initialize": {
      const pedida = String(p.params?.protocolVersion ?? "");
      const versao = (VERSOES_MCP as readonly string[]).includes(pedida) ? pedida : VERSOES_MCP[0];
      return resposta(p.id, {
        protocolVersion: versao,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "law", title: "LAW", version: VERSAO_SERVIDOR },
        instructions: INSTRUCOES,
      });
    }
    case "ping":
      return resposta(p.id, {});
    case "tools/list":
      return resposta(p.id, {
        tools: ferramentasDoEscopo(s.escopos).map((f) => ({ name: f.name, title: f.title, description: f.description, inputSchema: f.inputSchema, annotations: f.annotations })),
      });
    case "tools/call": {
      const nome = String(p.params?.name ?? "");
      const f = FERRAMENTAS_MCP.find((x) => x.name === nome);
      if (!f) return erroRpc(p.id, -32602, `Ferramenta desconhecida: ${nome}`);
      const escrita = f.escopo === "law.write";
      if (!s.escopos.includes(f.escopo)) {
        await s.registrar(nome, escrita, false, "escopo_insuficiente");
        return resposta(p.id, { isError: true, content: [{ type: "text", text: `Este conector não tem permissão "${f.escopo}". O usuário pode reconectar autorizando esse acesso (se o escritório permitir). Nada foi feito.` }] });
      }
      const ctx = await s.ctx();
      const r = await f.executar(ctx, p.params?.arguments ?? {});
      await s.registrar(nome, escrita, r.ok, r.ok ? null : r.codigo);
      if (!r.ok) {
        const texto = r.codigo === "sem_permissao"
          ? `Sem permissão: o usuário não tem acesso a ${r.semPermissao.join(", ") || "esses dados"} no LAW. Diga isso a ele; não tente obter por outra ferramenta.`
          : r.mensagem;
        return resposta(p.id, { isError: true, content: [{ type: "text", text: JSON.stringify({ erro: r.codigo, mensagem: texto }) }] });
      }
      return resposta(p.id, { content: [{ type: "text", text: JSON.stringify(absolutizar(r.paraIa, s.base)) }] });
    }
    default:
      return erroRpc(p.id, -32601, `Método não suportado: ${p.method}`);
  }
}
