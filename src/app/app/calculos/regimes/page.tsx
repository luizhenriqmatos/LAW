import { descreverCorrecao, descreverJuros, descreverVigencia } from "@/lib/calculos/base";
import { carregarRegimes, type RegimeLinha } from "@/lib/calculos/servidor";
import { exigirModulo } from "@/lib/contexto";
import { Aviso, botaoPequeno } from "../../processos/comum";
import { arquivarRegime } from "../actions";
import { Abas } from "../comum";
import { FormularioRegime } from "./formulario";

const ESCOPO: Record<string, string> = { civel: "cível", trabalhista: "trabalhista", fazenda_pre_expedicao: "Fazenda (antes da expedição)", fazenda_pos_expedicao: "Fazenda (depois da expedição)" };

function Cartao({ r, versoes }: { r: RegimeLinha; versoes: RegimeLinha[] }) {
  return (
    <li className="rounded-[26px] bg-white p-6 text-sm">
      <p className="font-semibold">{r.nome}</p>
      <p className="mt-1 text-muted-foreground">Versão {r.versao} · {r.escritorio_id ? "personalizado" : "padrão do LAW"} · {ESCOPO[r.escopo] ?? r.escopo} · vigência: {descreverVigencia(r)}</p>
      <p className="mt-2">Correção: {descreverCorrecao(r.correcao_indice, r.correcao_pro_rata)}{r.indice_editavel ? " (o índice pode ser trocado no cálculo)" : ""}.</p>
      <p>Juros: {descreverJuros(r)}.</p>
      <p className="mt-1 text-xs text-muted-foreground">Fundamento: {r.fundamento}</p>
      {versoes.length ? <p className="mt-2 text-xs text-muted-foreground">Versões anteriores guardadas: {versoes.map((v) => v.versao).join(", ")} (os cálculos que as usaram continuam iguais).</p> : null}
      {r.escritorio_id ? (
        <div className="mt-4 flex flex-wrap items-start gap-3">
          <details className="w-full rounded-2xl bg-muted/50 p-4">
            <summary className="cursor-pointer font-medium">Criar nova versão</summary>
            <div className="mt-4"><FormularioRegime base={r} /></div>
          </details>
          <form action={arquivarRegime.bind(null, r.id)}><button className={`${botaoPequeno} bg-muted hover:bg-border`}>Arquivar</button></form>
        </div>
      ) : null}
    </li>
  );
}

export default async function Regimes({ searchParams }: PageProps<"/app/calculos/regimes">) {
  const { supabase } = await exigirModulo("calculos");
  const sp = await searchParams;
  const regimes = await carregarRegimes(supabase);
  const ativos = regimes.filter((r) => r.ativo);
  const antigas = (r: RegimeLinha) => regimes.filter((x) => x.grupo_id === r.grupo_id && x.id !== r.id && x.versao < r.versao);
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-5xl font-medium tracking-tight">Regimes</h1>
      <p className="mt-2 text-muted-foreground">Regras de correção e juros. São dados, não código: o regime nunca é alterado, cada mudança vira uma nova versão, e o cálculo antigo continua reproduzível.</p>
      <Abas atual="/app/calculos/regimes" />
      <Aviso codigo={sp.aviso} />
      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Padrão cível do LAW (sugestão)</h2>
      <ul className="mt-3 grid gap-3">{ativos.filter((r) => !r.escritorio_id && r.escopo === "civel").map((r) => <Cartao key={r.id} r={r} versoes={antigas(r)} />)}</ul>
      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Padrão trabalhista do LAW (STF, ADC 58 + TST)</h2>
      <ul className="mt-3 grid gap-3">{ativos.filter((r) => !r.escritorio_id && r.escopo === "trabalhista").map((r) => <Cartao key={r.id} r={r} versoes={antigas(r)} />)}</ul>
      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Personalizados do escritório</h2>
      {ativos.some((r) => r.escritorio_id) ? (
        <ul className="mt-3 grid gap-3">{ativos.filter((r) => r.escritorio_id).map((r) => <Cartao key={r.id} r={r} versoes={antigas(r)} />)}</ul>
      ) : <p className="mt-3 rounded-[26px] bg-white p-6 text-sm text-muted-foreground">Nenhum ainda. Crie um quando a decisão fixar critério diferente (&quot;critério definido na sentença&quot;).</p>}
      <section className="mt-8 rounded-[26px] bg-white p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Novo regime personalizado</h2>
        <div className="mt-4"><FormularioRegime /></div>
      </section>
    </div>
  );
}
