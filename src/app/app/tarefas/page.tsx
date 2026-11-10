import Link from "next/link";
import { exigirModulo } from "@/lib/contexto";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { progressoChecklist, type ItemChecklist } from "@/lib/tarefas/ordem";
import { cn } from "@/lib/utils";
import { Aviso, botaoPequeno, formatarCnj, formatarData } from "../processos/comum";
import { criarTarefa } from "./actions";
import { campo, carregarOpcoes } from "./dados";
import { Quadro, type CartaoQuadro } from "./quadro";

const um = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const UUID = /^[0-9a-f-]{36}$/;

type Linha = {
  id: string; coluna_id: string; posicao: number; titulo: string; data: string | null; responsavel_id: string | null;
  processo_id: string | null; etiquetas: string[]; checklist: ItemChecklist[]; concluida_em: string | null;
};

export default async function Tarefas({ searchParams }: PageProps<"/app/tarefas">) {
  const sp = await searchParams;
  const { supabase, vinculo } = await exigirModulo("tarefas");
  const esc = vinculo.escritorioId;
  const resp = um(sp.responsavel) ?? "";
  const proc = um(sp.processo) ?? "";
  const etiqueta = (um(sp.etiqueta) ?? "").trim();
  const filtrando = !!(resp || proc || etiqueta);

  const { data: colunasData } = await supabase.from("quadro_coluna").select("id, nome, concluida").eq("escritorio_id", esc).order("posicao");
  const colunas = (colunasData ?? []) as { id: string; nome: string; concluida: boolean }[];

  let q = supabase
    .from("tarefa")
    .select("id, coluna_id, posicao, titulo, data, responsavel_id, processo_id, etiquetas, checklist, concluida_em")
    .eq("escritorio_id", esc)
    .order("posicao")
    .limit(1000);
  if (resp === "eu") q = q.eq("responsavel_id", vinculo.membroId);
  else if (resp === "ninguem") q = q.is("responsavel_id", null);
  else if (UUID.test(resp)) q = q.eq("responsavel_id", resp);
  if (UUID.test(proc)) q = q.eq("processo_id", proc);
  if (etiqueta) q = q.contains("etiquetas", [etiqueta]);
  const { data, error } = await q;
  const linhas = (data ?? []) as Linha[];

  const opcoes = await carregarOpcoes(supabase, esc);
  const nomes = new Map(opcoes.membros.map((m) => [m.id, m.nome]));
  const cnjs = new Map(opcoes.processos.map((p) => [p.id, p.numero_cnj]));
  const hoje = hojeBrasilia();

  // Etiquetas existentes (para o filtro): vêm de todas as tarefas do escritório, não só das filtradas.
  const { data: todas } = await supabase.from("tarefa").select("etiquetas").eq("escritorio_id", esc).limit(1000);
  const etiquetasDoEscritorio = [...new Set(((todas ?? []) as { etiquetas: string[] }[]).flatMap((t) => t.etiquetas))].sort((a, b) => a.localeCompare(b, "pt-BR"));

  const cartoes: CartaoQuadro[] = linhas.map((t) => {
    const prog = progressoChecklist(t.checklist ?? []);
    return {
      id: t.id, colunaId: t.coluna_id, posicao: t.posicao, titulo: t.titulo, data: t.data,
      dataTexto: formatarData(t.data), atrasada: !!t.data && t.data < hoje,
      responsavel: t.responsavel_id ? (nomes.get(t.responsavel_id) ?? "—") : null,
      etiquetas: t.etiquetas ?? [], feitos: prog.feitos, total: prog.total,
      cnj: t.processo_id && cnjs.has(t.processo_id) ? formatarCnj(cnjs.get(t.processo_id)!) : null,
      feita: !!t.concluida_em,
    };
  });

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-5xl font-medium tracking-tight">Tarefas</h1>
        <div className="flex gap-2">
          <Link href="/app/agenda" className={cn(botaoPequeno, "bg-white hover:bg-white/70")}>Ver na agenda</Link>
          {vinculo.papel === "dono" ? <Link href="/app/tarefas/colunas" className={cn(botaoPequeno, "bg-white hover:bg-white/70")}>Colunas</Link> : null}
        </div>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">Tarefa com data aparece sozinha na Agenda. Mudar a data aqui muda lá, e o contrário também.</p>
      <Aviso codigo={sp.aviso} />
      {error ? <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Não foi possível carregar as tarefas.</p> : null}

      <details className="mt-5 rounded-[22px] bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold">+ Nova tarefa</summary>
        <form action={criarTarefa} className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-muted-foreground">Título</span><input name="titulo" required maxLength={160} className={campo} /></label>
          <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-muted-foreground">Descrição (opcional)</span><textarea name="descricao" rows={2} maxLength={4000} className="rounded-xl border bg-white px-3 py-2 text-sm" /></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Coluna</span>
            <select name="coluna" className={campo}>{colunas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Responsável</span>
            <select name="responsavel" defaultValue={vinculo.membroId} className={campo}><option value="">Sem responsável</option>{opcoes.membros.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}</select></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Data (opcional)</span><input type="date" name="data" className={campo} /></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Etiquetas (separe por vírgula)</span><input name="etiquetas" maxLength={600} className={campo} /></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Processo (opcional)</span>
            <select name="processo" className={campo}><option value="">Nenhum</option>{opcoes.processos.map((p) => <option key={p.id} value={p.id}>{formatarCnj(p.numero_cnj)}{p.titulo ? ` — ${p.titulo}` : ""}</option>)}</select></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Cliente (opcional)</span>
            <select name="cliente" className={campo}><option value="">Nenhum</option>{opcoes.clientes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></label>
          <div className="sm:col-span-2"><button className="h-10 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground">Criar tarefa</button></div>
        </form>
      </details>

      <form className="mt-4 flex flex-wrap items-end gap-3 rounded-2xl bg-white p-4 text-sm" role="search">
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Responsável</span>
          <select name="responsavel" defaultValue={resp} className="h-9 rounded-xl border bg-white px-2">
            <option value="">Todos</option><option value="eu">Eu</option><option value="ninguem">Sem responsável</option>
            {opcoes.membros.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
          </select></label>
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Processo</span>
          <select name="processo" defaultValue={proc} className="h-9 max-w-64 rounded-xl border bg-white px-2">
            <option value="">Todos</option>{opcoes.processos.map((p) => <option key={p.id} value={p.id}>{formatarCnj(p.numero_cnj)}</option>)}
          </select></label>
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Etiqueta</span>
          <select name="etiqueta" defaultValue={etiqueta} className="h-9 rounded-xl border bg-white px-2">
            <option value="">Todas</option>{etiquetasDoEscritorio.map((e) => <option key={e} value={e}>{e}</option>)}
          </select></label>
        <button className="h-9 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground">Filtrar</button>
        {filtrando ? <Link href="/app/tarefas" className="h-9 content-center text-sm font-semibold underline">Limpar filtros</Link> : null}
      </form>

      <div className="mt-5">
        <Quadro colunas={colunas} cartoes={cartoes} podeArrastar={!filtrando} />
      </div>
    </div>
  );
}
