import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { NOMES_TIPO, type TipoCalculo } from "@/lib/calculos/calculos";
import { valoresDe } from "@/lib/calculos/formulario";
import { carregarRegimes, dataFinalSugerida, situacaoIndices, type ProcessoOpcao } from "@/lib/calculos/servidor";
import { exigirModulo } from "@/lib/contexto";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { Aviso } from "../../../processos/comum";
import { Abas } from "../../comum";
import { FormularioCalculo } from "../../formulario";

export default async function EditarCalculo({ params, searchParams }: PageProps<"/app/calculos/[id]/editar">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const sp = await searchParams;
  const { supabase, vinculo } = await exigirModulo("calculos");
  const [calc, opcoes, regimes, series] = await Promise.all([
    supabase.from("calculo").select("id, tipo, titulo, processo_id, partes, parametros, regimes").eq("id", id).maybeSingle(),
    supabase.rpc("calculo_opcoes", { p_escritorio: vinculo.escritorioId }),
    carregarRegimes(supabase),
    situacaoIndices(supabase),
  ]);
  if (!calc.data) notFound();
  const c = calc.data as { id: string; tipo: TipoCalculo; titulo: string; processo_id: string | null; partes: string | null; parametros: Record<string, unknown>; regimes: string[] };
  return (
    <div className="mx-auto max-w-5xl">
      <p className="mt-2 text-sm"><Link href={`/app/calculos/${c.id}`} className="text-muted-foreground hover:underline">← Voltar ao demonstrativo</Link></p>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">Editar: {NOMES_TIPO[c.tipo]}</h1>
      <Abas atual="" />
      <Aviso codigo={sp.aviso} />
      <p className="mt-4 text-sm text-muted-foreground">Ao salvar, o cálculo é refeito com os índices guardados hoje. Os regimes continuam na versão escolhida.</p>
      <FormularioCalculo tipo={c.tipo} valores={valoresDe(c)} processos={(opcoes.data ?? []) as ProcessoOpcao[]} regimes={regimes} id={c.id} dataFinalSugerida={dataFinalSugerida(series, hojeBrasilia())} />
    </div>
  );
}
