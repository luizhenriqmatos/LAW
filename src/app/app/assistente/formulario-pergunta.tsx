"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";
import { perguntar, type EstadoPergunta } from "./actions";

function Enviar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="h-10 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-60">
      {pending ? "Consultando os dados…" : "Perguntar"}
    </button>
  );
}

export function FormularioPergunta({ conversaId, exemplo, desligada }: { conversaId?: string; exemplo?: string; desligada?: string | null }) {
  const [estado, acao] = useActionState<EstadoPergunta, FormData>(perguntar, undefined);
  return (
    <form action={acao} className="grid gap-2">
      <input type="hidden" name="conversa" value={conversaId ?? ""} />
      <textarea
        name="texto" required maxLength={4000} rows={3} disabled={!!desligada}
        placeholder={exemplo ?? "Ex.: quais prazos vencem esta semana? · lança 3 parcelas de R$ 1.000 de honorários para o cliente Fulano"}
        className={cn("w-full resize-y rounded-2xl border bg-white px-4 py-3 text-[15px]", desligada && "opacity-60")}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        {desligada ? <p className="text-sm text-red-700">{desligada}</p> : <Enviar />}
        <span className="text-xs text-muted-foreground">Ctrl + Enter envia. A resposta pode levar alguns segundos.</span>
      </div>
      {estado?.erro ? <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{estado.erro}</p> : null}
    </form>
  );
}
