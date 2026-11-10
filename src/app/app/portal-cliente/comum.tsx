"use client";

import { useActionState } from "react";
import { BotaoEnviar, Mensagem, type EstadoFormulario } from "@/components/formulario";
import { enviarAcesso } from "./actions";

/** Botão "Enviar acesso" de UM cliente. Mostra o resultado (e o link, quando o e-mail do LAW não está configurado). */
export function FormularioEnviarAcesso({ clienteId }: { clienteId: string }) {
  const [estado, acao] = useActionState(enviarAcesso.bind(null, clienteId), undefined as EstadoFormulario);
  return (
    <form action={acao} className="grid gap-2">
      <BotaoEnviar variante="outline" className="h-8 text-xs">Enviar acesso por e-mail</BotaoEnviar>
      <Mensagem estado={estado} />
      {estado?.link ? (
        <input readOnly value={estado.link} aria-label="Link de acesso" className="w-full rounded-xl border bg-white px-3 py-2 text-xs" onFocus={(e) => e.currentTarget.select()} />
      ) : null}
    </form>
  );
}
