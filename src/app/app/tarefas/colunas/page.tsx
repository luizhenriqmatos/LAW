import Link from "next/link";
import { exigirDono } from "@/lib/contexto";
import { cn } from "@/lib/utils";
import { Aviso, botaoPequeno } from "../../processos/comum";
import { criarColuna, moverColuna, removerColuna, renomearColuna } from "../actions";
import { campo } from "../dados";

export default async function Colunas({ searchParams }: PageProps<"/app/tarefas/colunas">) {
  const sp = await searchParams;
  const { supabase, vinculo } = await exigirDono();
  const { data } = await supabase.from("quadro_coluna").select("id, nome, concluida").eq("escritorio_id", vinculo.escritorioId).order("posicao");
  const colunas = (data ?? []) as { id: string; nome: string; concluida: boolean }[];
  const { data: usadas } = await supabase.from("tarefa").select("coluna_id").eq("escritorio_id", vinculo.escritorioId).limit(2000);
  const comTarefas = new Set(((usadas ?? []) as { coluna_id: string }[]).map((t) => t.coluna_id));

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/app/tarefas" className="text-sm font-semibold underline">← Quadro</Link>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">Colunas do quadro</h1>
      <p className="mt-2 text-sm text-muted-foreground">Só o dono do escritório mexe aqui. A coluna marcada como “conclui” é a que fecha a tarefa (no Google ela ganha ✔). Só dá para remover coluna vazia.</p>
      <Aviso codigo={sp.aviso} />
      <ul className="mt-4 grid gap-2">
        {colunas.map((c, i) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3">
            <form action={renomearColuna.bind(null, c.id)} className="flex flex-1 gap-2">
              <input name="nome" defaultValue={c.nome} required maxLength={40} aria-label={`Nome da coluna ${c.nome}`} className={campo} />
              <button className={cn(botaoPequeno, "h-10 bg-muted hover:bg-muted/70")}>Renomear</button>
            </form>
            {c.concluida ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">conclui</span> : null}
            <form action={moverColuna.bind(null, c.id, -1)}><button disabled={i === 0} aria-label={`Mover ${c.nome} para a esquerda`} className="h-8 w-8 rounded-full hover:bg-muted disabled:opacity-30">←</button></form>
            <form action={moverColuna.bind(null, c.id, 1)}><button disabled={i === colunas.length - 1} aria-label={`Mover ${c.nome} para a direita`} className="h-8 w-8 rounded-full hover:bg-muted disabled:opacity-30">→</button></form>
            <form action={removerColuna.bind(null, c.id)}>
              <button disabled={comTarefas.has(c.id) || colunas.length <= 1} className={cn(botaoPequeno, "text-red-800 hover:bg-red-50")}>Remover</button>
            </form>
          </li>
        ))}
      </ul>
      <form action={criarColuna} className="mt-4 flex gap-2 rounded-2xl bg-white p-3">
        <input name="nome" required maxLength={40} placeholder="Nova coluna" aria-label="Nome da nova coluna" className={campo} />
        <button className="h-10 shrink-0 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground">Criar coluna</button>
      </form>
    </div>
  );
}
