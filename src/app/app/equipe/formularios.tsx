"use client";

import { useActionState, useState } from "react";
import { BotaoEnviar, Campo, Mensagem } from "@/components/formulario";
import { MODULOS } from "@/lib/modulos";
import { convidar, salvarPermissoes } from "./actions";

function GradeModulos({ marcados }: { marcados: readonly string[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {MODULOS.map((m) => (
        <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded-xl bg-muted px-3 py-2 text-sm font-medium">
          <input type="checkbox" name="modulos" value={m.id} defaultChecked={marcados.includes(m.id)} className="size-4 accent-black" />
          {m.rotulo}
        </label>
      ))}
    </div>
  );
}

export function FormularioPermissoes({ membroId, marcados }: { membroId: string; marcados: string[] }) {
  const [estado, acao] = useActionState(salvarPermissoes, undefined);
  return (
    <form action={acao} className="mt-3 grid gap-3">
      <input type="hidden" name="membro" value={membroId} />
      <GradeModulos marcados={marcados} />
      <div className="flex flex-wrap items-center gap-3">
        <BotaoEnviar variante="outline">Salvar permissões</BotaoEnviar>
        <Mensagem estado={estado} />
      </div>
    </form>
  );
}

export function FormularioConvite() {
  const [estado, acao] = useActionState(convidar, undefined);
  const [copiado, setCopiado] = useState(false);
  return (
    <form action={acao} className="grid gap-3">
      <Campo rotulo="E-mail da pessoa" nome="email" type="email" required placeholder="pessoa@escritorio.com.br" />
      <p className="text-sm font-medium">O que ela pode ver</p>
      <GradeModulos marcados={["agenda", "processos", "prazos", "tarefas", "documentos"]} />
      <Mensagem estado={estado} />
      {estado?.link ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-3">
          <code className="min-w-0 flex-1 break-all text-xs">{estado.link}</code>
          <button
            type="button"
            className="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(estado.link!);
                setCopiado(true);
              } catch {
                setCopiado(false);
              }
            }}
          >
            {copiado ? "Copiado" : "Copiar link"}
          </button>
        </div>
      ) : null}
      <BotaoEnviar>Enviar convite</BotaoEnviar>
    </form>
  );
}
