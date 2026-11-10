"use client";

import { useActionState } from "react";
import { BotaoEnviar, Mensagem } from "@/components/formulario";
import { aceitarConvite } from "./actions";

export function FormularioAceite({ token }: { token: string }) {
  const [estado, acao] = useActionState(aceitarConvite, undefined);
  return (
    <form action={acao} className="grid gap-4">
      <input type="hidden" name="token" value={token} />
      <Mensagem estado={estado} />
      <BotaoEnviar>Aceitar e entrar</BotaoEnviar>
    </form>
  );
}
