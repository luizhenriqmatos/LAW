import Link from "next/link";
import { googleConfigurado } from "@/lib/agenda/ambiente";
import { DIAS_SEMANA, diaValido, horaBrasilia, isoParaLocal, mesValido, mesVizinho, nomeDoMes, semanasDoMes } from "@/lib/agenda/calendario";
import { exigirModulo } from "@/lib/contexto";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { cn } from "@/lib/utils";
import { Aviso, botaoPequeno, formatarCnj, formatarData } from "../processos/comum";
import { campo, carregarOpcoes } from "../tarefas/dados";
import { apagarCompromisso, desconectarGoogle, mudarDataTarefa, salvarCompromisso } from "./actions";

const um = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

type Item = {
  tipo: "tarefa" | "prazo" | "compromisso"; id: string; titulo: string; dia: string; inicio: string | null; fim: string | null;
  responsavel_id: string | null; processo_id: string | null; numero_cnj: string | null; status: string; detalhe: string | null;
};
type Compromisso = { id: string; descricao: string; local: string; tipo: string; titulo: string; inicio: string; fim: string; responsavel_id: string | null; processo_id: string | null };
type StatusGoogle = { conectado: boolean; status?: "ativa" | "revogada" | "erro"; calendario?: string; erro?: string | null; ultimo_sync_em?: string | null };

const COR = {
  tarefa: "bg-sky-50 text-sky-900",
  prazo: "bg-amber-100 text-amber-900",
  compromisso: "bg-violet-100 text-violet-900",
} as const;
const ROTULO_TIPO = { audiencia: "Audiência", reuniao: "Reunião", outro: "Compromisso" } as const;

