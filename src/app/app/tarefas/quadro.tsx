"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition, type DragEvent } from "react";
import { cn } from "@/lib/utils";
import { daColuna, reordenar } from "@/lib/tarefas/ordem";
import { moverTarefa } from "./actions";

export type CartaoQuadro = {
  id: string; colunaId: string; posicao: number; titulo: string; data: string | null; dataTexto: string; atrasada: boolean;
  responsavel: string | null; etiquetas: string[]; feitos: number; total: number; cnj: string | null; feita: boolean;
};
export type ColunaQuadro = { id: string; nome: string; concluida: boolean };

const ERROS: Record<string, string> = {
  sem_permissao: "Você não tem permissão para mover tarefas.",
  tarefa_invalida: "Essa tarefa não existe mais. Atualize a página.",
  coluna_invalida: "Essa coluna não existe mais. Atualize a página.",
};

/**
 * Quadro com arrastar e soltar (HTML nativo). A tela muda na hora (otimista); o banco grava a ordem.
 * Se o banco recusar, a tela volta ao que estava e avisa. Também dá para mover com os botões (teclado/celular).
 * Com filtro ligado o arrastar fica desligado: a posição dentro de uma lista filtrada não seria a posição real.
 */
export function Quadro({ colunas, cartoes, podeArrastar }: { colunas: ColunaQuadro[]; cartoes: CartaoQuadro[]; podeArrastar: boolean }) {
  const [itens, aplicar] = useOptimistic(cartoes, (atual, m: { id: string; coluna: string; indice: number }) =>
    reordenar(atual, m.id, m.coluna, m.indice),
  );
  const [pendente, iniciar] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [alvo, setAlvo] = useState<{ coluna: string; indice: number } | null>(null);

  function mover(id: string, coluna: string, indice: number) {
    setErro(null);
    iniciar(async () => {
      aplicar({ id, coluna, indice });
      const r = await moverTarefa(id, coluna, indice);
      if (!r.ok) setErro(ERROS[r.erro ?? ""] ?? "Não foi possível mover a tarefa. Tente de novo.");
    });
  }

  function aoSoltar(e: DragEvent, coluna: string) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") || arrastando;
    const indice = alvo?.coluna === coluna ? alvo.indice : daColuna(itens, coluna).length;
    setArrastando(null);
    setAlvo(null);
    if (id) mover(id, coluna, indice);
  }

  function aoPassarSobreCartao(e: DragEvent, coluna: string, indice: number) {
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const depois = e.clientY > r.top + r.height / 2;
    setAlvo({ coluna, indice: depois ? indice + 1 : indice });
  }

  return (
    <div>
      {erro ? <p role="alert" className="mb-3 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{erro}</p> : null}
      {!podeArrastar ? <p className="mb-3 text-xs text-muted-foreground">Filtro ligado: arrastar fica desligado. Use os botões de cada cartão ou limpe os filtros.</p> : null}
      <div className={cn("flex items-start gap-4 overflow-x-auto pb-4", pendente && "opacity-90")}>
        {colunas.map((col) => {
          const lista = daColuna(itens, col.id);
          return (
            <section
              key={col.id}
              aria-label={col.nome}
              onDragOver={podeArrastar ? (e) => { e.preventDefault(); setAlvo({ coluna: col.id, indice: lista.length }); } : undefined}
              onDrop={podeArrastar ? (e) => aoSoltar(e, col.id) : undefined}
              className={cn("w-72 shrink-0 rounded-[22px] bg-white/70 p-3", alvo?.coluna === col.id && arrastando && "ring-2 ring-primary/40")}
            >
              <h2 className="flex items-center justify-between px-1 pb-2 text-sm font-semibold">
                <span>{col.nome}</span>
                <span className="rounded-full bg-white px-2 py-0.5 text-xs text-muted-foreground">{lista.length}</span>
              </h2>
              <ul className="grid min-h-12 gap-2">
                {lista.map((c, i) => (
                  <li
                    key={c.id}
                    draggable={podeArrastar}
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "move"; setArrastando(c.id); }}
                    onDragEnd={() => { setArrastando(null); setAlvo(null); }}
                    onDragOver={podeArrastar ? (e) => aoPassarSobreCartao(e, col.id, i) : undefined}
                    className={cn(
                      "rounded-2xl bg-white p-3 text-sm shadow-sm",
                      podeArrastar && "cursor-grab active:cursor-grabbing",
                      arrastando === c.id && "opacity-40",
                      alvo?.coluna === col.id && alvo.indice === i && arrastando && arrastando !== c.id && "border-t-4 border-primary",
                    )}
                  >
                    <Link href={`/app/tarefas/${c.id}`} className={cn("font-semibold hover:underline", c.feita && "text-muted-foreground line-through")}>
                      {c.titulo}
                    </Link>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                      {c.data ? <span className={cn("rounded-full px-2 py-0.5 font-semibold", c.atrasada && !c.feita ? "bg-red-100 text-red-800" : "bg-sky-50 text-sky-800")}>{c.dataTexto}</span> : null}
                      {c.responsavel ? <span className="rounded-full bg-muted px-2 py-0.5">{c.responsavel}</span> : null}
                      {c.total ? <span className="rounded-full bg-muted px-2 py-0.5">{c.feitos}/{c.total}</span> : null}
                      {c.etiquetas.map((e) => <span key={e} className="rounded-full bg-accent px-2 py-0.5 text-accent-foreground">{e}</span>)}
                    </div>
                    {c.cnj ? <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">{c.cnj}</p> : null}
                    <div className="mt-2 flex items-center gap-1">
                      <button type="button" aria-label={`Subir ${c.titulo}`} disabled={i === 0} onClick={() => mover(c.id, col.id, i - 1)} className="h-7 w-7 rounded-full text-xs hover:bg-muted disabled:opacity-30">↑</button>
                      <button type="button" aria-label={`Descer ${c.titulo}`} disabled={i === lista.length - 1} onClick={() => mover(c.id, col.id, i + 1)} className="h-7 w-7 rounded-full text-xs hover:bg-muted disabled:opacity-30">↓</button>
                      <select
                        aria-label={`Mover ${c.titulo} para outra coluna`}
                        value={col.id}
                        onChange={(e) => mover(c.id, e.target.value, daColuna(itens, e.target.value).length)}
                        className="ml-auto h-7 max-w-32 rounded-full border bg-white px-2 text-xs"
                      >
                        {colunas.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
                      </select>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
