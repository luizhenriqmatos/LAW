import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { exigirModulo } from "@/lib/contexto";
import { ROTULO_CATEGORIA, type Categoria } from "@/lib/whatsapp/textos";
import { cn } from "@/lib/utils";
import { assumirAtendimento, encerrarAtendimento, lerAtendimento, responderAtendimento } from "../actions";
import { AvisoAtendimento, janelaDe, quando, ROTULO_STATUS, telefoneBonito } from "../comum";

type Atend = {
  id: string; conversa_id: string; cliente_id: string | null; identificacao: string; telefone: string; nome_contato: string;
  categoria: Categoria; resumo: string | null; status: string; responsavel_id: string | null; criado_em: string;
};
type Msg = { id: string; direcao: "entrada" | "saida"; autor: "contato" | "recepcao" | "humano"; tipo: string; texto: string | null; status: string; erro: string | null; criado_em: string };

const AUTOR = { contato: "Contato", recepcao: "Recepcionista automática", humano: "Equipe" } as const;
const STATUS_ENVIO: Record<string, string> = { pendente: "enviando…", enviada: "enviada", entregue: "entregue", lida: "lida", falhou: "não enviada" };

export default async function PaginaAtendimento({ params, searchParams }: PageProps<"/app/atendimentos/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase } = await exigirModulo("atendimento");
  const { data: a } = await supabase
    .from("atendimento")
    .select("id, conversa_id, cliente_id, identificacao, telefone, nome_contato, categoria, resumo, status, responsavel_id, criado_em")
    .eq("id", id)
    .maybeSingle();
  if (!a) notFound();
  const at = a as Atend;
  const [{ data: msgs }, { data: conv }, { data: cfg }] = await Promise.all([
    supabase.from("whatsapp_mensagem").select("id, direcao, autor, tipo, texto, status, erro, criado_em").eq("conversa_id", at.conversa_id).order("criado_em"),
    supabase.from("whatsapp_conversa").select("ultima_entrada_em").eq("id", at.conversa_id).single(),
    supabase.from("recepcao_config").select("modelo_retomada").maybeSingle(),
  ]);
  if (at.status !== "encerrado") await lerAtendimento(id);
  const janela = janelaDe(conv?.ultima_entrada_em ?? null);
  const janelaAberta = janela.aberta;
  const encerrado = at.status === "encerrado";

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/app/atendimentos" className="text-sm text-muted-foreground hover:underline">← Atendimentos</Link>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">{at.nome_contato}</h1>
      <p className="mt-1 text-muted-foreground">{telefoneBonito(at.telefone)} · {ROTULO_CATEGORIA[at.categoria]} · {ROTULO_STATUS[at.status]} · aberto em {quando(at.criado_em)}</p>
      <AvisoAtendimento codigo={sp.aviso} />

      {at.identificacao === "cliente_cadastrado" ? (
        <p className="mt-4 rounded-xl bg-white px-4 py-3 text-sm">
          Este telefone consta no cadastro de um cliente. <strong>Isso não prova quem está escrevendo</strong> (o número pode ter mudado de dono).
          Confirme a identidade antes de passar dados de processo.
        </p>
      ) : (
        <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {at.identificacao === "ambiguo" ? "Este telefone está no cadastro de mais de um cliente." : "Este telefone não está no cadastro de clientes."}{" "}
          <strong>Não passe dados de processo</strong> até confirmar que a pessoa é cliente.
        </p>
      )}
      {at.resumo ? <p className="mt-3 text-sm"><strong>O que a pessoa disse:</strong> {at.resumo}</p> : null}

      <section aria-label="Conversa" className="mt-5 grid gap-2 rounded-[26px] bg-white p-4">
        {(msgs as Msg[] | null)?.map((m) => (
          <div key={m.id} className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm", m.direcao === "entrada" ? "bg-muted" : "ml-auto bg-accent text-accent-foreground")}>
            <p className="text-xs font-semibold opacity-70">{AUTOR[m.autor]} · {quando(m.criado_em)}{m.direcao === "saida" ? ` · ${STATUS_ENVIO[m.status] ?? m.status}` : ""}</p>
            <p className="mt-0.5 whitespace-pre-wrap">{m.texto ?? `(${m.tipo === "outro" ? "mensagem que não é texto" : "sem texto"})`}</p>
            {m.status === "falhou" && m.erro ? <p className="mt-1 text-xs text-red-700">Motivo: {m.erro}</p> : null}
          </div>
        ))}
      </section>

      {encerrado ? (
        <p className="mt-4 text-sm text-muted-foreground">Atendimento encerrado. Se a pessoa escrever de novo, a recepcionista abre outro.</p>
      ) : (
        <>
          <section className="mt-5 rounded-[26px] bg-white p-5">
            {janelaAberta ? (
              <form action={responderAtendimento.bind(null, id)} className="grid gap-3">
                <label htmlFor="texto" className="text-sm font-medium">Responder pelo WhatsApp</label>
                <textarea id="texto" name="texto" required maxLength={4096} rows={3} className="rounded-xl border px-3 py-2 text-sm" />
                <p className="text-xs text-muted-foreground">Você pode escrever livremente até {quando(janela.ate)} (24 h depois da última mensagem da pessoa).</p>
                <button className="h-10 w-fit rounded-full bg-primary px-5 font-medium text-primary-foreground">Enviar</button>
              </form>
            ) : (
              <form action={responderAtendimento.bind(null, id)} className="grid gap-2 text-sm">
                <p className="font-medium">A janela de 24 h fechou.</p>
                <p className="text-muted-foreground">
                  Pelas regras do WhatsApp, agora só dá para enviar o modelo de mensagem aprovado. Quando a pessoa responder, você volta a escrever livremente.
                </p>
                {cfg?.modelo_retomada ? (
                  <button className="h-10 w-fit rounded-full bg-primary px-5 font-medium text-primary-foreground">Enviar modelo de retomada</button>
                ) : <p className="rounded-xl bg-amber-50 px-3 py-2 text-amber-950">O modelo de retomada ainda não foi cadastrado. O dono define em &quot;Configurar recepcionista&quot;.</p>}
              </form>
            )}
          </section>
          <div className="mt-4 flex flex-wrap gap-2">
            {at.status === "aberto" ? (
              <form action={assumirAtendimento.bind(null, id)}><button className="h-10 rounded-full bg-white px-5 text-sm font-medium hover:bg-muted">Assumir atendimento</button></form>
            ) : null}
            <form action={encerrarAtendimento.bind(null, id)}><button className="h-10 rounded-full bg-white px-5 text-sm font-medium hover:bg-muted">Encerrar atendimento</button></form>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Enquanto o atendimento estiver aberto, a recepcionista automática não responde nesta conversa.</p>
        </>
      )}
    </div>
  );
}
