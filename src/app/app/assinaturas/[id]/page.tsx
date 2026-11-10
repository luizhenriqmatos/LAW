import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { formatarCpf } from "@/lib/assinatura/cpf";
import { exigirModulo } from "@/lib/contexto";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";
import { cn } from "@/lib/utils";
import { botaoPequeno } from "../../processos/comum";
import { cancelarEnvelope, gerarPdfFinal, reenviarLink } from "../actions";
import { AvisoAssinatura, AvisoTipoAssinatura, dataHora, ROTULO_EVIDENCIA, STATUS_ENVELOPE } from "../comum";

export default async function PaginaEnvelope({ params, searchParams }: PageProps<"/app/assinaturas/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase } = await exigirModulo("assinaturas");

  const { data: e } = await supabase.from("assinatura_envelope")
    .select("id, titulo, nome_arquivo, tamanho, hash_original, hash_final, status, criado_em, concluido_em, cancelado_em, retencao_ate, processo_id").eq("id", id).maybeSingle();
  if (!e) notFound();
  const [{ data: sigs }, { data: evid }] = await Promise.all([
    supabase.from("assinatura_signatario").select("id, ordem, nome, email, status, token_expira_em, link_enviado_em, cpf, assinado_em, ip").eq("envelope_id", id).order("ordem").order("nome"),
    supabase.from("assinatura_evidencia").select("id, tipo, criado_em, ip, signatario_id, dados").eq("envelope_id", id).order("id"),
  ]);
  const cadeiaOk = servicoConfigurado() ? await rpcServico()<boolean>("assinatura_verificar_cadeia", { p_envelope: id }) : null;
  const nomes = new Map((sigs ?? []).map((s) => [s.id, s.nome]));
  const st = STATUS_ENVELOPE[e.status] ?? STATUS_ENVELOPE.enviado;
  const aberto = e.status === "enviado";
  const menorPendente = Math.min(...(sigs ?? []).filter((s) => s.status === "pendente").map((s) => s.ordem), Infinity);

  return (
    <div className="mx-auto max-w-4xl">
      <p className="text-sm"><Link href="/app/assinaturas" className="text-muted-foreground hover:underline">← Assinaturas</Link></p>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">{e.titulo}</h1>
      <p className="mt-2"><span className={cn("rounded-full px-3 py-1 text-xs font-medium", st.estilo)}>{st.rotulo}</span></p>
      <AvisoTipoAssinatura className="mt-4" />
      <AvisoAssinatura codigo={sp.aviso} />

      <section className="mt-6 rounded-[26px] bg-white p-6 text-sm">
        <h2 className="text-lg font-semibold">Documento</h2>
        <dl className="mt-3 grid gap-2 sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted-foreground">Arquivo</dt><dd>{e.nome_arquivo} ({Math.ceil(e.tamanho / 1024)} KB)</dd>
          <dt className="text-muted-foreground">Hash SHA-256 do original</dt><dd className="break-all font-mono text-xs">{e.hash_original}</dd>
          <dt className="text-muted-foreground">Hash SHA-256 do PDF final</dt><dd className="break-all font-mono text-xs">{e.hash_final ?? "— (sai quando todos assinarem)"}</dd>
          <dt className="text-muted-foreground">Guardado até</dt><dd>{new Date(`${e.retencao_ate}T12:00:00`).toLocaleDateString("pt-BR")} (5 anos, mesmo se a conta for encerrada)</dd>
          <dt className="text-muted-foreground">Cadeia de evidências</dt>
          <dd>{cadeiaOk === null ? "Não conferida (servidor sem chave)" : cadeiaOk ? "Íntegra: nenhuma evidência foi alterada." : "ALERTA: a cadeia de evidências não bate."}</dd>
        </dl>
        <div className="mt-4 flex flex-wrap gap-3">
          <a href={`/app/assinaturas/${e.id}/arquivo/original`} className={cn(botaoPequeno, "h-9 bg-muted hover:bg-muted/70")}>Baixar original</a>
          {e.hash_final ? <a href={`/app/assinaturas/${e.id}/arquivo/final`} className={cn(botaoPequeno, "h-9 bg-primary text-primary-foreground")}>Baixar PDF final assinado</a> : null}
          {e.status === "assinado" ? <form action={gerarPdfFinal.bind(null, e.id)}><button className={cn(botaoPequeno, "h-9 bg-primary text-primary-foreground")}>Gerar PDF final</button></form> : null}
          {aberto ? <form action={cancelarEnvelope.bind(null, e.id)}><button className={cn(botaoPequeno, "h-9 bg-red-50 text-red-700 hover:bg-red-100")}>Cancelar envelope</button></form> : null}
        </div>
      </section>

      <section className="mt-6 rounded-[26px] bg-white p-6 text-sm">
        <h2 className="text-lg font-semibold">Signatários</h2>
        <ul className="mt-3 divide-y">
          {(sigs ?? []).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="font-medium">{s.nome} <span className="font-normal text-muted-foreground">· ordem {s.ordem}</span></p>
                <p className="text-xs text-muted-foreground">{s.email}</p>
                {s.status === "assinado" ? (
                  <p className="text-xs text-muted-foreground">Assinou em {dataHora(s.assinado_em)} · CPF {formatarCpf(s.cpf ?? "")} · IP {s.ip ?? "—"}</p>
                ) : s.link_enviado_em ? (
                  <p className="text-xs text-muted-foreground">Link enviado em {dataHora(s.link_enviado_em)}; {s.token_expira_em && new Date(s.token_expira_em) > new Date() ? `vale até ${dataHora(s.token_expira_em)}` : "venceu"}</p>
                ) : <p className="text-xs text-muted-foreground">Ainda não é a vez dessa pessoa.</p>}
              </div>
              {s.status === "assinado" ? <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800">Assinou</span>
                : aberto && s.ordem === menorPendente ? (
                  <form action={reenviarLink.bind(null, e.id, s.id)}><button className={cn(botaoPequeno, "h-8 bg-muted text-xs hover:bg-muted/70")}>{s.link_enviado_em ? "Enviar novo link" : "Enviar link"}</button></form>
                ) : <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">Pendente</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 rounded-[26px] bg-white p-6 text-sm">
        <h2 className="text-lg font-semibold">Evidências</h2>
        <p className="mt-1 text-muted-foreground">Registro só de acréscimo: o banco não permite alterar nem apagar nenhuma linha.</p>
        <ol className="mt-3 divide-y">
          {(evid ?? []).map((v) => (
            <li key={v.id} className="py-2">
              <p><span className="font-medium">{ROTULO_EVIDENCIA[v.tipo] ?? v.tipo}</span>{v.signatario_id ? ` · ${nomes.get(v.signatario_id) ?? ""}` : ""}</p>
              <p className="text-xs text-muted-foreground">{dataHora(v.criado_em)}{v.ip ? ` · IP ${v.ip}` : ""}{v.tipo === "envio_email" && (v.dados as { enviado?: boolean }).enviado === false ? " · e-mail NÃO enviado" : ""}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
