"use client";

import { useActionState } from "react";
import { BotaoEnviar, Campo, Mensagem } from "@/components/formulario";
import { confirmarCliente, confirmarProcesso } from "./actions";

export function FormularioProcesso({
  processoId,
  valores,
}: {
  processoId: string;
  valores: { titulo: string; area: string; classe: string; orgao_julgador: string; segredo_justica: boolean };
}) {
  const [estado, acao] = useActionState(confirmarProcesso.bind(null, processoId), undefined);
  return (
    <form action={acao} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo rotulo="Apelido do processo" nome="titulo" defaultValue={valores.titulo} maxLength={160} placeholder="Ex.: Indenização — Maria" ajuda="Como a equipe chama este caso." />
        <Campo rotulo="Área" nome="area" defaultValue={valores.area} maxLength={60} placeholder="Cível, Trabalhista…" />
        <Campo rotulo="Classe" nome="classe" defaultValue={valores.classe} maxLength={200} />
        <Campo rotulo="Vara / órgão julgador" nome="orgao_julgador" defaultValue={valores.orgao_julgador} maxLength={200} />
      </div>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" name="segredo_justica" defaultChecked={valores.segredo_justica} className="size-4 accent-black" />
        Segredo de justiça (nunca aparece fora da área interna)
      </label>
      <Mensagem estado={estado} />
      <div>
        <BotaoEnviar>Confirmar processo</BotaoEnviar>
      </div>
    </form>
  );
}

export function FormularioCliente({
  clienteId,
  valores,
}: {
  clienteId: string;
  valores: { nome: string; documento: string; email: string; telefone: string };
}) {
  const [estado, acao] = useActionState(confirmarCliente.bind(null, clienteId), undefined);
  return (
    <form action={acao} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo rotulo="Nome" nome="nome" defaultValue={valores.nome} required maxLength={200} />
        <Campo rotulo="CPF ou CNPJ (opcional)" nome="documento" defaultValue={valores.documento} inputMode="numeric" placeholder="000.000.000-00" ajuda="Usado para achar o mesmo cliente em outros processos." />
        <Campo rotulo="E-mail (opcional)" nome="email" type="email" defaultValue={valores.email} />
        <Campo rotulo="Telefone (opcional)" nome="telefone" defaultValue={valores.telefone} inputMode="tel" placeholder="(71) 99999-0000" />
      </div>
      <Mensagem estado={estado} />
      <div>
        <BotaoEnviar>Confirmar cliente</BotaoEnviar>
      </div>
    </form>
  );
}
