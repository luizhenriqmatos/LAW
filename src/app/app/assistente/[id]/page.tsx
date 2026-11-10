import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { fontesCitadas } from "@/lib/assistente/citacoes";
import { NOME_ASSISTENTE } from "@/lib/assistente/nome";
import { ContextoAssistente, Fonte } from "@/lib/assistente/tipos";
import { exigirModulo } from "@/lib/contexto";
import { mensagemDeErro } from "@/lib/erros";
import { formatarCnj } from "@/lib/integrations/fontes/cnj";
import { servicoIaAssistente } from "@/lib/integrations/ia";
import { confirmarRascunho, descartarRascunho } from "../actions";
import { CartaoRascunho, type OpcoesCartao, type RascunhoTela } from "../cartao-rascunho";
import { AvisoComoFunciona, AvisoLia, AvisoSemPermissao, dataHora, linkDoResultado, rascunhoVencido, TextoResposta } from "../comum";
import { FormularioPergunta } from "../formulario-pergunta";

export const maxDuration = 120;

type Mensagem = { id: string; papel: "usuario" | "assistente"; texto: string; fontes: unknown; sem_permissao: string[]; criado_em: string };
type LinhaRascunho = {
  id: string; mensagem_id: string | null; tipo: RascunhoTela["tipo"]; dados: Record<string, unknown>; resumo: string; avisos: string[];
  status: RascunhoTela["status"]; resultado_id: string | null; dados_confirmados: Record<string, unknown> | null; criado_em: string;
};


export default async function PaginaConversa({ params, searchParams }: PageProps<"/app/assistente/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, vinculo, modulos } = await exigirModulo("assistente");

  const { data: conversa } = await supabase.from("assistente_conversa").select("id, titulo").eq("id", id).maybeSingle();
  if (!conversa) notFound();
  const [{ data: msgs }, { data: rasc }, { data: ctxBruto }] = await Promise.all([
    supabase.from("assistente_mensagem").select("id, papel, texto, fontes, sem_permissao, criado_em").eq("conversa_id", id).order("criado_em").limit(200),
    supabase.from("assistente_rascunho").select("id, mensagem_id, tipo, dados, resumo, avisos, status, resultado_id, dados_confirmados, criado_em").eq("conversa_id", id).order("criado_em"),
    supabase.rpc("assistente_contexto", { p_escritorio: vinculo.escritorioId }),
  ]);
  const ctx = ContextoAssistente.safeParse(ctxBruto);
  const rascunhos = (rasc ?? []) as LinhaRascunho[];

  // Opções do modo "Editar": clientes/processos só para quem tem Financeiro e só se há lançamento pendente.
  const opcoes: OpcoesCartao = { equipe: ctx.success ? ctx.data.equipe : [], colunas: ctx.success ? ctx.data.colunas : [], clientes: [], processos: [] };
  if (modulos.includes("financeiro") && rascunhos.some((r) => r.tipo === "lancamento" && r.status === "pendente")) {
    const { data } = await supabase.rpc("financeiro_opcoes", { p_escritorio: vinculo.escritorioId });
    const o = data as { clientes: { id: string; nome: string }[]; processos: { id: string; numero_cnj: string }[] } | null;
    opcoes.clientes = o?.clientes ?? [];
    opcoes.processos = (o?.processos ?? []).map((p) => ({ id: p.id, numero: formatarCnj(p.numero_cnj) }));
  }

  const destino = `/app/assistente/${id}`;
  const tela = (r: LinhaRascunho): RascunhoTela => ({
    id: r.id, tipo: r.tipo, dados: r.dados, resumo: r.resumo, avisos: r.avisos, status: r.status,
    vencido: r.status === "pendente" && rascunhoVencido(r.criado_em),
    linkResultado: linkDoResultado(r.tipo, r.resultado_id, r.dados_confirmados),
  });
  const cartoes = (lista: LinhaRascunho[]) => lista.map((r) => (
    <CartaoRascunho key={r.id} r={tela(r)} opcoes={opcoes} confirmar={confirmarRascunho.bind(null, r.id, destino)} descartar={descartarRascunho.bind(null, r.id, destino)} />
  ));
  const soltos = rascunhos.filter((r) => !r.mensagem_id || !(msgs ?? []).some((m) => m.id === r.mensagem_id));
  const desligada = servicoIaAssistente() ? null : mensagemDeErro("assistente_nao_configurada");

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/app/assistente" className="text-sm text-muted-foreground hover:underline">← Conversas</Link>
      <h1 className="mt-2 text-3xl font-medium tracking-tight">{conversa.titulo}</h1>
      <AvisoComoFunciona className="mt-4" />
      <AvisoLia codigo={sp.aviso} />

      <div className="mt-6 grid gap-4">
        {((msgs ?? []) as Mensagem[]).map((m) => {
          if (m.papel === "usuario") {
            return (
              <div key={m.id} className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-primary-foreground">
                <p className="whitespace-pre-wrap text-[15px]">{m.texto}</p>
                <p className="mt-1 text-right text-[11px] opacity-70">{dataHora(m.criado_em)}</p>
              </div>
            );
          }
          const fontes = z.array(Fonte).catch([]).parse(m.fontes);
          const citadas = fontesCitadas(m.texto, fontes);
          const consultadas = citadas.length ? citadas : fontes.slice(0, 10);
          return (
            <div key={m.id} className="grid gap-3">
              <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-white px-4 py-3">
                <p className="mb-1 text-xs font-semibold text-muted-foreground">{NOME_ASSISTENTE} · {dataHora(m.criado_em)}</p>
                <TextoResposta texto={m.texto} fontes={fontes} />
                <AvisoSemPermissao modulos={m.sem_permissao ?? []} />
                {consultadas.length ? (
                  <div className="mt-3 border-t pt-2 text-xs">
                    <p className="font-semibold text-muted-foreground">{citadas.length ? "Fontes citadas" : "Dados consultados"}</p>
                    <ul className="mt-1 flex flex-wrap gap-1.5">
                      {consultadas.map((f) => <li key={f.ref}><Link href={f.link} className="inline-block rounded-full bg-muted px-2.5 py-1 hover:bg-muted/70">{f.rotulo}</Link></li>)}
                    </ul>
                  </div>
                ) : null}
              </div>
              {cartoes(rascunhos.filter((r) => r.mensagem_id === m.id))}
            </div>
          );
        })}
        {cartoes(soltos)}
      </div>

      <section id="fim" className="mt-8 rounded-[26px] bg-white p-6">
        <FormularioPergunta conversaId={id} exemplo="Pergunte mais alguma coisa…" desligada={desligada} />
      </section>
    </div>
  );
}
