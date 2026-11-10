"use client";

import { useActionState } from "react";
import { BotaoEnviar, Campo, Mensagem } from "@/components/formulario";
import { assinarDocumento } from "../actions";

export function FormularioAssinar({ token, aceiteTexto }: { token: string; aceiteTexto: string }) {
  const [estado, acao] = useActionState(assinarDocumento.bind(null, token), undefined);
  return (
    <form action={acao} className="grid gap-4">
      <Campo rotulo="Seu CPF" nome="cpf" inputMode="numeric" autoComplete="off" placeholder="000.000.000-00" required maxLength={14} ajuda="Os dígitos verificadores são conferidos." />
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" name="aceite" required className="mt-1 size-4" />
        <span>{aceiteTexto}</span>
      </label>
      <Mensagem estado={estado} />
      <BotaoEnviar>Assinar</BotaoEnviar>
    </form>
  );
}
