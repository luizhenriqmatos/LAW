import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { exigirDono, exigirModulo } from "@/lib/contexto";
import { concluirConexao, nomeDoCalendario } from "@/lib/agenda/conectar";
import { agendarSincronizacao, googleConfigurado } from "@/lib/agenda/ambiente";
import { concluirConexaoDrive } from "@/lib/drive/conectar";
import { agendarSincronizacaoDrive, driveConfigurado } from "@/lib/drive/ambiente";
import { apiGoogleAgenda } from "@/lib/integrations/google/agenda-api";
import { apiGoogleDrive } from "@/lib/integrations/google/drive-api";
import { chaveDoAmbiente } from "@/lib/integrations/google/cripto";
import { ErroGoogle } from "@/lib/integrations/google/erro";
import { configGoogle, COOKIE_ESTADO, trocarCodigo } from "@/lib/integrations/google/oauth";
import { rpcServico } from "@/lib/supabase/servico";

function igual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Passo 2: o Google devolve `code` + `state`. Confere o state (anti-CSRF), a sessão e o vínculo com o escritório,
 * troca o code por tokens e grava tudo cifrado. Agenda: cria o calendário "LAW". Drive (só dono): cria LAW/Clientes.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = url.origin;

  // O cookie diz para que serve esta conexão (agenda ou drive). Cookie antigo, sem propósito, é da agenda.
  const jar = await cookies();
  const guardado = jar.get(COOKIE_ESTADO)?.value ?? "";
  jar.delete({ name: COOKIE_ESTADO, path: "/api/google" });
  const [estado, escritorioId, proposito = "agenda"] = guardado.split(".");
  const drive = proposito === "drive";
  const volta = (aviso: string) => NextResponse.redirect(`${base}${drive ? "/app/documentos" : "/app/agenda"}?aviso=${aviso}`);

  const { usuario, vinculo, vinculos } = drive ? await exigirDono() : await exigirModulo("agenda");
  if (!estado || !escritorioId || !igual(estado, url.searchParams.get("state") ?? "") || escritorioId !== vinculo.escritorioId) {
    return volta("erro_google_estado");
  }
  if (url.searchParams.get("error")) return volta("erro_google_negado");
  const code = url.searchParams.get("code");
  const cfg = configGoogle();
  if (!code || !cfg || !(drive ? driveConfigurado() : googleConfigurado())) {
    return volta(drive ? "erro_drive_nao_configurado" : "erro_google_nao_configurado");
  }

  try {
    const tokens = await trocarCodigo(cfg, code);
    if (drive) {
      await concluirConexaoDrive({
        rpc: rpcServico(), api: apiGoogleDrive(), chave: chaveDoAmbiente(),
        escritorioId: vinculo.escritorioId, usuarioId: usuario.id, tokens,
      });
    } else {
      await concluirConexao({
        rpc: rpcServico(), api: apiGoogleAgenda(), chave: chaveDoAmbiente(),
        escritorioId: vinculo.escritorioId, usuarioId: usuario.id,
        nomeCalendario: nomeDoCalendario(vinculo.escritorioNome, vinculos.length > 1),
        tokens,
      });
    }
  } catch (e) {
    console.error(`Conexão com o Google (${proposito}) falhou:`, e instanceof Error ? e.message : e);
    return volta(e instanceof ErroGoogle && e.codigo === "sem_refresh" ? "erro_google_sem_refresh" : "erro_google_falha");
  }
  if (drive) {
    agendarSincronizacaoDrive(); // primeira carga: monta as pastas de tudo que já está confirmado
    return volta("drive_conectado");
  }
  agendarSincronizacao(); // primeira carga: o que já existe sobe agora; se falhar, o cron diário repete
  return volta("google_conectado");
}
