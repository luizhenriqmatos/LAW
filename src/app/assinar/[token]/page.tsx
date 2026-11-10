import type { Metadata } from "next";
import { AberturaLink } from "@/lib/assinatura/tipos";
import { MolduraEntrada } from "@/components/moldura-entrada";
import { agenteAtual, ipAtual } from "@/lib/portal/sessao";
import { hashDoToken, tokenComFormatoValido } from "@/lib/portal/token";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";
import { FormularioAssinar } from "./formulario";

export const metadata: Metadata = { title: "Assinar documento", robots: { index: false, follow: false } };

const TEXTOS = {
  invalido: ["Link inválido", "Este link não existe ou foi digitado errado. Use o link completo do e-mail."],
  expirado: ["Link vencido", "Este link venceu (vale por 7 dias). Peça um novo ao escritório que enviou o documento."],
  assinado: ["Assinatura registrada", "Você assinou este documento. Quando todos assinarem, o escritório recebe o PDF final com o manifesto das assinaturas. Pode fechar esta página."],
  cancelado: ["Envio cancelado", "O escritório cancelou este envio. Nada foi assinado."],
  aguardando_vez: ["Ainda não é a sua vez", "Você recebe um novo e-mail quando for a sua vez de assinar."],
} as const;

export default async function PaginaAssinar({ params }: PageProps<"/assinar/[token]">) {
  const { token } = await params;
  if (!tokenComFormatoValido(token) || !servicoConfigurado()) return <Mensagem t={TEXTOS.invalido} />;

  const r = AberturaLink.parse(
    await rpcServico()("assinatura_abrir", { p_token_hash: hashDoToken(token), p_ip: await ipAtual(), p_user_agent: await agenteAtual() }),
  );
  if (!r.ok) return <Mensagem t={TEXTOS[r.motivo]} />;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-4xl font-medium tracking-tight">{r.envelope.titulo}</h1>
      <p className="mt-2 text-muted-foreground">{r.envelope.escritorio_nome} enviou este documento para <strong>{r.signatario.nome}</strong> assinar.</p>
      <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <strong>Assinatura eletrônica avançada, não qualificada</strong> (Lei 14.063/2020, art. 4º, II). Não usa certificado ICP-Brasil. Seu CPF, data, hora, endereço IP e navegador ficam registrados como prova.
      </p>

      <iframe title="Documento para assinar" src={`/assinar/${token}/documento`} className="mt-5 h-[70vh] w-full rounded-xl border bg-white" />
      <p className="mt-2 text-sm"><a href={`/assinar/${token}/documento`} target="_blank" rel="noopener noreferrer" className="text-primary underline">Abrir o documento em outra aba</a></p>
      <p className="mt-1 break-all text-xs text-muted-foreground">Identificação do documento (SHA-256): <span className="font-mono">{r.envelope.hash_original}</span></p>

      <section className="mt-6 rounded-[26px] bg-white p-6">
        <h2 className="text-lg font-semibold">Assinar</h2>
        <p className="mb-4 mt-1 text-sm text-muted-foreground">Leia o documento acima. Para assinar, digite o seu CPF e marque o aceite.</p>
        <FormularioAssinar token={token} aceiteTexto={r.aceite_texto} />
      </section>
    </main>
  );
}

function Mensagem({ t }: { t: readonly [string, string] }) {
  return <MolduraEntrada titulo={t[0]} subtitulo={t[1]}><span /></MolduraEntrada>;
}
