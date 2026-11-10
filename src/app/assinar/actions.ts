"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { EstadoFormulario } from "@/components/formulario";
import { cpfValido } from "@/lib/assinatura/cpf";
import { finalizarEnvelope } from "@/lib/assinatura/finalizar";
import { LinkEmitido, ResultadoAssinar } from "@/lib/assinatura/tipos";
import { servicoEmail } from "@/lib/integrations/email";
import { agenteAtual, ipAtual } from "@/lib/portal/sessao";
import { hashDoToken, novoToken, tokenComFormatoValido } from "@/lib/portal/token";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

const MENSAGENS: Record<string, string> = {
  invalido: "Este link não é válido.",
  expirado: "Este link venceu (vale por 7 dias). Peça um novo ao escritório.",
  assinado: "Você já assinou este documento.",
  cancelado: "O escritório cancelou este envio. Nada foi assinado.",
  aguardando_vez: "Ainda não é a sua vez de assinar. Você recebe o link quando os anteriores assinarem.",
  cpf_invalido: "CPF inválido. Confira os números.",
  aceite_obrigatorio: "Marque o aceite para assinar.",
  nao_visualizou: "Abra e leia o documento na tela antes de assinar. Se ele não aparece, use \"Abrir o documento em outra aba\".",
};

async function origem() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

/** Assina. Só aqui o link é gasto: abrir a página não assina nada. */
export async function assinarDocumento(token: string, _: EstadoFormulario, dados: FormData): Promise<EstadoFormulario> {
  if (!tokenComFormatoValido(token) || !servicoConfigurado()) return { erro: MENSAGENS.invalido };
  const cpf = String(dados.get("cpf") ?? "");
  if (!cpfValido(cpf)) return { erro: MENSAGENS.cpf_invalido };
  if (dados.get("aceite") !== "on") return { erro: MENSAGENS.aceite_obrigatorio };

  const rpc = rpcServico();
  const r = ResultadoAssinar.parse(
    await rpc("assinatura_assinar", { p_token_hash: hashDoToken(token), p_cpf: cpf, p_aceite: true, p_ip: await ipAtual(), p_user_agent: await agenteAtual() }),
  );
  if (!r.ok) return { erro: MENSAGENS[r.motivo] ?? MENSAGENS.invalido };

  // O que vem depois não pode desfazer a assinatura: falha aqui é registrada e o cron tenta de novo.
  try {
    if (r.todos) {
      await finalizarEnvelope(rpc, r.envelope_id);
    } else {
      for (const proximo of r.liberados) {
        const novo = novoToken();
        const info = LinkEmitido.parse(await rpc("assinatura_emitir_link_servico", { p_signatario: proximo.id, p_token_hash: hashDoToken(novo) }));
        const envio = await servicoEmail().enviarLinkAssinatura({
          para: info.email, nome: info.nome, escritorio: info.escritorio, titulo: info.titulo, link: `${await origem()}/assinar/${novo}`, validadeDias: 7,
        });
        await rpc("assinatura_registrar_envio", { p_signatario: proximo.id, p_enviado: envio.enviado, p_motivo: envio.enviado ? null : envio.motivo });
      }
    }
  } catch (e) {
    console.error("Assinatura: passo seguinte falhou (o advogado pode repetir na tela do envelope):", e instanceof Error ? e.message : e);
  }
  redirect(`/assinar/${token}`);
}
