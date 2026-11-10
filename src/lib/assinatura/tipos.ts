import { z } from "zod";

export const MOTIVOS_LINK = ["invalido", "expirado", "assinado", "cancelado", "aguardando_vez"] as const;

export const AberturaLink = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    signatario: z.object({ id: z.uuid(), nome: z.string(), email: z.string() }),
    envelope: z.object({ id: z.uuid(), titulo: z.string(), nome_arquivo: z.string(), tamanho: z.number(), hash_original: z.string(), escritorio_nome: z.string() }),
    ja_visualizou: z.boolean(),
    aceite_texto: z.string(),
    expira_em: z.string(),
  }),
  z.object({ ok: z.literal(false), motivo: z.enum(MOTIVOS_LINK) }),
]);
export type AberturaLink = z.infer<typeof AberturaLink>;

export const DocumentoParaAssinar = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), nome_arquivo: z.string(), pdf: z.unknown() }),
  z.object({ ok: z.literal(false) }),
]);

export const ResultadoAssinar = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    todos: z.boolean(),
    envelope_id: z.uuid(),
    liberados: z.array(z.object({ id: z.uuid(), nome: z.string(), email: z.string() })),
  }),
  z.object({ ok: z.literal(false), motivo: z.enum([...MOTIVOS_LINK, "cpf_invalido", "aceite_obrigatorio", "nao_visualizou"]) }),
]);
export type ResultadoAssinar = z.infer<typeof ResultadoAssinar>;

export const EnvelopeCriado = z.object({
  id: z.uuid(),
  hash_original: z.string(),
  signatarios: z.array(z.object({ id: z.uuid(), nome: z.string(), email: z.string(), ordem: z.number(), vez: z.boolean() })),
});

export const LinkEmitido = z.object({ nome: z.string(), email: z.string(), titulo: z.string(), escritorio: z.string(), expira_em: z.string() });

export const DadosFinais = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    titulo: z.string(),
    nome_arquivo: z.string(),
    hash_original: z.string(),
    escritorio_nome: z.string(),
    criado_em: z.string(),
    original: z.unknown(),
    signatarios: z.array(z.object({
      ordem: z.number(), nome: z.string(), email: z.string(), cpf: z.string(), assinado_em: z.string(), ip: z.string().nullable(), user_agent: z.string().nullable(),
    })),
  }),
  z.object({ ok: z.literal(false) }),
]);

export const Conclusao = z.union([
  z.object({ ok: z.literal(true), hash_final: z.string() }).passthrough(),
  z.object({ ok: z.literal(false), motivo: z.string() }),
]);

export const Verificacao = z.discriminatedUnion("encontrado", [
  z.object({ encontrado: z.literal(false) }),
  z.object({
    encontrado: z.literal(true),
    tipo: z.enum(["final", "original"]),
    status: z.enum(["enviado", "assinado", "concluido", "cancelado"]),
    titulo: z.string(),
    escritorio_nome: z.string(),
    criado_em: z.string(),
    concluido_em: z.string().nullable(),
    hash_original: z.string(),
    hash_final: z.string().nullable(),
    signatarios: z.array(z.object({ nome: z.string(), assinado_em: z.string().nullable(), cpf: z.string().nullable() })),
  }),
]);
export type Verificacao = z.infer<typeof Verificacao>;

/** Signatário digitado no formulário do advogado. */
export const SignatarioEntrada = z.object({
  nome: z.string().trim().min(2, "Informe o nome do signatário.").max(120),
  email: z.string().trim().toLowerCase().pipe(z.email("E-mail inválido.").max(200)),
  ordem: z.number().int().min(1).max(20),
});
export type SignatarioEntrada = z.infer<typeof SignatarioEntrada>;
