"use client";

import { useActionState } from "react";
import { cn } from "@/lib/utils";
import { verificarArquivo } from "./actions";

function dataHora(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Bahia", dateStyle: "short", timeStyle: "medium" }) + " (Brasília)" : "—";
}

export function FormularioVerificar() {
  const [estado, acao, pendente] = useActionState(verificarArquivo, undefined);
  const r = estado?.resultado;
  const autentico = r?.encontrado && r.tipo === "final";
  return (
    <div className="grid gap-5">
      <form action={acao} className="grid gap-3">
        <label className="grid gap-1 text-sm">
          <span className="font-medium">PDF assinado</span>
          <input type="file" name="arquivo" accept="application/pdf,.pdf" required className="w-full rounded-xl border bg-white px-3 py-2" />
        </label>
        <button disabled={pendente} className="h-10 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-60">{pendente ? "Conferindo..." : "Conferir arquivo"}</button>
      </form>
      {estado?.erro ? <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{estado.erro}</p> : null}
      {r ? (
        <div role="status" className={cn("rounded-2xl p-5 text-sm", autentico ? "bg-emerald-50 text-emerald-950" : r.encontrado ? "bg-amber-50 text-amber-950" : "bg-red-50 text-red-900")}>
          {r.encontrado && r.tipo === "final" ? (
            <>
              <p className="text-base font-semibold">Confere: este é o PDF final registrado.</p>
              <p className="mt-1">{r.titulo} · {r.escritorio_nome} · concluído em {dataHora(r.concluido_em)}</p>
              <ul className="mt-3 grid gap-1">
                {r.signatarios.map((s, i) => <li key={i}>{s.nome} · CPF {s.cpf ?? "—"} · assinou em {dataHora(s.assinado_em)}</li>)}
              </ul>
              <p className="mt-3 text-xs">Assinatura eletrônica avançada (Lei 14.063/2020), não qualificada.</p>
            </>
          ) : r.encontrado ? (
            <>
              <p className="text-base font-semibold">Este é o documento ORIGINAL de um envelope, não o PDF final assinado.</p>
              <p className="mt-1">{r.titulo} · {r.escritorio_nome} · situação: {r.status === "concluido" ? "concluído" : r.status === "cancelado" ? "cancelado" : "aguardando assinaturas"}.</p>
            </>
          ) : (
            <>
              <p className="text-base font-semibold">NÃO confere.</p>
              <p className="mt-1">Este arquivo não bate com nenhum documento registrado. Ele foi alterado depois de assinado, ou não foi gerado por este sistema.</p>
            </>
          )}
          <p className="mt-3 break-all font-mono text-xs">SHA-256 do arquivo enviado: {estado?.hash}</p>
        </div>
      ) : null}
    </div>
  );
}
