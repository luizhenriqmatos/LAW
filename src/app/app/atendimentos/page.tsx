import Link from "next/link";
import { exigirModulo } from "@/lib/contexto";
import { ROTULO_CATEGORIA, type Categoria } from "@/lib/whatsapp/textos";
import { cn } from "@/lib/utils";
import { AvisoAtendimento, quando, ROTULO_STATUS, telefoneBonito } from "./comum";

type Linha = {
  id: string; conversa_id: string; nome_contato: string; telefone: string; categoria: Categoria; status: string;
  identificacao: string; resumo: string | null; criado_em: string; ultima_leitura_em: string | null;
};
const FILTROS = [
  { id: "abertos", rotulo: "Abertos", status: ["aberto", "em_andamento"] },
  { id: "encerrados", rotulo: "Encerrados", status: ["encerrado"] },
] as const;

export default async function PaginaAtendimentos({ searchParams }: PageProps<"/app/atendimentos">) {
  const sp = await searchParams;
  const { supabase, vinculo } = await exigirModulo("atendimento");
  const filtro = FILTROS.find((f) => f.id === sp.filtro) ?? FILTROS[0];
  const { data } = await supabase
    .from("atendimento")
    .select("id, conversa_id, nome_contato, telefone, categoria, status, identificacao, resumo, criado_em, ultima_leitura_em")
    .eq("escritorio_id", vinculo.escritorioId)
    .in("status", [...filtro.status])
    .order("criado_em", { ascending: false })
    .limit(100);
  const itens = (data ?? []) as Linha[];

  // Mensagens do contato que ninguém da equipe leu ainda.
  const naoLidas = new Map<string, number>();
  if (itens.length && filtro.id === "abertos") {
    const { data: msgs } = await supabase
      .from("whatsapp_mensagem")
      .select("conversa_id, criado_em")
      .in("conversa_id", itens.map((i) => i.conversa_id))
      .eq("direcao", "entrada");
    for (const i of itens) {
      const n = (msgs ?? []).filter((m) => m.conversa_id === i.conversa_id && (!i.ultima_leitura_em || m.criado_em > i.ultima_leitura_em)).length;
      if (n) naoLidas.set(i.id, n);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-5xl font-medium tracking-tight">Atendimentos</h1>
        {vinculo.papel === "dono" ? <Link href="/app/atendimentos/configurar" className="rounded-full bg-white px-4 py-2 text-sm font-medium hover:bg-muted">Configurar recepcionista</Link> : null}
      </div>
      <p className="mt-3 text-muted-foreground">
        Contatos que chegaram pelo WhatsApp. A recepcionista automática anota o motivo e passa para vocês; depois que passa, ela não responde mais naquela conversa.
      </p>
      <AvisoAtendimento codigo={sp.aviso} />
      <nav className="mt-4 flex gap-2 text-sm">
        {FILTROS.map((f) => (
          <Link key={f.id} href={`/app/atendimentos?filtro=${f.id}`} className={cn("rounded-full px-4 py-2 font-medium", f.id === filtro.id ? "bg-primary text-primary-foreground" : "bg-white hover:bg-muted")}>{f.rotulo}</Link>
        ))}
      </nav>
      {itens.length ? (
        <ul className="mt-4 grid gap-2">
          {itens.map((a) => (
            <li key={a.id}>
              <Link href={`/app/atendimentos/${a.id}`} className={cn("block rounded-2xl bg-white px-4 py-3 hover:bg-muted", naoLidas.has(a.id) && "ring-2 ring-primary/30")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{a.nome_contato} <span className="font-normal text-muted-foreground">· {telefoneBonito(a.telefone)}</span></p>
                  <p className="text-xs text-muted-foreground">{quando(a.criado_em)}</p>
                </div>
                <p className="mt-1 text-sm">
                  {ROTULO_CATEGORIA[a.categoria]} · {ROTULO_STATUS[a.status]}
                  {a.identificacao === "cliente_cadastrado" ? " · cliente cadastrado" : a.identificacao === "ambiguo" ? " · telefone de mais de um cliente" : " · contato novo"}
                  {naoLidas.get(a.id) ? <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">{naoLidas.get(a.id)} nova(s)</span> : null}
                </p>
                {a.resumo ? <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{a.resumo}</p> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : <p className="mt-4 rounded-[26px] bg-white p-6 text-muted-foreground">Nenhum atendimento {filtro.id === "abertos" ? "aberto" : "encerrado"} por enquanto.</p>}
    </div>
  );
}
