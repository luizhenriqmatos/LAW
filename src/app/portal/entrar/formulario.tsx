"use client";

import { useActionState } from "react";
import { BotaoEnviar, Campo, Mensagem } from "@/components/formulario";
import { pedirLink } from "../actions";

export function FormularioPedirLink() {
  const [estado, acao] = useActionState(pedirLink, undefined);
  return (
    <form action={acao} className="grid gap-4">
      <Campo rotulo="Seu e-mail" nome="email" type="email" autoComplete="email" required ajuda="Use o e-mail que o seu advogado tem cadastrado." />
      <Mensagem estado={estado} />
      <BotaoEnviar>Receber link de acesso</BotaoEnviar>
    </form>
  );
}