export default async function Agenda({ searchParams }: PageProps<"/app/agenda">) {
  const sp = await searchParams;
  const { supabase, vinculo } = await exigirModulo("agenda");
  const esc = vinculo.escritorioId;
  const hoje = hojeBrasilia();
  const mes = mesValido(um(sp.mes)) ?? hoje.slice(0, 7);
  const dia = diaValido(um(sp.dia)) ?? (mes === hoje.slice(0, 7) ? hoje : `${mes}-01`);
  const semanas = semanasDoMes(mes);
  const de = semanas[0][0].dia;
  const ate = semanas[semanas.length - 1][6].dia;

  const { data, error } = await supabase.rpc("agenda_itens", { p_escritorio: esc, p_de: de, p_ate: ate });
  const itens = ((data ?? []) as Item[]).sort((a, b) => (a.inicio ?? "").localeCompare(b.inicio ?? ""));
  const porDia = new Map<string, Item[]>();
  for (const i of itens) porDia.set(i.dia, [...(porDia.get(i.dia) ?? []), i]);
  const doDia = (porDia.get(dia) ?? []).sort((a, b) => ({ compromisso: 0, prazo: 1, tarefa: 2 })[a.tipo] - ({ compromisso: 0, prazo: 1, tarefa: 2 })[b.tipo]);

  const opcoes = await carregarOpcoes(supabase, esc);
  const nomes = new Map(opcoes.membros.map((m) => [m.id, m.nome]));
  const ids = doDia.filter((i) => i.tipo === "compromisso").map((i) => i.id);
  const { data: comps } = ids.length
    ? await supabase.from("compromisso").select("id, descricao, local, tipo, titulo, inicio, fim, responsavel_id, processo_id").in("id", ids)
    : { data: [] };
  const completos = new Map(((comps ?? []) as Compromisso[]).map((c) => [c.id, c]));

  const { data: sg } = await supabase.rpc("google_status", { p_escritorio: esc });
  const google = (sg ?? { conectado: false }) as StatusGoogle;
  const googleOk = googleConfigurado();

  const url = (extra: Record<string, string>) => `/app/agenda?${new URLSearchParams({ mes, ...extra }).toString()}`;
  const aqui = url({ dia });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-5xl font-medium tracking-tight">Agenda</h1>
        <Link href="/app/tarefas" className={cn(botaoPequeno, "bg-white hover:bg-white/70")}>Quadro de tarefas</Link>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">Prazos, tarefas com data e compromissos num lugar só. Prazo é sugestão: confira no sistema oficial do tribunal.</p>
      <Aviso codigo={sp.aviso} />
      {error ? <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Não foi possível carregar a agenda.</p> : null}

      <section className={cn("mt-5 rounded-[22px] p-4 text-sm", google.conectado && google.status !== "ativa" ? "border border-amber-300 bg-amber-50" : "bg-white")}>
        <h2 className="font-semibold">Google Agenda</h2>
        {google.conectado && google.status === "ativa" ? (
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <p className="flex-1 text-muted-foreground">
              Conectado. Seus prazos, tarefas e compromissos vão para o calendário “{google.calendario}” (só do LAW para o Google; mudanças feitas lá não voltam).
              {google.ultimo_sync_em ? ` Último envio: ${formatarData(google.ultimo_sync_em)}.` : ""}
            </p>
            <form action={desconectarGoogle}><button className={cn(botaoPequeno, "h-9 bg-muted hover:bg-muted/70")}>Desconectar</button></form>
          </div>
        ) : google.conectado ? (
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <p role="alert" className="flex-1 text-amber-950">
              {google.status === "revogada" ? "O acesso ao seu Google foi revogado ou expirou." : "A sincronização com o Google parou por um erro."} O envio está parado; o resto do LAW segue normal. Reconecte para voltar a enviar.
            </p>
            {googleOk ? <a href="/api/google/conectar" className={cn(botaoPequeno, "h-9 bg-primary text-primary-foreground")}>Reconectar</a> : null}
            <form action={desconectarGoogle}><button className={cn(botaoPequeno, "h-9 bg-white hover:bg-white/70")}>Remover conexão</button></form>
          </div>
        ) : googleOk ? (
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <p className="flex-1 text-muted-foreground">Conecte para ver seus prazos e tarefas no Google Agenda. Criamos um calendário separado chamado “LAW”; o LAW não lê nem mexe nos seus outros calendários.</p>
            <a href="/api/google/conectar" className={cn(botaoPequeno, "h-9 bg-primary text-primary-foreground")}>Conectar Google Agenda</a>
          </div>
        ) : (
          <p className="mt-1 text-muted-foreground">A conexão com o Google ainda não foi ativada neste LAW (falta configurar as credenciais). A agenda interna funciona normalmente.</p>
        )}
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        <section aria-label="Calendário do mês">
          <div className="flex items-center justify-between">
            <Link href={url({ mes: mesVizinho(mes, -1) })} aria-label="Mês anterior" className="rounded-full px-3 py-1 hover:bg-white/70">←</Link>
            <h2 className="text-lg font-semibold capitalize">{nomeDoMes(mes)}</h2>
            <Link href={url({ mes: mesVizinho(mes, 1) })} aria-label="Próximo mês" className="rounded-full px-3 py-1 hover:bg-white/70">→</Link>
          </div>
          <div className="mt-2 grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">{DIAS_SEMANA.map((d) => <span key={d}>{d}</span>)}</div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {semanas.flat().map((c) => {
              const lista = porDia.get(c.dia) ?? [];
              return (
                <Link
                  key={c.dia}
                  href={url({ mes: c.doMes ? mes : c.dia.slice(0, 7), dia: c.dia })}
                  aria-label={`${formatarData(c.dia)}: ${lista.length} item(ns)`}
                  aria-current={c.dia === dia ? "date" : undefined}
                  className={cn("min-h-20 rounded-xl p-1.5 text-xs", c.doMes ? "bg-white" : "bg-white/40 text-muted-foreground", c.dia === dia && "ring-2 ring-primary", c.dia === hoje && "font-bold")}
                >
                  <span>{Number(c.dia.slice(8))}</span>
                  <span className="mt-1 grid gap-0.5">
                    {lista.slice(0, 3).map((i) => (
                      <span key={`${i.tipo}${i.id}`} className={cn("truncate rounded px-1 py-0.5 text-[11px] leading-tight", COR[i.tipo], i.status === "feita" && "line-through opacity-60")}>{i.titulo}</span>
                    ))}
                    {lista.length > 3 ? <span className="text-[11px] text-muted-foreground">+{lista.length - 3}</span> : null}
                  </span>
                </Link>
              );
            })}
          </div>
          <p className="mt-2 flex gap-3 text-xs text-muted-foreground">
            <span className={cn("rounded px-1.5", COR.prazo)}>prazo</span><span className={cn("rounded px-1.5", COR.tarefa)}>tarefa</span><span className={cn("rounded px-1.5", COR.compromisso)}>compromisso</span>
          </p>
        </section>

        <aside aria-label={`Itens de ${formatarData(dia)}`}>
          <h2 className="text-lg font-semibold">{formatarData(dia)}</h2>
          {doDia.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Nada neste dia.</p> : (
            <ul className="mt-2 grid gap-2">
              {doDia.map((i) => {
                const comp = i.tipo === "compromisso" ? completos.get(i.id) : undefined;
                return (
                  <li key={`${i.tipo}${i.id}`} className="rounded-2xl bg-white p-3 text-sm">
                    <p className="flex items-start gap-2">
                      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", COR[i.tipo])}>
                        {i.tipo === "compromisso" ? ROTULO_TIPO[i.status as keyof typeof ROTULO_TIPO] ?? "Compromisso" : i.tipo === "prazo" ? (i.status === "cumprido" ? "Prazo cumprido" : i.dia < hoje ? "Prazo vencido" : "Prazo") : i.status === "feita" ? "Tarefa feita" : "Tarefa"}
                      </span>
                      {i.tipo === "tarefa" ? <Link href={`/app/tarefas/${i.id}`} className="font-semibold hover:underline">{i.titulo}</Link>
                        : i.tipo === "prazo" ? <Link href="/app/prazos" className="font-semibold hover:underline">{i.titulo}</Link>
                        : <span className="font-semibold">{i.titulo}</span>}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {i.inicio ? `${horaBrasilia(i.inicio)}${i.fim && i.fim !== i.inicio ? `–${horaBrasilia(i.fim)}` : ""} · ` : ""}
                      {i.responsavel_id ? nomes.get(i.responsavel_id) ?? "—" : "Sem responsável"}
                      {i.numero_cnj ? ` · ${formatarCnj(i.numero_cnj)}` : ""}
                      {i.tipo === "compromisso" && i.detalhe ? ` · ${i.detalhe}` : ""}
                    </p>
                    {i.tipo === "tarefa" ? (
                      <form action={mudarDataTarefa.bind(null, i.id)} className="mt-2 flex items-center gap-2">
                        <input type="hidden" name="voltar" value={aqui} />
                        <input type="date" name="data" defaultValue={i.dia} aria-label="Nova data da tarefa" className="h-8 rounded-lg border bg-white px-2 text-xs" />
                        <button className={cn(botaoPequeno, "bg-muted hover:bg-muted/70")}>Mudar data</button>
                      </form>
                    ) : null}
                    {comp ? <FormCompromisso c={comp} opcoes={opcoes} voltar={aqui} dia={dia} /> : null}
                  </li>
                );
              })}
            </ul>
          )}

          <details className="mt-4 rounded-2xl bg-white p-3 text-sm">
            <summary className="cursor-pointer font-semibold">+ Novo compromisso</summary>
            <FormCompromisso c={null} opcoes={opcoes} voltar={aqui} dia={dia} />
          </details>
        </aside>
      </div>
    </div>
  );
}

