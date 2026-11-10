import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { exigirModulo } from "@/lib/contexto";
import { marcarMinutaRevisada } from "../../actions";
import { AvisoLia, dataHora } from "../../comum";

export default async function PaginaMinuta({ params, searchParams }: PageProps<"/app/assistente/minutas/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, modulos } = await exigirModulo("assistente");
  if (!modulos.includes("documentos")) redirect("/app/sem-acesso?modulo=documentos");
  const { data: m } = await supabase.from("minuta").select("id, titulo, texto, status, origem, criado_em, revisado_em").eq("id", id).maybeSingle();
  if (!m) notFound();
  const revisada = m.status === "revisado";
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/app/assistente/minutas" className="text-sm text-muted-foreground hover:underline">← Minutas</Link>
      <h1 className="mt-2 text-3xl font-medium tracking-tight">{m.titulo}</h1>
      <AvisoLia codigo={sp.aviso} />
      <p className={revisada ? "mt-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900" : "mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"}>
        {revisada
          ? `Revisada em ${dataHora(m.revisado_em!)}.`
          : "NÃO REVISADA. Gerada a partir de um modelo do escritório com ajuda da IA. Leia tudo e corrija antes de usar ou enviar ao cliente."}
      </p>
      <pre className="mt-4 whitespace-pre-wrap rounded-[26px] bg-white p-6 font-serif text-[15px] leading-relaxed">{m.texto}</pre>
      <div className="mt-4 flex flex-wrap gap-2">
        {revisada ? null : (
          <form action={marcarMinutaRevisada.bind(null, m.id)}>
            <button className="h-10 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground">Li e revisei esta minuta</button>
          </form>
        )}
        <Link href={`/app/assistente/minutas/${m.id}/texto`} className="flex h-10 items-center rounded-full bg-muted px-5 text-sm font-medium">Baixar .txt</Link>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Para editar o texto, baixe e ajuste no seu editor. Enviar para assinatura: tela Assinaturas (PDF).</p>
    </div>
  );
}
