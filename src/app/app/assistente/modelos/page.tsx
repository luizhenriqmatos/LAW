import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { CAMPOS_AUTOMATICOS, camposDoModelo, camposManuais } from "@/lib/assistente/minuta";
import { NOME_ASSISTENTE } from "@/lib/assistente/nome";
import { exigirModulo } from "@/lib/contexto";
import { ativarModelo, salvarModelo } from "../actions";
import { AvisoLia } from "../comum";

const campo = "w-full rounded-xl border bg-white px-3 py-2 text-sm";
const EXEMPLO = `CONTRATO DE PRESTAÇÃO DE SERVIÇOS ADVOCATÍCIOS

CONTRATANTE: {{cliente_nome}}, inscrito(a) sob o nº {{cliente_documento}}.
CONTRATADO: {{escritorio_nome}}.

OBJETO: {{objeto}}

HONORÁRIOS: {{valor_honorarios}}, pagos em {{forma_pagamento}}.

{{data_hoje}}.`;

type Modelo = { id: string; nome: string; descricao: string; texto: string; ativo: boolean; atualizado_em: string };

export default async function PaginaModelos({ searchParams }: PageProps<"/app/assistente/modelos">) {
  const sp = await searchParams;
  const { supabase, modulos } = await exigirModulo("assistente");
  if (!modulos.includes("documentos")) redirect("/app/sem-acesso?modulo=documentos"); // mesmas regras da RLS de modelo_contrato
  const { data } = await supabase.from("modelo_contrato").select("id, nome, descricao, texto, ativo, atualizado_em").order("nome");
  const modelos = (data ?? []) as Modelo[];
  const editarId = z.uuid().safeParse(sp.editar).success ? String(sp.editar) : null;
  const editando = modelos.find((m) => m.id === editarId) ?? null;

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/app/assistente" className="text-sm text-muted-foreground hover:underline">← {NOME_ASSISTENTE}</Link>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">Modelos de contrato</h1>
      <p className="mt-3 text-muted-foreground">
        A {NOME_ASSISTENTE} só gera minutas a partir destes modelos. Escreva o texto do escritório e marque os pontos variáveis com <code>{"{{nome_do_campo}}"}</code> (letras minúsculas, números e _).
      </p>
      <AvisoLia codigo={sp.aviso} />

      <section className="mt-6 rounded-[26px] bg-white p-6">
        <h2 className="text-lg font-semibold">{editando ? `Editar "${editando.nome}"` : "Novo modelo"}</h2>
        <form action={salvarModelo} className="mt-4 grid gap-3 text-sm">
          <input type="hidden" name="id" value={editando?.id ?? ""} />
          <label className="grid gap-1"><span className="font-medium">Nome</span><input name="nome" required minLength={2} maxLength={120} defaultValue={editando?.nome ?? ""} className={campo} /></label>
          <label className="grid gap-1"><span className="font-medium">Para que serve (ajuda a {NOME_ASSISTENTE} a escolher)</span><input name="descricao" maxLength={500} defaultValue={editando?.descricao ?? ""} className={campo} /></label>
          <label className="grid gap-1"><span className="font-medium">Texto do modelo</span>
            <textarea name="texto" required minLength={20} maxLength={50000} rows={14} defaultValue={editando?.texto ?? EXEMPLO} className={`${campo} font-mono text-[13px]`} />
          </label>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Campos preenchidos automaticamente pelo cadastro</summary>
            <ul className="mt-2 grid gap-0.5 sm:grid-cols-2">{Object.entries(CAMPOS_AUTOMATICOS).map(([k, v]) => <li key={k}><code>{`{{${k}}}`}</code> — {v}</li>)}</ul>
            <p className="mt-2">Os demais campos (ex.: <code>{"{{valor_honorarios}}"}</code>) são preenchidos no cartão do rascunho antes de confirmar.</p>
          </details>
          <div className="flex gap-2">
            <button className="h-10 rounded-full bg-primary px-5 font-medium text-primary-foreground">Salvar modelo</button>
            {editando ? <Link href="/app/assistente/modelos" className="flex h-10 items-center rounded-full bg-muted px-5 font-medium">Cancelar</Link> : null}
          </div>
        </form>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Modelos cadastrados</h2>
        {modelos.length ? (
          <ul className="mt-3 grid gap-2">
            {modelos.map((m) => (
              <li key={m.id} className="rounded-2xl bg-white px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{m.nome} {m.ativo ? null : <span className="ml-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">desativado</span>}</span>
                  <span className="flex gap-2">
                    <Link href={`/app/assistente/modelos?editar=${m.id}`} className="rounded-full bg-muted px-3 py-1 font-medium">Editar</Link>
                    <form action={ativarModelo.bind(null, m.id, !m.ativo)}><button className="rounded-full bg-muted px-3 py-1 font-medium">{m.ativo ? "Desativar" : "Ativar"}</button></form>
                  </span>
                </div>
                {m.descricao ? <p className="mt-1 text-muted-foreground">{m.descricao}</p> : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  Campos: {camposDoModelo(m.texto).join(", ") || "nenhum"} · a preencher: {camposManuais(m.texto).join(", ") || "nenhum"}
                </p>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-muted-foreground">Nenhum modelo ainda. Sem modelo, a {NOME_ASSISTENTE} não gera minuta.</p>}
      </section>
    </div>
  );
}