function FormCompromisso({ c, opcoes, voltar, dia }: { c: Compromisso | null; opcoes: Awaited<ReturnType<typeof carregarOpcoes>>; voltar: string; dia: string }) {
  const acao = salvarCompromisso.bind(null, c?.id ?? null);
  const corpo = (
    <form action={acao} className="mt-3 grid gap-2">
      <input type="hidden" name="voltar" value={voltar} />
      <input name="titulo" required maxLength={160} defaultValue={c?.titulo} placeholder="Título (ex.: Audiência de instrução)" aria-label="Título" className={campo} />
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-xs text-muted-foreground">Início<input type="datetime-local" name="inicio" required defaultValue={c ? isoParaLocal(c.inicio) : `${dia}T09:00`} className={campo} /></label>
        <label className="grid gap-1 text-xs text-muted-foreground">Fim<input type="datetime-local" name="fim" required defaultValue={c ? isoParaLocal(c.fim) : `${dia}T10:00`} className={campo} /></label>
      </div>
      <select name="tipo" defaultValue={c?.tipo ?? "reuniao"} aria-label="Tipo" className={campo}>
        <option value="audiencia">Audiência</option><option value="reuniao">Reunião</option><option value="outro">Outro</option>
      </select>
      <input name="local" maxLength={200} defaultValue={c?.local} placeholder="Local ou link (opcional)" aria-label="Local" className={campo} />
      <select name="responsavel" defaultValue={c?.responsavel_id ?? ""} aria-label="Responsável" className={campo}>
        <option value="">Sem responsável</option>{opcoes.membros.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
      </select>
      <select name="processo" defaultValue={c?.processo_id ?? ""} aria-label="Processo" className={campo}>
        <option value="">Sem processo</option>{opcoes.processos.map((p) => <option key={p.id} value={p.id}>{formatarCnj(p.numero_cnj)}</option>)}
      </select>
      <textarea name="descricao" rows={2} maxLength={4000} defaultValue={c?.descricao} placeholder="Observações (opcional)" aria-label="Observações" className="rounded-xl border bg-white px-3 py-2 text-sm" />
      <div><button className="h-9 rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground">{c ? "Salvar" : "Criar compromisso"}</button></div>
    </form>
  );
  if (!c) return corpo;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-semibold underline">Editar ou apagar</summary>
      {corpo}
      <form action={apagarCompromisso.bind(null, c.id)} className="mt-2">
        <input type="hidden" name="voltar" value={voltar} />
        <button className={cn(botaoPequeno, "text-red-800 hover:bg-red-50")}>Apagar compromisso</button>
      </form>
    </details>
  );
}
