import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { Demonstrativo, TipoCalculo } from "@/lib/calculos/calculos";
import { exigirModulo } from "@/lib/contexto";
import { Aviso, botaoPequeno } from "../../processos/comum";
import { duplicarCalculo, excluirCalculo, salvarPdfNoDrive } from "../actions";
import { Abas, VerDemonstrativo } from "../comum";

export default async function VerCalculo({ params, searchParams }: PageProps<"/app/calculos/[id]">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const sp = await searchParams;
  const { supabase } = await exigirModulo("calculos");
  const { data } = await supabase.from("calculo").select("id, tipo, titulo, processo_id, resultado, origem_id, pdf_enviado_em").eq("id", id).maybeSingle();
  if (!data) notFound();
  const c = data as { id: string; tipo: TipoCalculo; titulo: string; processo_id: string | null; resultado: Demonstrativo; origem_id: string | null; pdf_enviado_em: string | null };

  return (
    <div className="mx-auto max-w-5xl">
      <p className="mt-2 text-sm"><Link href="/app/calculos" className="text-muted-foreground hover:underline">← Cálculos</Link></p>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">{c.titulo}</h1>
      {c.origem_id ? <p className="mt-1 text-sm text-muted-foreground">Cópia de <Link className="underline" href={`/app/calculos/${c.origem_id}`}>outro cálculo</Link>.</p> : null}
      <Abas atual="" />
      <Aviso codigo={sp.aviso} />
      <div className="mt-6 flex flex-wrap gap-2">
        <a href={`/app/calculos/${c.id}/pdf`} className={`${botaoPequeno} h-9 bg-primary px-4 text-primary-foreground`}>Baixar PDF</a>
        {c.processo_id ? (
          <form action={salvarPdfNoDrive.bind(null, c.id)}>
            <button className={`${botaoPequeno} h-9 bg-white px-4 hover:bg-muted`}>{c.pdf_enviado_em ? "Salvar de novo na pasta do processo" : "Salvar PDF na pasta do processo"}</button>
          </form>
        ) : null}
        <Link href={`/app/calculos/${c.id}/editar`} className={`${botaoPequeno} h-9 bg-white px-4 hover:bg-muted`}>Editar</Link>
        <form action={duplicarCalculo.bind(null, c.id)}><button className={`${botaoPequeno} h-9 bg-white px-4 hover:bg-muted`}>Duplicar</button></form>
        {c.tipo === "atualizacao" ? (
          <>
            <Link href={`/app/calculos/novo?tipo=art523&de=${c.id}`} className={`${botaoPequeno} h-9 bg-white px-4 hover:bg-muted`}>Usar no art. 523</Link>
            <Link href={`/app/calculos/novo?tipo=honorarios&de=${c.id}`} className={`${botaoPequeno} h-9 bg-white px-4 hover:bg-muted`}>Honorários sobre este total</Link>
          </>
        ) : null}
      </div>
      {c.pdf_enviado_em ? <p className="mt-2 text-xs text-muted-foreground">PDF salvo na pasta do processo em {new Date(c.pdf_enviado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.</p> : null}
      <VerDemonstrativo d={c.resultado} />
      <form action={excluirCalculo.bind(null, c.id)} className="mt-6">
        <button className={`${botaoPequeno} h-9 bg-red-50 px-4 text-red-700 hover:bg-red-100`}>Excluir cálculo</button>
      </form>
    </div>
  );
}
