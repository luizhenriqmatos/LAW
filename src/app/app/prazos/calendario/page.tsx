import Link from "next/link";
import { exigirModulo } from "@/lib/contexto";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { cn } from "@/lib/utils";
import { Aviso, botaoPequeno, formatarData } from "../../processos/comum";
import { adicionarAoCalendario, removerDoCalendario } from "../actions";

type Linha = { id: string; escritorio_id: string | null; data: string; data_fim: string | null; escopo: string; tribunal: string | null; uf: string | null; tipo: string; descricao: string };
const ESCOPO: Record<string, string> = { nacional: "Nacional", estadual: "Estadual", municipal: "Municipal", tribunal: "Tribunal" };

export default async function CalendarioForense({ searchParams }: PageProps<"/app/prazos/calendario">) {
  const sp = await searchParams;
  const { supabase, vinculo } = await exigirModulo("prazos");
  const dono = vinculo.papel === "dono";
  const hoje = hojeBrasilia();
  const { data } = await supabase
    .from("calendario_forense")
    .select("id, escritorio_id, data, data_fim, escopo, tribunal, uf, tipo, descricao")
    .or(`escritorio_id.is.null,escritorio_id.eq.${vinculo.escritorioId}`)
    .gte("data", hoje)
    .order("data")
    .limit(400);
  const linhas = (data ?? []) as Linha[];
  const proprias = linhas.filter((l) => l.escritorio_id);
  const globais = linhas.filter((l) => !l.escritorio_id);

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/app/prazos" className="text-sm font-medium text-muted-foreground hover:underline">‹ Prazos</Link>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">Calendário forense</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Dias sem expediente usados na contagem dos prazos, além de fins de semana e do recesso de 20/12 a 20/01 (sempre aplicados).
        A lista do LAW traz feriados nacionais, 2 de Julho (Bahia) e Carnaval/Corpus Christi do TJBA. <strong>Confira com o calendário oficial do seu tribunal.</strong>
      </p>
      <Aviso codigo={sp.aviso} />

      {dono ? (
        <form action={adicionarAoCalendario} className="mt-6 grid gap-3 rounded-[26px] bg-white p-6">
          <h2 className="font-semibold">Acrescentar feriado ou suspensão do seu escritório</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="grid gap-1 text-sm font-medium">Data<input type="date" name="data" required className="h-10 rounded-xl border px-3" /></label>
            <label className="grid gap-1 text-sm font-medium">Até (se for período)<input type="date" name="data_fim" className="h-10 rounded-xl border px-3" /></label>
            <label className="grid gap-1 text-sm font-medium">Tipo
              <select name="tipo" className="h-10 rounded-xl border bg-white px-3"><option value="feriado">Feriado</option><option value="suspensao">Suspensão de prazos</option></select>
            </label>
            <label className="grid gap-1 text-sm font-medium">Vale para
              <select name="escopo" className="h-10 rounded-xl border bg-white px-3">
                <option value="tribunal">Um tribunal</option>
                <option value="municipal">Município (informe o tribunal da comarca)</option>
                <option value="estadual">Um estado</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm font-medium">Tribunal (ex.: TJBA)<input name="tribunal" maxLength={10} className="h-10 rounded-xl border px-3 uppercase" /></label>
            <label className="grid gap-1 text-sm font-medium">UF (se estadual)<input name="uf" maxLength={2} className="h-10 rounded-xl border px-3 uppercase" /></label>
          </div>
          <label className="grid gap-1 text-sm font-medium">Descrição<input name="descricao" required minLength={3} maxLength={120} placeholder="Ex.: Nossa Senhora da Conceição (Salvador)" className="h-10 rounded-xl border px-3" /></label>
          <div><button className="h-10 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground">Adicionar</button></div>
        </form>
      ) : (
        <p className="mt-6 rounded-xl bg-muted px-4 py-3 text-sm">Só o dono do escritório altera o calendário.</p>
      )}

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Do seu escritório ({proprias.length})</h2>
      {proprias.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Nenhum cadastro próprio.</p> : (
        <ul className="mt-2 grid gap-2">
          {proprias.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-white px-4 py-2 text-sm">
              <span className="font-semibold">{formatarData(l.data)}{l.data_fim ? ` a ${formatarData(l.data_fim)}` : ""}</span>
              <span className="min-w-0 flex-1">{l.descricao} <span className="text-muted-foreground">· {ESCOPO[l.escopo]} {l.tribunal ?? l.uf ?? ""}</span></span>
              {dono ? <form action={removerDoCalendario.bind(null, l.id)}><button className={cn(botaoPequeno, "text-red-700 hover:bg-red-50")}>Remover</button></form> : null}
            </li>
          ))}
        </ul>
      )}

      <details className="mt-8">
        <summary className="cursor-pointer text-sm font-semibold">Lista do LAW — próximos dias sem expediente ({globais.length})</summary>
        <ul className="mt-2 grid gap-1 text-sm">
          {globais.slice(0, 60).map((l) => (
            <li key={l.id} className="flex gap-3 rounded-xl bg-white/60 px-3 py-1.5">
              <span className="w-24 shrink-0 font-semibold">{formatarData(l.data)}</span>
              <span>{l.descricao} <span className="text-muted-foreground">· {ESCOPO[l.escopo]} {l.tribunal ?? l.uf ?? ""}</span></span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
