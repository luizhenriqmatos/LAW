import { z } from "zod";

/** O que as funções do portal devolvem. Conferido com Zod mesmo vindo do nosso banco: o portal é a única parte pública do app. */
const Movimento = z.object({ data_hora: z.string(), codigo: z.string().nullable(), nome: z.string() });

export const InicioPortal = z.union([
  z.object({ ok: z.literal(false) }),
  z.object({
    ok: z.literal(true),
    clientes: z.array(z.string()),
    processos: z.array(z.object({
      processo_id: z.uuid(),
      escritorio: z.string(),
      numero_cnj: z.string(),
      titulo: z.string().nullable(),
      tribunal: z.string().nullable(),
      situacao_texto: z.string().nullable(),
      ver_movimentacoes: z.boolean(),
      ultima_movimentacao: Movimento.nullable(),
    })),
  }),
]);
export type InicioPortal = z.infer<typeof InicioPortal>;

export const ProcessoPortal = z.union([
  z.object({ ok: z.literal(false), motivo: z.string().optional() }),
  z.object({
    ok: z.literal(true),
    processo: z.object({
      id: z.uuid(),
      numero_cnj: z.string(),
      titulo: z.string().nullable(),
      tribunal: z.string().nullable(),
      orgao_julgador: z.string().nullable(),
      escritorio: z.string(),
      situacao_texto: z.string().nullable(),
    }),
    ver_movimentacoes: z.boolean(),
    ver_resumo: z.boolean(),
    ver_compromissos: z.boolean(),
    ver_documentos: z.boolean(),
    movimentacoes: z.array(Movimento),
    resumo: z.object({ texto: z.string(), publicado_em: z.string(), revisado: z.boolean() }).nullable(),
    compromissos: z.array(z.object({ titulo: z.string(), tipo: z.string(), inicio: z.string(), fim: z.string(), local: z.string() })),
    documentos: z.array(z.object({ id: z.uuid(), nome: z.string(), mime: z.string().nullable(), tamanho: z.number().nullable(), compartilhado_em: z.string() })),
  }),
]);
export type ProcessoPortal = z.infer<typeof ProcessoPortal>;

export const DocumentoPortal = z.union([
  z.object({ ok: z.literal(false) }),
  z.object({ ok: z.literal(true), escritorio_id: z.uuid(), arquivo_drive_id: z.string(), nome: z.string(), mime: z.string().nullable() }),
]);

export const ConsumoLink = z.union([
  z.object({ ok: z.literal(true), expira_em: z.string() }),
  z.object({ ok: z.literal(false), motivo: z.enum(["invalido", "usado", "expirado"]) }),
]);

export const SolicitacaoLink = z.object({ enviar: z.boolean(), escritorios: z.array(z.string()).optional(), motivo: z.string().optional() });
