import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { exigirModulo } from "@/lib/contexto";
import { progressoChecklist, type ItemChecklist } from "@/lib/tarefas/ordem";
import { cn } from "@/lib/utils";
import { Aviso, botaoPequeno, formatarCnj, formatarData } from "../../processos/comum";
import {
  adicionarItemChecklist, alternarItemChecklist, apagarTarefa, comentarTarefa, moverTarefaForm, removerItemChecklist, salvarTarefa,
} from "../actions";
import { campo, carregarOpcoes } from "../dados";

type Tarefa = {
  id: string; coluna_id: string; titulo: string; descricao: string; responsavel_id: string | null; data: string | null;
  processo_id: string | null; cliente_id: string | null; etiquetas: string[]; checklist: ItemChecklist[]; concluida_em: string | null;
};
type Comentario = { id: string; texto: string; criado_em: string; autor: { nome: string; email: string } | null };

export default async function CartaoTarefa({ params, searchParams }: PageProps<"/app/tarefas/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, vinculo } = await exigirModulo("tarefas");
  const esc = vinculo.escritorioId;

  const { data } = await supabase
    .from("tarefa")
    .select("id, coluna_id, titulo, descricao, responsavel_id, data, processo_id, cliente_id, etiquetas, checklist, concluida_em")
    .eq("id", id).eq("escritorio_id", esc).maybeSingle();
  if (!data) notFound();
  const t = data as Tarefa;

  const [{ data: colunas }, { data: coms }, opcoes, procSigilo] = await Promise.all([
    supabase.from("quadro_coluna").select("id, nome").eq("escritorio_id", esc).order("posicao"),
    supabase.from("tarefa_comentario").select("id, texto, criado_em, autor:autor_id (nome, email)").eq("tarefa_id", id).order("criado_em"),
    carregarOpcoes(supabase, esc),
    t.processo_id ? supabase.from("processo").select("segredo_justica").eq("id", t.processo_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const comentarios = (coms ?? []) as unknown as Comentario[];
  const prog = progressoChecklist(t.checklist ?? []);
  const restrito = !!(procSigilo.data as { segredo_justica?: boolean } | null)?.segredo_justica;
  const processoAtual = opcoes.processos.find((p) => p.id === t.processo_id);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/app/tarefas" className="text-sm font-semibold underline">← Quadro</Link>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">{t.titulo}</h1>
      <Aviso codigo={sp.aviso} />
      {restrito ? <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800">Processo em segredo de justiça: no Google Agenda esta tarefa aparece sem título nem descrição.</p> : null}

      <form action={salvarTarefa.bind(null, id)} className="mt-5 grid gap-3 rounded-[22px] bg-white p-5 sm:grid-cols-2">
        <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-muted-foreground">Título</span><input name="titulo" required maxLength={160} defaultValue={t.titulo} className={campo} /></label>
        <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-muted-foreground">Descrição</span><textarea name="descricao" rows={4} maxLength={4000} defaultValue={t.descricao} className="rounded-xl border bg-white px-3 py-2 text-sm" /></label>
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Responsável</span>
          <select name="responsavel" defaultValue={t.responsavel_id ?? ""} className={campo}><option value="">Sem responsável</option>{opcoes.membros.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}</select></label>
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Data (aparece na Agenda)</span><input type="date" name="data" defaultValue={t.data ?? ""} className={campo} /></label>
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Processo</span>
          <select name="processo" defaultValue={t.processo_id ?? ""} className={campo}>
            <option value="">Nenhum</option>
            {t.processo_id && !processoAtual ? <option value={t.processo_id}>(processo atual)</option> : null}
            {opcoes.processos.map((p) => <option key={p.id} value={p.id}>{formatarCnj(p.numero_cnj)}{p.titulo ? ` — ${p.titulo}` : ""}</option>)}
          </select></label>
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Cliente</span>
          <select name="cliente" defaultValue={t.cliente_id ?? ""} className={campo}>
            <option value="">Nenhum</option>
            {t.cliente_id && !opcoes.clientes.some((c) => c.id === t.cliente_id) ? <option value={t.cliente_id}>(cliente atual)</option> : null}
            {opcoes.clientes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select></label>
        <label className="grid gap-1 sm:col-span-2"><span className="text-xs text-muted-foreground">Etiquetas (separe por vírgula)</span><input name="etiquetas" defaultValue={(t.etiquetas ?? []).join(", ")} maxLength={600} className={campo} /></label>
        <div className="sm:col-span-2"><button className="h-10 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground">Salvar</button></div>
      </form>

      <form action={moverTarefaForm.bind(null, id)} className="mt-4 flex flex-wrap items-end gap-3 rounded-2xl bg-white p-4 text-sm">
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Coluna</span>
          <select name="coluna" defaultValue={t.coluna_id} className="h-9 rounded-xl border bg-white px-2">{(colunas ?? []).map((c: { id: string; nome: string }) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></label>
        <button className={cn(botaoPequeno, "h-9 bg-primary text-primary-foreground")}>Mover</button>
        {t.concluida_em ? <span className="text-xs text-muted-foreground">Concluída em {formatarData(t.concluida_em)}</span> : null}
      </form>

      <section className="mt-4 rounded-[22px] bg-white p-5">
        <h2 className="font-semibold">Checklist {prog.total ? <span className="text-sm font-normal text-muted-foreground">({prog.feitos}/{prog.total})</span> : null}</h2>
        <ul className="mt-2 grid gap-1">
          {(t.checklist ?? []).map((i) => (
            <li key={i.id} className="flex items-center gap-2 text-sm">
              <form action={alternarItemChecklist.bind(null, id, i.id)}>
                <button aria-label={i.feito ? "Desmarcar" : "Marcar como feito"} className="h-6 w-6 rounded-md border text-xs">{i.feito ? "✔" : ""}</button>
              </form>
              <span className={cn("flex-1", i.feito && "text-muted-foreground line-through")}>{i.texto}</span>
              <form action={removerItemChecklist.bind(null, id, i.id)}><button className="text-xs text-muted-foreground underline">remover</button></form>
            </li>
          ))}
        </ul>
        <form action={adicionarItemChecklist.bind(null, id)} className="mt-3 flex gap-2">
          <input name="texto" required maxLength={200} placeholder="Novo item" className={campo} />
          <button className={cn(botaoPequeno, "h-10 bg-muted hover:bg-muted/70")}>Adicionar</button>
        </form>
      </section>

      <section className="mt-4 rounded-[22px] bg-white p-5">
        <h2 className="font-semibold">Comentários</h2>
        {comentarios.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Nenhum comentário ainda.</p> : (
          <ul className="mt-2 grid gap-2">
            {comentarios.map((c) => (
              <li key={c.id} className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
                <p className="text-xs text-muted-foreground">{c.autor?.nome?.trim() || c.autor?.email || "Ex-membro"} · {formatarData(c.criado_em)}</p>
                <p className="mt-1 whitespace-pre-wrap">{c.texto}</p>
              </li>
            ))}
          </ul>
        )}
        <form action={comentarTarefa.bind(null, id)} className="mt-3 grid gap-2">
          <textarea name="texto" required rows={2} maxLength={2000} className="rounded-xl border bg-white px-3 py-2 text-sm" aria-label="Novo comentário" />
          <div><button className={cn(botaoPequeno, "h-9 bg-primary text-primary-foreground")}>Comentar</button></div>
        </form>
      </section>

      <details className="mt-4 rounded-2xl bg-white p-4 text-sm">
        <summary className="cursor-pointer font-semibold text-red-800">Apagar tarefa</summary>
        <p className="mt-2 text-muted-foreground">Apagar remove o cartão, o checklist e os comentários, e tira o evento do seu Google Agenda. Não dá para desfazer.</p>
        <form action={apagarTarefa.bind(null, id)} className="mt-3"><button className={cn(botaoPequeno, "h-9 bg-red-700 text-white")}>Sim, apagar de vez</button></form>
      </details>
    </div>
  );
}
