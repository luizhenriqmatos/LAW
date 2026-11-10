"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { EstadoFormulario } from "@/components/formulario";
import { servicoEmail } from "@/lib/integrations/email";
import { agenteAtual, esquecerSessao, guardarSessao, hashDaSessao, ipAtual } from "@/lib/portal/sessao";
import { ConsumoLink, SolicitacaoLink } from "@/lib/portal/tipos";
import { hashDoToken, novoToken, tokenComFormatoValido, VALIDADE_LINK_MINUTOS } from "@/lib/portal/token";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

/** Mesma resposta para e-mail cadastrado ou não: o portal nunca diz quem é cliente. */
const RESPOSTA_PADRAO =
  `Se esse e-mail estiver ligado a um processo liberado pelo seu advogado, você vai receber o link em instantes. Ele vale por ${VALIDADE_LINK_MINUTOS} minutos e só pode ser usado uma vez.`;

async function origem() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

export async function pedirLink(_: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  const email = z.string().trim().toLowerCase().pipe(z.email().max(200)).safeParse(dados.get("email"));
  if (!email.success) return { erro: "Digite um e-mail válido." };
  if (!servicoConfigurado()) return { erro: "O portal ainda não está disponível. Fale com o seu advogado." };

  const token = novoToken();
  const r = SolicitacaoLink.parse(
    await rpcServico()("portal_link_solicitar", { p_email: email.data, p_token_hash: hashDoToken(token), p_ip: await ipAtual() }),
  );
  if (r.enviar) {
    const envio = await servicoEmail().enviarLinkPortal({
      para: email.data,
      escritorios: r.escritorios ?? [],
      link: `${await origem()}/portal/acesso/${token}`,
      validadeMinutos: VALIDADE_LINK_MINUTOS,
    });
    // O visitante não vê o motivo (nem o link): só o log do servidor. PENDENCIA P-016 (Resend).
    if (!envio.enviado) console.error("Portal: e-mail do link não saiu:", envio.motivo);
  }
  return { ok: RESPOSTA_PADRAO };
}

/** Só aqui o link é consumido (POST). Abrir o link no navegador ou num antivírus de e-mail NÃO gasta o link. */
export async function entrarComLink(token: string) {
  if (!tokenComFormatoValido(token) || !servicoConfigurado()) redirect("/portal/entrar?erro=invalido");
  const sessao = novoToken();
  const r = ConsumoLink.parse(
    await rpcServico()("portal_link_consumir", {
      p_token_hash: hashDoToken(token),
      p_sessao_hash: hashDoToken(sessao),
      p_ip: await ipAtual(),
      p_user_agent: await agenteAtual(),
    }),
  );
  if (!r.ok) redirect(`/portal/entrar?erro=${r.motivo}`);
  await guardarSessao(sessao, new Date(r.expira_em));
  redirect("/portal");
}

export async function sairDoPortal() {
  const hash = await hashDaSessao();
  if (hash && servicoConfigurado()) await rpcServico()("portal_sessao_encerrar", { p_sessao_hash: hash });
  await esquecerSessao();
  redirect("/portal/entrar");
}
