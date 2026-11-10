import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_CHAVE_PUBLICA, SUPABASE_URL, supabaseConfigurado } from "@/lib/supabase/config";

const PROTEGIDAS = ["/app", "/onboarding"];

/** Renova a sessão do Supabase a cada requisição e manda quem não está logado para /entrar. */
export async function proxy(request: NextRequest) {
  // Portal do cliente: não usa login do Supabase (a sessão é do próprio portal). A URL de acesso carrega um token,
  // então nada é guardado em cache, o endereço não vaza no cabeçalho Referer e buscadores não indexam.
  const alvo = request.nextUrl.pathname;
  if (alvo === "/portal" || alvo.startsWith("/portal/") || alvo.startsWith("/assinar/")) {
    const r = NextResponse.next();
    r.headers.set("Cache-Control", "no-store");
    r.headers.set("Referrer-Policy", "no-referrer");
    r.headers.set("X-Robots-Tag", "noindex, nofollow");
    return r;
  }
  // Conector MCP e OAuth: autenticação própria por token (sem cookie de sessão); não há sessão para renovar.
  if (alvo.startsWith("/api/mcp") || alvo === "/api/whatsapp" || alvo.startsWith("/api/oauth/") || alvo.startsWith("/.well-known/")) {
    return NextResponse.next();
  }
  if (!supabaseConfigurado()) return NextResponse.next();

  let resposta = NextResponse.next({ request });
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_CHAVE_PUBLICA, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (lista) => {
        lista.forEach(({ name, value }) => request.cookies.set(name, value));
        resposta = NextResponse.next({ request });
        lista.forEach(({ name, value, options }) => resposta.cookies.set(name, value, options));
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const caminho = request.nextUrl.pathname;
  const protegida = PROTEGIDAS.some((p) => caminho === p || caminho.startsWith(p + "/"));
  if (!user && protegida) {
    const url = request.nextUrl.clone();
    url.pathname = "/entrar";
    url.search = "";
    url.searchParams.set("proximo", caminho);
    return NextResponse.redirect(url);
  }
  return resposta;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
