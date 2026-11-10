import Link from "next/link";
import { dataBr } from "@/lib/calculos/base";
import { NOMES_TIPO, type TipoCalculo } from "@/lib/calculos/calculos";
import { exigirModulo } from "@/lib/contexto";
import { formatarCentavos } from "@/lib/dinheiro";
import { Aviso } from "../processos/comum";
import { Abas } from "./comum";

type Linha = { id: string; tipo: TipoCalculo; titulo: string; total_centavos: number; data_calculo: string; atualizado_em: string; processo: { numero_cnj: string } | null };

export default async function Calculos({ searchParams }: PageProps<"/app/calculos">) {
  const { supabase } = await exigirModulo("calculos");
  const sp = await searchParams;
  const { data, error } = await supabase
    .from("calculo")
    .select("id, tipo, titulo, total_centavos, data_calculo, atualizado_em, processo:processo_id(numero_cnj)")
    .order("atualizado_em", { ascending: false })
    .limit(200);
  const linhas = (data ?? []) as unknown as Linha[];

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-5xl font-medium tracking-tight">Cálculos</h1>
      <p className="mt-2 text-muted-foreground">Atualização monetária, cumprimento de sentença e honorários, com demonstrativo em PDF. O motor troca de regra conforme a data.</p>
      <Abas atual="/app/calculos" />
      <Aviso codigo={sp.aviso} />
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {(Object.keys(NOMES_TIPO) as TipoCalculo[]).map((t) => (
          <Link key={t} href={`/app/calculos/novo?tipo=${t}`} className="rounded-[26px] bg-white p-5 hover:bg-muted">
            <p className="text-sm text-muted-foreground">Novo cálculo</p>
            <p className="mt-1 font-semibold">{NOMES_TIPO[t]}</p>
          </Link>
        ))}
      </div>
      {error ? <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">Não foi possível carregar os cálculos.</p> : null}
      {linhas.length === 0 ? (
        <p className="mt-6 rounded-[26px] bg-white p-6 text-sm text-muted-foreground">Nenhum cálculo salvo ainda.</p>
      ) : (
        <ul className="mt-6 grid gap-2">
          {linhas.map((c) => (
            <li key={c.id}>
              <Link href={`/app/calculos/${c.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-white px-5 py-4 hover:bg-muted">
                <span className="min-w-0">
                  <span className="block font-medium">{c.titulo}</span>
                  <span className="block text-xs text-muted-foreground">{NOMES_TIPO[c.tipo]} · calculado em {dataBr(c.data_calculo)}{c.processo ? ` · ${c.processo.numero_cnj}` : ""}</span>
                </span>
                <span className="font-semibold tabular-nums">{formatarCentavos(Number(c.total_centavos))}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
