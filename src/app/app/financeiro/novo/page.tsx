import { exigirModulo } from "@/lib/contexto";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { Abas } from "../comum";
import { FormularioLancamento } from "../formulario";

export default async function NovoLancamento() {
  const { supabase, vinculo } = await exigirModulo("financeiro");
  const { data, error } = await supabase.rpc("financeiro_opcoes", { p_escritorio: vinculo.escritorioId });
  const opcoes = (data ?? { clientes: [], processos: [] }) as { clientes: { id: string; nome: string }[]; processos: { id: string; numero_cnj: string; titulo: string | null }[] };
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-5xl font-medium tracking-tight">Novo lançamento</h1>
      <Abas atual="/app/financeiro/novo" />
      {error ? <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">Não foi possível carregar clientes e processos.</p> : null}
      <FormularioLancamento opcoes={opcoes} hoje={hojeBrasilia()} />
    </div>
  );
}
