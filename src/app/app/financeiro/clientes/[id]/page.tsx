import { notFound } from "next/navigation";
import { z } from "zod";
import { exigirModulo } from "@/lib/contexto";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { Extrato, type LinhaExtrato, type TotaisExtrato } from "../../comum";

export default async function ExtratoPagina({ params }: PageProps<"/app/financeiro/clientes/[id]">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, vinculo } = await exigirModulo("financeiro");
  const esc = vinculo.escritorioId;
  const hoje = hojeBrasilia();
  const [parcelas, opcoes] = await Promise.all([
    supabase.rpc("financeiro_parcelas", { p_escritorio: esc, p_filtros: { cliente_id: id, limite: 500 }, p_hoje: hoje }),
    supabase.rpc("financeiro_opcoes", { p_escritorio: esc }),
  ]);
  if (parcelas.error) notFound();
  const r = parcelas.data as { itens: LinhaExtrato[]; totais: TotaisExtrato; truncado: boolean };
  const op = (opcoes.data ?? { clientes: [], processos: [] }) as { clientes: { id: string; nome: string }[]; processos: { id: string; numero_cnj: string }[] };
  const nome = op.clientes.find((c) => c.id === id)?.nome;
  if (!nome) notFound();
  return <Extrato titulo={nome} subtitulo="Extrato do cliente: parcelas por vencimento" linhas={r.itens} totais={r.totais} truncado={r.truncado} hoje={hoje} exportar={`/app/financeiro/exportar?cliente=${id}`} />;
}
