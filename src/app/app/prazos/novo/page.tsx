import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { exigirModulo } from "@/lib/contexto";
import { AVISO_PRAZO, calcularPrazo, entradasDoTribunal, ErroContagem, sugerirDiasDoTexto, type ResultadoPrazo } from "@/lib/prazos/contagem";
import { carregarCalendario, hojeBrasilia } from "@/lib/prazos/servidor";
import { Aviso, formatarCnj, formatarData } from "../../processos/comum";
import { confirmarPrazo } from "../actions";

const um = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const MOTIVOS: Record<string, string> = { fim_de_semana: "fim de semana", feriado: "feriado", suspensao: "suspensão", recesso: "recesso" };

export default async function NovoPrazo({ searchParams }: PageProps<"/app/prazos/novo">) {
  const sp = await searchParams;
  const { supabase, vinculo } = await exigirModulo("prazos");
  const esc = vinculo.escritorioId;
  const idPub = um(sp.publicacao);
  let idProc = um(sp.processo);

  type Pub = { id: string; data_disponibilizacao: string; texto: string; tipo_documento: string | null; tribunal: string; processo_id: string | null; status_triagem: string };
  let pub: Pub | null = null;
  if (idPub) {
    if (!z.uuid().safeParse(idPub).success) notFound();
    const { data } = await supabase.from("publicacao").select("id, data_disponibilizacao, texto, tipo_documento, tribunal, processo_id, status_triagem").eq("id", idPub).eq("escritorio_id", esc).maybeSingle();
    if (!data) notFound();
    pub = data as Pub;
    idProc = pub.processo_id ?? undefined;
  }
  if (!idProc || !z.uuid().safeParse(idProc).success) notFound();
  const { data: proc } = await supabase.from("processo").select("id, numero_cnj, titulo, tribunal, status").eq("id", idProc).eq("escritorio_id", esc).maybeSingle();
  if (!proc) notFound();

  const voltarPara = pub ? `/app/prazos/novo?publicacao=${pub.id}` : `/app/prazos/novo?processo=${proc.id}`;
  const { data: respData } = await supabase.rpc("responsaveis_prazo", { p_escritorio: esc });
  const responsaveis = (respData ?? []) as { id: string; nome: string; email: string }[];

  // Valores do formulário: o que veio na URL, senão a sugestão tirada do texto da publicação.
  const sugestao = pub ? sugerirDiasDoTexto(pub.texto) : null;
  const dias = Number(um(sp.dias) ?? sugestao?.dias ?? "");
  const tipo = um(sp.tipo) === "corrido" ? "corrido" : um(sp.tipo) === "util" ? "util" : sugestao?.tipo ?? "util";
  const responsavel = um(sp.responsavel) ?? "";
  const descricao = um(sp.descricao) ?? (pub?.tipo_documento ? `Prazo — ${pub.tipo_documento}` : "");
  const disp = pub?.data_disponibilizacao ?? um(sp.disp) ?? "";

  // Cálculo (só se já tem dias e data). Tudo em código determinístico.
  let resultado: ResultadoPrazo | null = null;
  let erroCalculo: string | null = null;
  if (um(sp.calcular) !== undefined || um(sp.dias)) {
    try {
      if (!disp) throw new ErroContagem("Informe a data de disponibilização.");
      const calendario = entradasDoTribunal(await carregarCalendario(supabase, esc), proc.tribunal);
      resultado = calcularPrazo({ disponibilizacao: disp, dias, tipo, calendario });
    } catch (e) {
      if (!(e instanceof ErroContagem)) throw e;
      erroCalculo = e.message;
    }
  }
  const hoje = hojeBrasilia();

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/app/processos/${proc.id}`} className="text-sm font-medium text-muted-foreground hover:underline">‹ Processo</Link>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">Novo prazo</h1>
      <p className="mt-1 font-mono text-sm">{formatarCnj(proc.numero_cnj)}{proc.titulo ? ` · ${proc.titulo}` : ""}</p>
      <Aviso codigo={sp.aviso} />
      {proc.status !== "confirmado" ? (
        <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Este processo ainda é provisório. Confirme-o na <Link href={`/app/processos/${proc.id}`} className="font-semibold underline">tela do processo</Link> para criar prazos.
        </p>
      ) : null}

      {pub ? (
        <section className="mt-6 rounded-[26px] bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Publicação de {formatarData(pub.data_disponibilizacao)} · {pub.tribunal}</h2>
          <p className="mt-2 line-clamp-6 whitespace-pre-line text-sm">{pub.texto}</p>
          {sugestao ? (
            <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-sm">
              Sugestão: o texto fala em <strong>“{sugestao.trecho}”</strong>. Conferimos só o número; <strong>leia a publicação</strong> e ajuste se precisar.
            </p>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Não achamos a quantidade de dias no texto. Informe abaixo.</p>
          )}
        </section>
      ) : null}

      <form method="get" className="mt-6 grid gap-4 rounded-[26px] bg-white p-6">
        {pub ? <input type="hidden" name="publicacao" value={pub.id} /> : <input type="hidden" name="processo" value={proc.id} />}
        {!pub ? (
          <label className="grid gap-1.5 text-sm font-medium">Data de disponibilização
            <input type="date" name="disp" defaultValue={disp} max={hoje} required className="h-10 rounded-xl border px-3" />
          </label>
        ) : null}
        <label className="grid gap-1.5 text-sm font-medium">O que precisa ser feito
          <input name="descricao" defaultValue={descricao} required minLength={3} maxLength={200} placeholder="Ex.: Manifestar sobre a contestação" className="h-10 rounded-xl border px-3" />
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="grid gap-1.5 text-sm font-medium">Quantidade de dias
            <input type="number" name="dias" defaultValue={Number.isFinite(dias) && dias > 0 ? dias : ""} min={1} max={365} required className="h-10 rounded-xl border px-3" />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">Contagem
            <select name="tipo" defaultValue={tipo} className="h-10 rounded-xl border bg-white px-3">
              <option value="util">Dias úteis (padrão, CPC art. 219)</option>
              <option value="corrido">Dias corridos</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">Responsável
            <select name="responsavel" defaultValue={responsavel} required className="h-10 rounded-xl border bg-white px-3">
              <option value="" disabled>Escolha…</option>
              {responsaveis.map((r) => <option key={r.id} value={r.id}>{r.nome || r.email}</option>)}
            </select>
          </label>
        </div>
        <div><button name="calcular" value="1" className="h-10 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground">Calcular data final</button></div>
      </form>

      {erroCalculo ? <p role="alert" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{erroCalculo}</p> : null}

      {resultado ? (
        <section className="mt-6 rounded-[26px] border-2 border-primary p-6">
          <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Data final sugerida</p>
          <p className="mt-1 text-4xl font-medium tracking-tight">{formatarData(resultado.dataFinal)}</p>
          <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-sm font-medium text-amber-950">{AVISO_PRAZO}</p>

          <h2 className="mt-5 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Como chegamos nessa data</h2>
          <ol className="mt-2 grid gap-2 text-sm">
            {resultado.passos.slice(0, -1).map((p, i) => (
              <li key={i}><span className="font-semibold">{p.rotulo}{p.data ? ` — ${formatarData(p.data)}` : ""}.</span> {p.explicacao}</li>
            ))}
          </ol>
          {resultado.diasPulados.length ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-semibold">Dias pulados ({resultado.diasPulados.length})</summary>
              <ul className="mt-2 grid gap-0.5 text-sm text-muted-foreground">
                {resultado.diasPulados.map((d) => <li key={d.data}>{formatarData(d.data)} — {MOTIVOS[d.motivo]}: {d.descricao}</li>)}
              </ul>
            </details>
          ) : null}

          <form action={confirmarPrazo} className="mt-6">
            <input type="hidden" name="processo" value={proc.id} />
            {pub ? <input type="hidden" name="publicacao" value={pub.id} /> : null}
            <input type="hidden" name="descricao" value={descricao} />
            <input type="hidden" name="dias" value={resultado.dias} />
            <input type="hidden" name="tipo" value={resultado.tipo} />
            <input type="hidden" name="responsavel" value={responsavel} />
            <input type="hidden" name="disp" value={disp} />
            <input type="hidden" name="esperada" value={resultado.dataFinal} />
            <input type="hidden" name="voltar" value={voltarPara} />
            <button disabled={!responsavel || descricao.length < 3 || proc.status !== "confirmado"} className="h-11 rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground disabled:opacity-50">
              Conferi e confirmo o prazo
            </button>
            {!responsavel ? <p className="mt-2 text-sm text-muted-foreground">Escolha o responsável e calcule de novo para confirmar.</p> : null}
            <p className="mt-2 text-xs text-muted-foreground">Só depois de confirmar o prazo passa a existir e gerar alertas.</p>
          </form>
        </section>
      ) : null}
    </div>
  );
}
