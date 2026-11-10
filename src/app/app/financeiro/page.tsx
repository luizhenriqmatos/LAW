import Link from "next/link";
import { exigirModulo } from "@/lib/contexto";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { Aviso } from "../processos/comum";
import { Abas, Cartao, TabelaSaldos, type Saldo } from "./comum";

type Resumo = { a_receber: number; atrasado: number; a_pagar: number; parcelas_atrasadas: number; recebido_mes: number; despesas_mes: number };

export default async function Financeiro({ searchParams }: PageProps<"/app/financeiro">) {
  // Camada 2 (rota); a camada 3 (RLS + conferência dentro das funções) recusa de novo no banco.
  const { supabase, vinculo } = await exigirModulo("financeiro");
  const sp = await searchParams;
  const hoje = hojeBrasilia();
  const esc = vinculo.escritorioId;
  const [resumo, porCliente, porProcesso] = await Promise.all([
    supabase.rpc("financeiro_resumo", { p_escritorio: esc, p_hoje: hoje }),
    supabase.rpc("financeiro_saldos", { p_escritorio: esc, p_por: "cliente", p_hoje: hoje }),
    supabase.rpc("financeiro_saldos", { p_escritorio: esc, p_por: "processo", p_hoje: hoje }),
  ]);
  const erro = resumo.error || porCliente.error || porProcesso.error;
  const r = (resumo.data ?? {}) as Partial<Resumo>;
  const clientes = ((porCliente.data ?? []) as Saldo[]).filter((s) => Number(s.em_aberto) > 0);
  const processos = ((porProcesso.data ?? []) as Saldo[]).filter((s) => Number(s.em_aberto) > 0);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-5xl font-medium tracking-tight">Financeiro</h1>
      <p className="mt-2 text-muted-foreground">Honorários, custas e despesas do escritório, ligados a clientes e processos.</p>
      <Abas atual="/app/financeiro" />
      <Aviso codigo={sp.aviso} />
      {erro ? <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">Não foi possível carregar o financeiro. Tente de novo.</p> : null}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Cartao titulo="A receber (no prazo)" valor={Number(r.a_receber ?? 0)} nota="Parcelas de receita que ainda não venceram" />
        <Cartao titulo="Recebido no mês" valor={Number(r.recebido_mes ?? 0)} nota="Pagamentos com data neste mês" />
        <Cartao titulo="Atrasado" valor={Number(r.atrasado ?? 0)} tom="alerta" nota={r.parcelas_atrasadas ? `${r.parcelas_atrasadas} parcela(s) vencida(s)` : undefined} />
        <Cartao titulo="Despesas do mês" valor={Number(r.despesas_mes ?? 0)} nota="Competência neste mês" />
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Link href="/app/financeiro/exportar" prefetch={false} className="inline-flex h-9 items-center rounded-full bg-white px-4 text-sm font-medium hover:bg-muted">Exportar tudo em CSV</Link>
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <TabelaSaldos titulo="Saldo em aberto por cliente" itens={clientes} base="/app/financeiro/clientes" vazio="Nenhum cliente com saldo em aberto." />
        <TabelaSaldos titulo="Saldo em aberto por processo" itens={processos} base="/app/financeiro/processos" vazio="Nenhum processo com saldo em aberto." />
      </div>
    </div>
  );
}
