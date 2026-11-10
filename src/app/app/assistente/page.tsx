import Link from "next/link";
import { NOME_ASSISTENTE } from "@/lib/assistente/nome";
import { exigirModulo } from "@/lib/contexto";
import { mensagemDeErro } from "@/lib/erros";
import { servicoIaAssistente } from "@/lib/integrations/ia";
import { AvisoComoFunciona, AvisoLia, dataHora } from "./comum";
import { FormularioPergunta } from "./formulario-pergunta";

// A pergunta roda aqui (ação do servidor): várias chamadas à IA + ferramentas.
export const maxDuration = 120;

export default async function PaginaAssistente({ searchParams }: PageProps<"/app/assistente">) {
  const sp = await searchParams;
  const { supabase, modulos } = await exigirModulo("assistente");
  const { data: conversas } = await supabase.from("assistente_conversa").select("id, titulo, atualizado_em").order("atualizado_em", { ascending: false }).limit(50);
  const desligada = servicoIaAssistente() ? null : mensagemDeErro("assistente_nao_configurada"); // PENDENCIA P-055

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-5xl font-medium tracking-tight">{NOME_ASSISTENTE}</h1>
        {modulos.includes("documentos") ? (
          <nav className="flex gap-2 text-sm">
            <Link href="/app/assistente/modelos" className="rounded-full bg-white px-4 py-2 font-medium hover:bg-muted">Modelos de contrato</Link>
            <Link href="/app/assistente/minutas" className="rounded-full bg-white px-4 py-2 font-medium hover:bg-muted">Minutas</Link>
          </nav>
        ) : null}
      </div>
      <p className="mt-3 text-muted-foreground">Pergunte sobre processos, clientes, prazos, tarefas, lançamentos e publicações do escritório, ou peça para preparar uma ação.</p>
      <AvisoComoFunciona className="mt-4" />
      <AvisoLia codigo={sp.aviso} />

      <section className="mt-6 rounded-[26px] bg-white p-6">
        <h2 className="mb-3 text-lg font-semibold">Nova conversa</h2>
        <FormularioPergunta desligada={desligada} />
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Suas conversas</h2>
        {conversas?.length ? (
          <ul className="mt-3 grid gap-2">
            {conversas.map((c) => (
              <li key={c.id}>
                <Link href={`/app/assistente/${c.id}`} className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 hover:bg-muted/50">
                  <span className="truncate font-medium">{c.titulo}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{dataHora(c.atualizado_em)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-muted-foreground">Nenhuma conversa ainda.</p>}
      </section>
    </div>
  );
}
