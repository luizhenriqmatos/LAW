// PENDENCIA P-015: projeto Supabase do LAW (sa-east-1) ainda não existe; sem estas variáveis o app mostra "configuração pendente".
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_CHAVE_PUBLICA = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

export function supabaseConfigurado(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_CHAVE_PUBLICA.length > 0;
}
