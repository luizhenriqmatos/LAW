import Link from "next/link";
import { redirect } from "next/navigation";
import { NOME_ASSISTENTE } from "@/lib/assistente/nome";
import { exigirModulo } from "@/lib/contexto";
import { dataHora } from "../comum";

export default async function PaginaMinutas() {
  const { supabase, modulos } = await exigirModulo("assistente");
  if (!modulos.includes("documentos")) redirect("/app/sem-acesso?modulo=documentos");
  const { data } = await supabase.from("minuta").select("id, titulo, status, criado_em").order("criado_em", { ascending: false }).limit(100);
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/app/assistente" className="text-sm text-muted-foreground hover:underline">← {NOME_ASSISTENTE}</Link>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">Minutas</h1>
      <p className="mt-3 text-muted-foreground">Minutas geradas a partir dos modelos do escritório. Toda minuta nasce <strong>não revisada</strong>.</p>
      {data?.length ? (
        <ul className="mt-6 grid gap-2">
          {data.map((m) => (
            <li key={m.id}>
              <Link href={`/app/assistente/minutas/${m.id}`} className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 hover:bg-muted/50">
                <span className="truncate font-medium">{m.titulo}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs">
                  <span className={m.status === "revisado" ? "rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-800" : "rounded-full bg-amber-100 px-2 py-0.5 text-amber-900"}>
                    {m.status === "revisado" ? "Revisada" : "Não revisada"}
                  </span>
                  <span className="text-muted-foreground">{dataHora(m.criado_em)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : <p className="mt-6 text-sm text-muted-foreground">Nenhuma minuta ainda.</p>}
    </div>
  );
}
