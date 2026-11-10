import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { exigirDono, exigirModulo } from "@/lib/contexto";
import { configGoogle, COOKIE_ESTADO, ESCOPO_DRIVE, ESCOPO_GOOGLE, urlAutorizacao } from "@/lib/integrations/google/oauth";
import { googleConfigurado } from "@/lib/agenda/ambiente";
import { driveConfigurado } from "@/lib/drive/ambiente";

/**
 * Passo 1 da conexão: manda o usuário para a tela de consentimento do Google (escopo mínimo).
 *  - padrão: Google Agenda (qualquer pessoa com acesso à Agenda, no calendário dela);
 *  - ?para=drive: Google Drive do ESCRITÓRIO (só o dono), escopo drive.file.
 * Os dois usam o mesmo endereço de retorno; o propósito vai junto do state, num cookie HTTP-only.
 */
export async function GET(request: Request) {
  const base = new URL(request.url).origin;
  const drive = new URL(request.url).searchParams.get("para") === "drive";

  const { vinculo } = drive ? await exigirDono() : await exigirModulo("agenda");
  const voltaPara = drive ? "/app/documentos" : "/app/agenda";
  const cfg = configGoogle();
  if (!cfg || !(drive ? driveConfigurado() : googleConfigurado())) {
    return NextResponse.redirect(`${base}${voltaPara}?aviso=${drive ? "erro_drive_nao_configurado" : "erro_google_nao_configurado"}`);
  }

  const estado = randomBytes(24).toString("base64url");
  (await cookies()).set(COOKIE_ESTADO, `${estado}.${vinculo.escritorioId}.${drive ? "drive" : "agenda"}`, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/api/google", maxAge: 600,
  });
  return NextResponse.redirect(urlAutorizacao(cfg, estado, drive ? ESCOPO_DRIVE : ESCOPO_GOOGLE));
}
