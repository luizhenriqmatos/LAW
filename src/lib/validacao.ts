import { z } from "zod";
import { IDS_MODULOS } from "./modulos";

export const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
] as const;

export const PLANOS = ["solo", "equipe", "escritorio", "juridico"] as const;

export const soDigitos = (v: string) => v.replace(/\D/g, "");

/** OAB: até 7 dígitos (zeros à esquerda removidos) + UF entre as 27. */
export function oabValida(numero: string, uf: string): boolean {
  const n = soDigitos(numero).replace(/^0+(?=\d)/, "");
  return /^\d{1,7}$/.test(n) && Number(n) > 0 && (UFS as readonly string[]).includes(uf.toUpperCase());
}

/** CNPJ com dígitos verificadores (aceita com ou sem máscara). Mesma regra de public.cnpj_valido(). */
export function cnpjValido(valor: string): boolean {
  const c = soDigitos(valor);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (base: string, pesos: number[]) => {
    const soma = pesos.reduce((acc, p, i) => acc + Number(base[i]) * p, 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = calc(c, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc(c, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(c[12]) && d2 === Number(c[13]);
}

/** CPF com dígitos verificadores. Mesma regra de public.cpf_valido(). */
export function cpfValido(valor: string): boolean {
  const c = soDigitos(valor);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n: number) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

/** CPF (11 números) ou CNPJ (14). */
export function documentoValido(valor: string): boolean {
  const d = soDigitos(valor);
  return d.length === 11 ? cpfValido(d) : d.length === 14 ? cnpjValido(d) : false;
}

export function formatarDocumento(valor: string | null | undefined): string {
  const d = soDigitos(valor ?? "");
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  if (d.length === 14) return formatarCnpj(d);
  return valor ?? "";
}

export const formatarCnpj = (c: string) =>
  soDigitos(c).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

const cnpjOpcional = z
  .string()
  .trim()
  .transform(soDigitos)
  .refine((v) => v === "" || cnpjValido(v), { message: "CNPJ inválido. Confira os números." });

export const esquemaEscritorio = z.object({
  nome: z.string().trim().min(2, "Informe o nome do escritório.").max(120, "Nome muito longo."),
  cnpj: cnpjOpcional,
  plano: z.enum(PLANOS, { message: "Escolha um plano." }),
});

export const esquemaOab = z
  .object({
    numero: z.string().trim(),
    uf: z.string().trim().toUpperCase(),
  })
  .refine((o) => oabValida(o.numero, o.uf), { message: "OAB inválida: use até 7 números e uma UF válida." })
  .transform((o) => ({ numero: soDigitos(o.numero).replace(/^0+(?=\d)/, ""), uf: o.uf }));

export const esquemaMonitoramento = z.discriminatedUnion("modo", [
  z.object({
    modo: z.literal("oab"),
    oabs: z.array(esquemaOab).min(1, "Cadastre pelo menos uma OAB.").max(20, "Máximo de 20 OABs."),
  }),
  z.object({
    modo: z.literal("sociedade"),
    cnpj: cnpjOpcional,
    nome: z.string().trim().max(160, "Nome muito longo."),
  }).refine((s) => s.cnpj !== "" || s.nome.length >= 2, { message: "Informe o CNPJ ou o nome da sociedade." }),
]);

export const esquemaConvite = z.object({
  email: z.string().trim().toLowerCase().email("E-mail inválido."),
  modulos: z.array(z.enum(IDS_MODULOS as [string, ...string[]])).default([]),
});

export const esquemaLogin = z.object({
  email: z.string().trim().toLowerCase().email("E-mail inválido."),
  senha: z.string().min(8, "A senha precisa ter pelo menos 8 caracteres."),
});

const opcional = (max: number) => z.string().trim().max(max, "Texto muito longo.").default("");

export const esquemaCliente = z.object({
  nome: z.string().trim().min(2, "Informe o nome do cliente.").max(200, "Nome muito longo."),
  documento: z
    .string()
    .trim()
    .default("")
    .transform(soDigitos)
    .refine((v) => v === "" || documentoValido(v), { message: "CPF ou CNPJ inválido. Confira os números." }),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .default("")
    .refine((v) => v === "" || z.email().safeParse(v).success, { message: "E-mail inválido." }),
  telefone: z
    .string()
    .trim()
    .default("")
    .transform(soDigitos)
    .refine((v) => v === "" || (v.length >= 10 && v.length <= 13), { message: "Telefone inválido: use DDD + número." }),
});

export const esquemaProcesso = z.object({
  titulo: opcional(160),
  area: opcional(60),
  classe: opcional(200),
  orgao_julgador: opcional(200),
  segredo_justica: z.boolean().default(false),
});
