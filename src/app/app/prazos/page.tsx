import Link from "next/link";
import { exigirModulo } from "@/lib/contexto";
import { AVISO_PRAZO, diaDaSemana, nomeDoDia } from "@/lib/prazos/contagem";
import { situacaoDoPrazo } from "@/lib/prazos/alertas";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { somarDias } from "@/lib/integrations/fontes/datas";
import { cn } from "@/lib/utils";
import { Aviso, botaoPequeno, formatarCnj, formatarData } from "../processos/comum";
import { alterarResponsavelPrazo, alterarStatusPrazo, dispensarPrazo } from "./actions";
import { SeloPrazo } from "./comum";

type Prazo = {
  id: string; descricao: string; dias: number; tipo_contagem: string; data_final: string; status: string;
  data_disponibilizacao: string; data_publicacao: string; inicio_contagem: string;
  raciocinio: { passos?: { rotulo: string; explicacao: string }[] };
  processo: { id: string; numero_cnj: string; titulo: string | null } | null;
  responsavel: { id: string; nome: string; email: string } | null;
};
type Responsavel = { id: string; nome: string; email: string };
type PubSemPrazo = { id: string; data_disponibilizacao: string; tribunal: string; tipo_documento: string | null; texto: string; processo_id: string };

const VISOES = [
  { id: "hoje", rotulo: "Hoje" },
  { id: "semana", rotulo: "Esta semana" },
  { id: "vencidos", rotulo: "Vencidos" },
  { id: "todos", rotulo: "Todos" },
] as const;
const um = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const DATA = /^\d{4}-\d{2}-\d{2}$/;

