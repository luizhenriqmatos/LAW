import Link from "next/link";
import { exigirEscritorio } from "@/lib/contexto";
import { cn } from "@/lib/utils";
import { Aviso } from "../processos/comum";
import { marcarAvisosLidos } from "../prazos/actions";

type Notificacao = { id: string; titulo: string; corpo: string; link: string | null; lida_em: string | null; criado_em: string };

export default async function Avisos({ searchParams }: PageProps<"/app/avisos">) {
  const sp = await searchParams;
  const { supabase, vinculo } = await exigirEscritorio();
  const { data } = await supabase
    .from("notificacao")
    .select("id, titulo, corpo, link, lida_em, criado_em")
    .eq("escritorio_id", vinculo.escritorioId)
    .order("criado_em", { ascending: false })
    .limit(100);
  const avisos = (data ?? []) as Notificacao[];
  const naoLidas = avisos.filter((a) => !a.lida_em).length;
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-5xl font-medium tracking-tight">Avisos</h1>
      <Aviso codigo={sp.aviso} />
      {naoLidas ? (
        <form action={marcarAvisosLidos} className="mt-4"><button className="h-9 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground">Marcar {naoLidas} como lido(s)</button></form>
      ) : null}
      {avisos.length === 0 ? <p className="mt-4 rounded-[26px] bg-white p-6 text-muted-foreground">Nenhum aviso por enquanto. Os alertas de prazo chegam aqui e por e-mail.</p> : (
        <ul className="mt-4 grid gap-2">
          {avisos.map((a) => (
            <li key={a.id} className={cn("rounded-2xl px-4 py-3", a.lida_em ? "bg-white/60" : "bg-white ring-2 ring-primary/30")}>
              <p className="font-semibold">{a.titulo}</p>
              <p className="mt-1 text-sm text-muted-foreground">{a.corpo}</p>
              {a.link ? <Link href={a.link} className="mt-1 inline-block text-sm font-semibold underline">Abrir prazo</Link> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
