"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { BotaoEnviar, Campo, Mensagem } from "@/components/formulario";
import { cadastrar, entrarComSenha, enviarLinkDeAcesso } from "./actions";

export function FormularioEntrar({ proximo }: { proximo: string }) {
  const [modo, setModo] = useState<"senha" | "link">("senha");
  const [estadoSenha, acaoSenha] = useActionState(entrarComSenha, undefined);
  const [estadoLink, acaoLink] = useActionState(enviarLinkDeAcesso, undefined);
  // O Supabase às vezes devolve o erro do link depois do "#" na URL (o servidor não enxerga essa parte).
  useEffect(() => {
    if (/error(_code)?=/.test(window.location.hash)) window.location.replace("/entrar?erro=expirado");
  }, []);
  return (
    <div className="grid gap-5">
      <div className="inline-flex w-fit rounded-full bg-white p-1 text-sm font-medium">
        {(["senha", "link"] as const).map((m) => (
          <button key={m} type="button" onClick={() => setModo(m)} className={`rounded-full px-4 py-2 ${modo === m ? "bg-primary text-primary-foreground" : ""}`}>
            {m === "senha" ? "Com senha" : "Link no e-mail"}
          </button>
        ))}
      </div>
      {modo === "senha" ? (
        <form action={acaoSenha} className="grid gap-4">
          <input type="hidden" name="proximo" value={proximo} />
          <Campo rotulo="E-mail" nome="email" type="email" autoComplete="email" required />
          <Campo rotulo="Senha" nome="senha" type="password" autoComplete="current-password" required minLength={8} />
          <Mensagem estado={estadoSenha} />
          <BotaoEnviar>Entrar</BotaoEnviar>
        </form>
      ) : (
        <form action={acaoLink} className="grid gap-4">
          <input type="hidden" name="proximo" value={proximo} />
          <Campo rotulo="E-mail" nome="email" type="email" autoComplete="email" required ajuda="Enviamos um link que entra sem senha. Se você ainda não tem conta, ela é criada." />
          <Mensagem estado={estadoLink} />
          <BotaoEnviar>Enviar link de acesso</BotaoEnviar>
        </form>
      )}
      <p className="text-sm text-muted-foreground">
        Ainda não tem conta?{" "}
        <Link className="font-semibold text-foreground underline" href={`/cadastro?proximo=${encodeURIComponent(proximo)}`}>
          Criar conta
        </Link>
      </p>
    </div>
  );
}

export function FormularioCadastro({ proximo }: { proximo: string }) {
  const [estado, acao] = useActionState(cadastrar, undefined);
  return (
    <form action={acao} className="grid gap-4">
      <input type="hidden" name="proximo" value={proximo} />
      <Campo rotulo="E-mail" nome="email" type="email" autoComplete="email" required />
      <Campo rotulo="Senha" nome="senha" type="password" autoComplete="new-password" required minLength={8} ajuda="Pelo menos 8 caracteres." />
      <Mensagem estado={estado} />
      <BotaoEnviar>Criar conta</BotaoEnviar>
      <p className="text-sm text-muted-foreground">
        Já tem conta?{" "}
        <Link className="font-semibold text-foreground underline" href={`/entrar?proximo=${encodeURIComponent(proximo)}`}>
          Entrar
        </Link>{" "}
        · Prefere sem senha? Use o link no e-mail na tela de entrada.
      </p>
    </form>
  );
}
