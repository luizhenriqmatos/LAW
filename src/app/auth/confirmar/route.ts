import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { criarClienteServidor } from "@/lib/supabase/servidor";
import { caminhoSeguro } from "@/lib/erros";

/** Destino dos links do e-mail (confirmação de cadastro e link de acesso). */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const tipo = searchParams.get("type") as EmailOtpType | null;
  const proximo = caminhoSeguro(searchParams.get("proximo"));

  const supabase = await criarClienteServidor();
  let falhou = true;
  if (code) {
    falhou = Boolean((await supabase.auth.exchangeCodeForSession(code)).error);
  } else if (tokenHash && tipo) {
    falhou = Boolean((await supabase.auth.verifyOtp({ type: tipo, token_hash: tokenHash })).error);
  }
  return NextResponse.redirect(new URL(falhou ? "/entrar?erro=link" : proximo, origin));
}
