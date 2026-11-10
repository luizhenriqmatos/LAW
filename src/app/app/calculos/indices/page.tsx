import { mesBr } from "@/lib/calculos/base";
import { situacaoIndices } from "@/lib/calculos/servidor";
import { exigirModulo } from "@/lib/contexto";
import { Aviso, botaoPequeno } from "../../processos/comum";
import { atualizarIndicesAgora } from "../actions";
import { Abas } from "../comum";

export default async function Indices({ searchParams }: PageProps<"/app/calculos/indices">) {
  const { supabase, vinculo } = await exigirModulo("calculos");
  const sp = await searchParams;
  const series = await situacaoIndices(supabase);
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-5xl font-medium tracking-tight">Índices</h1>
      <p className="mt-2 text-muted-foreground">Cópia local das séries oficiais do Banco Central (SGS). O cálculo nunca consulta a internet na hora: usa esta cópia, atualizada automaticamente nos dias 2, 12 e 26 de cada mês.</p>
      <Abas atual="/app/calculos/indices" />
      <Aviso codigo={sp.aviso} />
      <div className="mt-6 overflow-x-auto rounded-[26px] bg-white p-2">
        <table className="w-full min-w-[640px] text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wider text-muted-foreground"><th className="p-3">Série</th><th className="p-3">Código SGS</th><th className="p-3">Último mês</th><th className="p-3">Coletado em</th><th className="p-3">Erro</th></tr></thead>
          <tbody className="divide-y divide-border">
            {series.map((s) => (
              <tr key={s.codigo}>
                <td className="p-3 font-medium">{s.nome}</td>
                <td className="p-3">{s.sgs}</td>
                <td className="p-3">{s.ultimo_mes ? mesBr(s.ultimo_mes.slice(0, 7)) : "—"}</td>
                <td className="p-3">{s.coletado_em ? new Date(s.coletado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"}</td>
                <td className="p-3 text-red-700">{s.erro ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">A Selic do mês corrente só entra quando o mês fecha (o valor publicado durante o mês é parcial). A Taxa Legal sai no 1º dia útil do mês.</p>
      {vinculo.papel === "dono" ? (
        <form action={atualizarIndicesAgora} className="mt-4">
          <button className={`${botaoPequeno} h-9 bg-primary px-4 text-primary-foreground`}>Atualizar agora com o Banco Central</button>
        </form>
      ) : null}
    </div>
  );
}
