import Link from "next/link";
import { notFound } from "next/navigation";
import { exigirModulo } from "@/lib/contexto";
import { formatarCentavos } from "@/lib/dinheiro";
import { FORMAS, TIPOS } from "@/lib/financeiro/rotulos";
import type { StatusParcela } from "@/lib/financeiro/parcelas";
import { hojeBrasilia } from "@/lib/prazos/servidor";
import { Aviso, botaoPequeno } from "../../../processos/comum";
import { alterarVencimento, cancelarLancamento, cancelarParcela, estornarPagamento, registrarPagamento } from "../../actions";
import { Abas, dataBr, rotuloCategoria, SeloParcela } from "../../comum";

type Pagamento = { id: string; valor_centavos: number; data_pagamento: string; forma_pagamento: string | null; estornado_em: string | null };
type Parcela = { id: string; numero: number; valor_centavos: number; valor_pago_centavos: number; vencimento: string; status: StatusParcela; pagamentos: Pagamento[] };
type Detalhe = {
  lancamento: { id: string; tipo: "receita" | "despesa"; categoria: string; descricao: string; valor_centavos: number; data_competencia: string; cancelado_em: string | null; cliente_id: string | null; processo_id: string | null };
  cliente_nome: string | null; numero_cnj: string | null; parcelas: Parcela[];
};

const entrada = "h-9 rounded-xl border border-border bg-white px-2 text-sm";

