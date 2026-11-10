import Link from "next/link";
import { z } from "zod";
import { LIMITE_PDF_BYTES } from "@/lib/assinatura/pdf";
import { exigirModulo } from "@/lib/contexto";
import { listarArquivos } from "@/lib/drive/arquivos";
import { depsDriveDoAmbiente, driveConfigurado } from "@/lib/drive/ambiente";
import { servicoConfigurado } from "@/lib/supabase/servico";
import { cn } from "@/lib/utils";
import { botaoPequeno } from "../processos/comum";
import { criarEnvelope } from "./actions";
import { AvisoAssinatura, AvisoTipoAssinatura, dataHora, STATUS_ENVELOPE } from "./comum";

const LINHAS = 6;
const campo = "w-full rounded-xl border bg-white px-3 py-2 text-sm";

export default async function PaginaAssinaturas({ searchParams }: PageProps<"/app/assinaturas">) {
  const sp = await searchParams;
  const { supabase, vinculo } = await exigirModulo("assinaturas");

  const [{ data: envelopes }, { data: sigs }, { data: processos }] = await Promise.all([
    supabase.from("assinatura_envelope").select("id, titulo, status, criado_em, concluido_em").order("criado_em", { ascending: false }).limit(50),
    supabase.from("assinatura_signatario").select("envelope_id, status"),
    supabase.rpc("assinatura_processos", { p_escritorio: vinculo.escritorioId }),
  ]);
  const progresso = new Map<string, { total: number; feitos: number }>();
  for (const s of sigs ?? []) {
    const p = progresso.get(s.envelope_id) ?? { total: 0, feitos: 0 };
    p.total++;
    if (s.status === "assinado") p.feitos++;
    progresso.set(s.envelope_id, p);
  }
  const listaProcessos = (processos ?? []) as { id: string; numero_cnj: string }[];

  // PDF da pasta do processo no Drive (escolhido o processo na própria página).
  const processoEscolhido = z.uuid().safeParse(sp.processo).success ? String(sp.processo) : null;
  let arquivosDrive: { id: string; nome: string }[] = [];
  let avisoDrive: string | null = null;
  if (processoEscolhido) {
    if (!driveConfigurado() || !servicoConfigurado()) avisoDrive = "O Google Drive ainda não está ativo neste LAW. Envie o PDF do seu computador.";
    else {
      const { data: pasta } = await supabase.rpc("assinatura_pasta_processo", { p_processo: processoEscolhido });
      const p = pasta as { escritorio_id: string; drive_id: string } | null;
      if (!p) avisoDrive = "Esse processo ainda não tem pasta no Drive.";
      else {
        const r = await listarArquivos(depsDriveDoAmbiente(), p.escritorio_id, p.drive_id);
        if (!r.ok) avisoDrive = "Não foi possível ler a pasta do Drive agora.";
        else {
          arquivosDrive = r.dados.filter((a) => !a.pasta && /\.pdf$/i.test(a.nome) && (a.tamanho ?? 0) <= LIMITE_PDF_BYTES).map((a) => ({ id: a.id, nome: a.nome }));
          if (!arquivosDrive.length) avisoDrive = "Não há PDF (até 4 MB) enviado pelo LAW nesta pasta.";
        }
      }
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-5xl font-medium tracking-tight">Assinaturas</h1>
      <p className="mt-3 text-muted-foreground">Envie contratos e procurações para assinatura eletrônica. Cada passo fica registrado como evidência que ninguém consegue apagar ou alterar.</p>
      <AvisoTipoAssinatura className="mt-4" />
      <AvisoAssinatura codigo={sp.aviso} />

      <section className="mt-6 rounded-[26px] bg-white p-6">
        <h2 className="text-lg font-semibold">Novo envelope</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Ao enviar, o sistema calcula o hash SHA-256 do PDF e <strong>congela o arquivo</strong>: não dá mais para trocá-lo. Cada signatário recebe um link próprio, que vale por 7 dias.
        </p>

        <form method="get" className="mt-4 flex flex-wrap items-end gap-3 text-sm">
          <label className="grid gap-1">
            <span className="font-medium">Processo (opcional, para escolher o PDF da pasta dele no Drive)</span>
            <select name="processo" defaultValue={processoEscolhido ?? ""} className={cn(campo, "w-80")}>
              <option value="">Nenhum</option>
              {listaProcessos.map((p) => <option key={p.id} value={p.id}>{p.numero_cnj}</option>)}
            </select>
          </label>
          <button className={cn(botaoPequeno, "h-9 bg-muted hover:bg-muted/70")}>Ver PDFs da pasta</button>
        </form>
        {avisoDrive ? <p className="mt-2 text-sm text-muted-foreground">{avisoDrive}</p> : null}

        <form action={criarEnvelope} className="mt-5 grid gap-4 text-sm">
          <input type="hidden" name="processo" value={processoEscolhido ?? ""} />
          <label className="grid gap-1">
            <span className="font-medium">Título do documento</span>
            <input name="titulo" required minLength={3} maxLength={200} placeholder="Contrato de honorários - Fulano" className={campo} />
          </label>
          {arquivosDrive.length ? (
            <label className="grid gap-1">
              <span className="font-medium">PDF da pasta do processo</span>
              <select name="arquivo_drive" defaultValue="" className={campo}>
                <option value="">Prefiro enviar do computador</option>
                {arquivosDrive.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
              </select>
            </label>
          ) : null}
          <label className="grid gap-1">
            <span className="font-medium">PDF do computador (até 4 MB, sem senha)</span>
            <input type="file" name="arquivo" accept="application/pdf,.pdf" className={campo} />
          </label>
          <fieldset className="grid gap-2">
            <legend className="font-medium">Signatários</legend>
            <p className="text-xs text-muted-foreground">
              A ordem é opcional: deixe em branco (ou use o mesmo número) para todos receberem juntos. Com números diferentes, cada grupo só recebe o link depois que o anterior assinou.
            </p>
            {Array.from({ length: LINHAS }, (_, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_5rem]">
                <input name="sig_nome" aria-label={`Nome do signatário ${i + 1}`} placeholder="Nome completo" maxLength={120} className={campo} />
                <input name="sig_email" type="email" aria-label={`E-mail do signatário ${i + 1}`} placeholder="E-mail" maxLength={200} className={campo} />
                <input name="sig_ordem" type="number" min={1} max={20} aria-label={`Ordem do signatário ${i + 1}`} placeholder="Ordem" className={campo} />
              </div>
            ))}
          </fieldset>
          <button className={cn(botaoPequeno, "h-10 w-fit bg-primary px-5 text-primary-foreground")}>Congelar PDF e enviar para assinatura</button>
        </form>
      </section>

      <section className="mt-6 rounded-[26px] bg-white p-6">
        <h2 className="text-lg font-semibold">Envelopes</h2>
        {!envelopes?.length ? <p className="mt-2 text-sm text-muted-foreground">Nenhum envelope ainda.</p> : (
          <ul className="mt-3 divide-y text-sm">
            {envelopes.map((e) => {
              const st = STATUS_ENVELOPE[e.status] ?? STATUS_ENVELOPE.enviado;
              const p = progresso.get(e.id);
              return (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <Link href={`/app/assinaturas/${e.id}`} className="font-medium hover:underline">{e.titulo}</Link>
                    <p className="text-xs text-muted-foreground">Criado em {dataHora(e.criado_em)}{p ? ` · ${p.feitos} de ${p.total} assinaram` : ""}</p>
                  </div>
                  <span className={cn("rounded-full px-3 py-1 text-xs font-medium", st.estilo)}>{st.rotulo}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
