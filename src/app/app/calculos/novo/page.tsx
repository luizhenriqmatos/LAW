import Link from "next/link";
import { z } from "zod";
import { NOMES_TIPO, type TipoCalculo } from "@/lib/calculos/calculos";
import { centavosParaCampo, VALORES_VAZIOS, valoresDe, type Valores } from "@/lib/calculos/formulario";
import { carregarRegimes, dataFinalSugerida, situacaoIndices, type ProcessoOpcao } from "@/lib/calculos/servidor";
import { exigirModulo } from "@/lib/contexto";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { Abas } from "../comum";
import { FormularioCalculo } from "../formulario";

const TIPOS: TipoCalculo[] = ["atualizacao", "art523", "honorarios"];
const primeiro = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NovoCalculo({ searchParams }: PageProps<"/app/calculos/novo">) {
  const { supabase, vinculo } = await exigirModulo("calculos");
  const sp = await searchParams;
  const tipo = TIPOS.find((t) => t === primeiro(sp.tipo));
  if (!tipo) {
    return (
      <div className="mx-auto max-w-5xl">
        <h1 className="text-5xl font-medium tracking-tight">Novo cálculo</h1>
        <Abas atual="/app/calculos/novo" />
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {TIPOS.map((t) => (
            <Link key={t} href={`/app/calculos/novo?tipo=${t}`} className="rounded-[26px] bg-white p-5 font-semibold hover:bg-muted">{NOMES_TIPO[t]}</Link>
          ))}
        </div>
      </div>
    );
  }
  const hoje = hojeBrasilia();
  const [opcoes, regimes, series] = await Promise.all([
    supabase.rpc("calculo_opcoes", { p_escritorio: vinculo.escritorioId }),
    carregarRegimes(supabase),
    situacaoIndices(supabase),
  ]);
  const processos = (opcoes.data ?? []) as ProcessoOpcao[];

  // Pré-preenchimento: a partir de outro cálculo (?de=), de um processo (?processo=) ou de uma base (?base= centavos).
  let valores: Valores = { ...VALORES_VAZIOS };
  const de = primeiro(sp.de);
  if (de && z.uuid().safeParse(de).success) {
    const { data } = await supabase.from("calculo").select("titulo, processo_id, partes, parametros, regimes, tipo, total_centavos").eq("id", de).maybeSingle();
    if (data) {
      valores = valoresDe(data as never);
      if (tipo === "honorarios") valores = { ...VALORES_VAZIOS, processo: valores.processo, partes: valores.partes, base_valor: centavosParaCampo(Number(data.total_centavos)) };
      valores.titulo = `${NOMES_TIPO[tipo]} — ${data.titulo}`.slice(0, 160);
    }
  }
  const proc = primeiro(sp.processo);
  if (proc && processos.some((p) => p.id === proc)) {
    const p = processos.find((x) => x.id === proc)!;
    valores.processo = p.id;
    valores.partes ||= [p.ativo, p.passivo].filter(Boolean).join(" x ");
  }

  return (
    <div className="mx-auto max-w-5xl">
      <p className="mt-2 text-sm"><Link href="/app/calculos/novo" className="text-muted-foreground hover:underline">← Tipos de cálculo</Link></p>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">{NOMES_TIPO[tipo]}</h1>
      <Abas atual="/app/calculos/novo" />
      <FormularioCalculo tipo={tipo} valores={valores} processos={processos} regimes={regimes} origem={de} dataFinalSugerida={dataFinalSugerida(series, hoje)} />
    </div>
  );
}