export default async function DetalheLancamento({ params, searchParams }: PageProps<"/app/financeiro/lancamentos/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase } = await exigirModulo("financeiro");
  const { data, error } = await supabase.rpc("lancamento_obter", { p_lancamento: id });
  if (error || !data) notFound();
  const d = data as Detalhe;
  const l = d.lancamento;
  const hoje = hojeBrasilia();
  const destino = `/app/financeiro/lancamentos/${l.id}`;
  const cancelado = l.cancelado_em !== null;
  const ativas = d.parcelas.filter((p) => p.status !== "cancelada");
  const pago = ativas.reduce((s, p) => s + Number(p.valor_pago_centavos), 0);
  const aberto = ativas.filter((p) => p.status !== "paga").reduce((s, p) => s + Math.max(Number(p.valor_centavos) - Number(p.valor_pago_centavos), 0), 0);

  return (
    <div className="mx-auto max-w-5xl">
      <p className="mt-2 text-sm"><Link href="/app/financeiro/lancamentos" className="text-muted-foreground hover:underline">← Lançamentos</Link></p>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">{l.descricao}</h1>
      <p className="mt-2 text-muted-foreground">
        {TIPOS[l.tipo]} · {rotuloCategoria(l.categoria)} · competência {dataBr(l.data_competencia)}
        {d.cliente_nome && l.cliente_id ? <> · <Link className="hover:underline" href={`/app/financeiro/clientes/${l.cliente_id}`}>{d.cliente_nome}</Link></> : null}
        {d.numero_cnj && l.processo_id ? <> · <Link className="hover:underline" href={`/app/financeiro/processos/${l.processo_id}`}>{d.numero_cnj}</Link></> : null}
      </p>
      <Abas atual="" />
      <Aviso codigo={sp.aviso} />
      {cancelado ? <p className="mt-4 rounded-xl bg-muted px-4 py-3 text-sm font-medium">Lançamento cancelado em {dataBr(l.cancelado_em?.slice(0, 10))}.</p> : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-[26px] bg-white p-6"><p className="text-sm text-muted-foreground">Valor total</p><p className="mt-1 text-2xl font-semibold">{formatarCentavos(Number(l.valor_centavos))}</p></div>
        <div className="rounded-[26px] bg-white p-6"><p className="text-sm text-muted-foreground">Pago</p><p className="mt-1 text-2xl font-semibold">{formatarCentavos(pago)}</p></div>
        <div className="rounded-[26px] bg-white p-6"><p className="text-sm text-muted-foreground">Em aberto</p><p className="mt-1 text-2xl font-semibold">{formatarCentavos(cancelado ? 0 : aberto)}</p></div>
      </div>

      <ul className="mt-6 grid gap-3">
        {d.parcelas.map((p) => {
          const saldo = Math.max(Number(p.valor_centavos) - Number(p.valor_pago_centavos), 0);
          const pagavel = !cancelado && (p.status === "aberta" || p.status === "atrasada" || p.status === "parcial");
          return (
            <li key={p.id} className="rounded-[26px] bg-white p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">Parcela {p.numero}/{d.parcelas.length} · vence {dataBr(p.vencimento)}</p>
                <SeloParcela status={p.status} vencimento={p.vencimento} hoje={hoje} />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatarCentavos(Number(p.valor_centavos))} · pago {formatarCentavos(Number(p.valor_pago_centavos))}{p.status !== "cancelada" && saldo > 0 ? ` · falta ${formatarCentavos(saldo)}` : ""}
              </p>

              {p.pagamentos.length > 0 ? (
                <ul className="mt-3 grid gap-1 text-sm">
                  {p.pagamentos.map((g) => (
                    <li key={g.id} className={g.estornado_em ? "flex items-center justify-between text-muted-foreground line-through" : "flex items-center justify-between"}>
                      <span>{dataBr(g.data_pagamento)} · {formatarCentavos(Number(g.valor_centavos))}{g.forma_pagamento ? ` · ${FORMAS[g.forma_pagamento as keyof typeof FORMAS] ?? g.forma_pagamento}` : ""}{g.estornado_em ? " · estornado" : ""}</span>
                      {!g.estornado_em && !cancelado ? (
                        <form action={estornarPagamento.bind(null, g.id, destino)}>
                          <button className={`${botaoPequeno} bg-muted hover:bg-border`}>Estornar</button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {pagavel ? (
                <div className="mt-4 grid gap-3 border-t border-border pt-4">
                  <form action={registrarPagamento.bind(null, p.id, destino)} className="flex flex-wrap items-end gap-2">
                    <label className="grid gap-1 text-xs font-medium">Valor pago (R$)
                      <input name="valor" required inputMode="decimal" defaultValue={formatarCentavos(saldo).replace(/[^\d,.]/g, "").trim()} className={`${entrada} w-32`} />
                    </label>
                    <label className="grid gap-1 text-xs font-medium">Data
                      <input name="data" type="date" defaultValue={hoje} max={hoje} className={entrada} />
                    </label>
                    <label className="grid gap-1 text-xs font-medium">Forma
                      <select name="forma" defaultValue="" className={entrada}><option value="">—</option>{Object.entries(FORMAS).map(([k, r]) => <option key={k} value={k}>{r}</option>)}</select>
                    </label>
                    <button className={`${botaoPequeno} h-9 bg-primary px-4 text-primary-foreground`}>Registrar pagamento</button>
                  </form>
                  <div className="flex flex-wrap items-end gap-3">
                    <form action={alterarVencimento.bind(null, p.id, destino)} className="flex items-end gap-2">
                      <label className="grid gap-1 text-xs font-medium">Novo vencimento
                        <input name="vencimento" type="date" required defaultValue={p.vencimento} className={entrada} />
                      </label>
                      <button className={`${botaoPequeno} h-9 bg-muted hover:bg-border`}>Alterar</button>
                    </form>
                    {Number(p.valor_pago_centavos) === 0 ? (
                      <form action={cancelarParcela.bind(null, p.id, destino)}>
                        <button className={`${botaoPequeno} h-9 bg-muted hover:bg-border`}>Cancelar parcela</button>
                      </form>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {!cancelado && pago === 0 ? (
        <form action={cancelarLancamento.bind(null, l.id, destino)} className="mt-6">
          <button className={`${botaoPequeno} h-9 bg-red-50 text-red-700 hover:bg-red-100`}>Cancelar lançamento</button>
          <p className="mt-1 text-xs text-muted-foreground">O valor não pode ser editado: cancele e crie de novo. O histórico fica no registro de auditoria.</p>
        </form>
      ) : null}
      {!cancelado && pago > 0 ? <p className="mt-6 text-xs text-muted-foreground">Para cancelar este lançamento, estorne antes os pagamentos registrados.</p> : null}
    </div>
  );
}
