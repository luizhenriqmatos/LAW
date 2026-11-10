import { z } from "zod";

/**
 * Chamada a uma função do banco COM O LOGIN DO USUÁRIO (cliente Supabase da sessão, nunca service_role).
 * Assim toda ferramenta da Lia passa pela RLS e pelas checagens de módulo do próprio banco.
 */
export type ErroRpc = { message: string; code?: string; details?: string | null };
export type Rpc = (funcao: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: ErroRpc | null }>;

/** Envolve o cliente Supabase da sessão no formato Rpc. */
export function rpcDoCliente(cliente: { rpc: (f: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }): Rpc {
  return async (funcao, args) => {
    const { data, error } = await cliente.rpc(funcao, args);
    if (!error) return { data, error: null };
    const e = error as { message?: string; code?: string; details?: string | null };
    return { data: null, error: { message: String(e.message ?? "falha"), code: e.code, details: e.details ?? null } };
  };
}

export const Fonte = z.object({ ref: z.string().min(1).max(80), rotulo: z.string().min(1).max(300), link: z.string().regex(/^\/app\/[A-Za-z0-9/_-]*$/) });
export type Fonte = z.infer<typeof Fonte>;

export const ContextoAssistente = z.object({
  hoje: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  escritorio: z.string(),
  meu_membro_id: z.uuid(),
  meu_nome: z.string(),
  modulos: z.array(z.string()),
  equipe: z.array(z.object({ id: z.uuid(), nome: z.string(), prazos: z.boolean(), tarefas: z.boolean() })),
  colunas: z.array(z.object({ id: z.uuid(), nome: z.string(), concluida: z.boolean() })),
  modelos: z.array(z.object({ id: z.uuid(), nome: z.string(), descricao: z.string(), texto: z.string() })),
});
export type ContextoAssistente = z.infer<typeof ContextoAssistente>;

export type TipoRascunho = "lancamento" | "tarefa" | "prazo" | "minuta";

/** Módulo que cada tipo de rascunho exige (igual a assistente_modulo_do_tipo no banco). */
export const MODULO_DO_TIPO: Record<TipoRascunho, string> = {
  lancamento: "financeiro",
  tarefa: "tarefas",
  prazo: "prazos",
  minuta: "documentos",
};

/** Erro de negócio já traduzido: `codigo` vai para a IA e para o registro; `mensagem` é o texto simples. */
export class ErroAssistente extends Error {
  constructor(readonly codigo: string, mensagem: string, readonly semPermissao: string[] = []) {
    super(mensagem);
  }
}

/** Extrai o código de erro do banco (ex.: "sem_permissao") e, no caso de permissão, os módulos recusados. */
export function lerErroRpc(e: ErroRpc): { codigo: string; modulos: string[] } {
  const codigo = /^[a-z_]+$/.test(e.message.trim()) ? e.message.trim() : "falha";
  const modulos = codigo === "sem_permissao" && e.details ? e.details.split(",").map((m) => m.trim()).filter(Boolean) : [];
  return { codigo, modulos };
}
