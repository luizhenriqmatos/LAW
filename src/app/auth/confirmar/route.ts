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

  // O Supabase devolve o erro na própria URL quando o link venceu ou já foi usado.
  const codigoErro = searchParams.get("error_code") ?? searchParams.get("error");
  if (codigoErro) {
    return NextResponse.redirect(new URL(`/entrar?erro=${codigoErro === "otp_expired" ? "expirado" : "link"}`, origin));
  }

  const supabase = await criarClienteServidor();
  let erro: string | null = "link";
  if (code) {
    // PENDENCIA P-095: o código só troca por sessão no mesmo navegador em que a pessoa pediu o e-mail.
    const r = await supabase.auth.exchangeCodeForSession(code);
    erro = r.error ? (/verifier|flow state/i.test(r.error.message) ? "navegador" : "expirado") : null;
  } else if (tokenHash && tipo) {
    const r = await supabase.auth.verifyOtp({ type: tipo, token_hash: tokenHash });
    erro = r.error ? "expirado" : null;
  }
  return NextResponse.redirect(new URL(erro ? `/entrar?erro=${erro}` : proximo, origin));
}