export default async function Prazos({ searchParams }: PageProps<"/app/prazos">) {
  const sp = await searchParams;
  const { supabase, vinculo, usuario } = await exigirModulo("prazos");
  const esc = vinculo.escritorioId;
  const hoje = hojeBrasilia();
  const fimSemana = somarDias(hoje, (7 - diaDaSemana(hoje)) % 7);

  const visao = VISOES.find((v) => v.id === um(sp.visao))?.id ?? "todos";
  const status = ["abertos", "cumprido", "cancelado", "todos"].includes(um(sp.status) ?? "") ? (um(sp.status) as string) : "abertos";
  const de = DATA.test(um(sp.de) ?? "") ? um(sp.de)! : "";
  const ate = DATA.test(um(sp.ate) ?? "") ? um(sp.ate)! : "";
  const resp = um(sp.responsavel) ?? "";

  const { data: respData } = await supabase.rpc("responsaveis_prazo", { p_escritorio: esc });
  const responsaveis = (respData ?? []) as Responsavel[];
  const meu = responsaveis.find((r) => r.email.toLowerCase() === (usuario.email ?? "").toLowerCase());

  let q = supabase
    .from("prazo")
    .select("id, descricao, dias, tipo_contagem, data_final, status, data_disponibilizacao, data_publicacao, inicio_contagem, raciocinio, processo:processo_id(id, numero_cnj, titulo), responsavel:responsavel_id(id, nome, email)")
    .eq("escritorio_id", esc)
    .order("data_final", { ascending: true })
    .limit(300);
  if (visao === "hoje") q = q.eq("status", "aberto").lte("data_final", hoje); // hoje + atrasados: o que exige ação agora
  else if (visao === "semana") q = q.eq("status", "aberto").lte("data_final", fimSemana);
  else if (visao === "vencidos") q = q.eq("status", "aberto").lt("data_final", hoje);
  else if (status === "abertos") q = q.eq("status", "aberto");
  else if (status !== "todos") q = q.eq("status", status);
  if (de) q = q.gte("data_final", de);
  if (ate) q = q.lte("data_final", ate);
  if (resp === "eu" && meu) q = q.eq("responsavel_id", meu.id);
  else if (/^[0-9a-f-]{36}$/.test(resp)) q = q.eq("responsavel_id", resp);
  const { data, error } = await q;
  const prazos = (data ?? []) as unknown as Prazo[];

  // Publicações já ligadas a processo confirmado que ainda não viraram prazo (a "sugestão").
  const { data: pubsData } = await supabase
    .from("publicacao")
    .select("id, data_disponibilizacao, tribunal, tipo_documento, texto, processo_id")
    .eq("escritorio_id", esc)
    .eq("status_triagem", "vinculada")
    .is("sem_prazo_em", null)
    .order("data_disponibilizacao", { ascending: false })
    .limit(100);
  const pubs = (pubsData ?? []) as PubSemPrazo[];
  let sugeridas: PubSemPrazo[] = [];
  if (pubs.length) {
    const { data: ja } = await supabase.from("prazo").select("publicacao_id").in("publicacao_id", pubs.map((p) => p.id));
    const comPrazo = new Set((ja ?? []).map((x: { publicacao_id: string }) => x.publicacao_id));
    sugeridas = pubs.filter((p) => !comPrazo.has(p.id));
  }
  const { data: procs } = sugeridas.length
    ? await supabase.from("processo").select("id, numero_cnj").in("id", [...new Set(sugeridas.map((p) => p.processo_id))])
    : { data: [] };
  const cnj = new Map(((procs ?? []) as { id: string; numero_cnj: string }[]).map((p) => [p.id, p.numero_cnj]));

  const base = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ ...(de ? { de } : {}), ...(ate ? { ate } : {}), ...(resp ? { responsavel: resp } : {}), ...(status !== "abertos" ? { status } : {}), ...extra });
    return `/app/prazos?${p.toString()}`;
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-5xl font-medium tracking-tight">Prazos</h1>
        {vinculo.papel === "dono" ? (
          <Link href="/app/prazos/calendario" className={cn(botaoPequeno, "bg-white hover:bg-white/70")}>
            Calendário forense
          </Link>
        ) : null}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{AVISO_PRAZO}</p>
      <Aviso codigo={sp.aviso} />
      {error ? <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Não foi possível carregar os prazos.</p> : null}

      {sugeridas.length ? (
        <section className="mt-6 rounded-[26px] border-2 border-amber-300 bg-amber-50/60 p-5">
          <h2 className="font-semibold">Publicações esperando um prazo ({sugeridas.length})</h2>
          <p className="mt-1 text-sm text-muted-foreground">Cada publicação de processo confirmado pode gerar um prazo. Crie, ou diga que essa não gera.</p>
          <ul className="mt-3 grid gap-2">
            {sugeridas.slice(0, 20).map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm">
                <span className="font-semibold">{formatarData(p.data_disponibilizacao)}</span>
                <span className="font-mono text-xs">{formatarCnj(cnj.get(p.processo_id) ?? "")}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{[p.tipo_documento, p.texto].filter(Boolean).join(" · ")}</span>
                <Link href={`/app/prazos/novo?publicacao=${p.id}`} className={cn(botaoPequeno, "bg-primary text-primary-foreground")}>
                  Criar prazo
                </Link>
                <form action={dispensarPrazo.bind(null, p.id, "/app/prazos")}>
                  <button className={cn(botaoPequeno, "hover:bg-muted")}>Não gera prazo</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <nav aria-label="Visões" className="mt-6 flex flex-wrap gap-2">
        {VISOES.map((v) => (
          <Link key={v.id} href={base({ visao: v.id })} aria-current={v.id === visao ? "page" : undefined}
            className={cn("rounded-full px-4 py-2 text-sm font-semibold", v.id === visao ? "bg-primary text-primary-foreground" : "bg-white hover:bg-white/70")}>
            {v.rotulo}
          </Link>
        ))}
      </nav>

      <form className="mt-3 flex flex-wrap items-end gap-3 rounded-2xl bg-white p-4 text-sm" role="search">
        <input type="hidden" name="visao" value={visao} />
        <label className="grid gap-1">
          <span className="text-xs text-muted-foreground">Responsável</span>
          <select name="responsavel" defaultValue={resp} className="h-9 rounded-xl border bg-white px-2">
            <option value="">Todos</option>
            {meu ? <option value="eu">Eu</option> : null}
            {responsaveis.map((r) => <option key={r.id} value={r.id}>{r.nome || r.email}</option>)}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-muted-foreground">Situação</span>
          <select name="status" defaultValue={status} disabled={visao !== "todos"} className="h-9 rounded-xl border bg-white px-2 disabled:opacity-50">
            <option value="abertos">Abertos e vencidos</option>
            <option value="cumprido">Cumpridos</option>
            <option value="cancelado">Cancelados</option>
            <option value="todos">Todos</option>
          </select>
        </label>
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Vence de</span><input type="date" name="de" defaultValue={de} className="h-9 rounded-xl border px-2" /></label>
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">até</span><input type="date" name="ate" defaultValue={ate} className="h-9 rounded-xl border px-2" /></label>
        <button className="h-9 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground">Filtrar</button>
      </form>

      {prazos.length === 0 ? (
        <p className="mt-4 rounded-[26px] bg-white p-6 text-muted-foreground">
          {visao === "hoje" ? "Nada vence hoje nem está atrasado." : visao === "semana" ? "Nada vence até o fim da semana." : visao === "vencidos" ? "Nenhum prazo vencido em aberto." : "Nenhum prazo encontrado com esses filtros."}
        </p>
      ) : (
        <ul className="mt-4 grid gap-2">
          {prazos.map((p) => {
            const situacao = situacaoDoPrazo(p.status, p.data_final, hoje);
            const destino = "/app/prazos";
            return (
              <li key={p.id} id={p.id} className={cn("rounded-2xl bg-white px-4 py-3", sp.prazo === p.id && "ring-2 ring-primary")}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="w-44 shrink-0 text-sm font-semibold">
                    {nomeDoDia(p.data_final).split("-")[0]}, {formatarData(p.data_final)}
                  </span>
                  <SeloPrazo situacao={situacao} hoje={p.data_final === hoje && situacao === "aberto"} />
                  <span className="min-w-0 flex-1 font-medium">{p.descricao}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {p.processo ? (
                    <Link href={`/app/processos/${p.processo.id}`} className="font-mono font-semibold underline">{formatarCnj(p.processo.numero_cnj)}</Link>
                  ) : null}
                  {p.processo?.titulo ? ` · ${p.processo.titulo}` : ""} · {p.dias} dia(s) {p.tipo_contagem === "util" ? "úteis" : "corridos"} · responsável: {p.responsavel?.nome || p.responsavel?.email || "—"}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {p.status === "aberto" ? (
                    <>
                      <form action={alterarStatusPrazo.bind(null, p.id, "cumprido", destino)}><button className={cn(botaoPequeno, "bg-primary text-primary-foreground")}>Marcar cumprido</button></form>
                      <form action={alterarStatusPrazo.bind(null, p.id, "cancelado", destino)}><button className={cn(botaoPequeno, "text-red-700 hover:bg-red-50")}>Cancelar</button></form>
                    </>
                  ) : (
                    <form action={alterarStatusPrazo.bind(null, p.id, "aberto", destino)}><button className={cn(botaoPequeno, "bg-muted hover:bg-muted/70")}>Reabrir</button></form>
                  )}
                  <form action={alterarResponsavelPrazo.bind(null, p.id, destino)} className="flex items-center gap-1">
                    <label className="sr-only" htmlFor={`r-${p.id}`}>Responsável</label>
                    <select id={`r-${p.id}`} name="responsavel" defaultValue={p.responsavel?.id} className="h-8 rounded-full border bg-white px-2 text-xs">
                      {responsaveis.map((r) => <option key={r.id} value={r.id}>{r.nome || r.email}</option>)}
                    </select>
                    <button className={cn(botaoPequeno, "hover:bg-muted")}>Trocar</button>
                  </form>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">Ver como a data foi calculada</summary>
                  <ol className="mt-2 grid gap-1 text-sm">
                    {(p.raciocinio.passos ?? []).map((s, i) => (
                      <li key={i}><span className="font-semibold">{s.rotulo}:</span> {s.explicacao}</li>
                    ))}
                  </ol>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
