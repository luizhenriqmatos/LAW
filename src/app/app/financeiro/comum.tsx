import Link from "next/link";
import { formatarCentavos } from "@/lib/dinheiro";
import { CATEGORIAS, STATUS_PARCELA } from "@/lib/financeiro/rotulos";
import { situacaoParcela, type StatusParcela } from "@/lib/financeiro/parcelas";
import { cn } from "@/lib/utils";

export type Saldo = { id: string | null; nome: string | null; em_aberto: number; atrasado: number; recebido: number };

const ABAS = [
  { href: "/app/financeiro", rotulo: "Visão geral" },
  { href: "/app/financeiro/lancamentos", rotulo: "Lançamentos" },
  { href: "/app/financeiro/novo", rotulo: "Novo lançamento" },
];

export function Abas({ atual }: { atual: string }) {
  return (
    <nav aria-label="Financeiro" className="mt-6 flex flex-wrap gap-2">
      {ABAS.map((a) => (
        <Link key={a.href} href={a.href} aria-current={a.href === atual ? "page" : undefined}
          className={cn("inline-flex h-9 items-center rounded-full px-4 text-sm font-medium", a.href === atual ? "bg-primary text-primary-foreground" : "bg-white hover:bg-muted")}>
          {a.rotulo}
        </Link>
      ))}
    </nav>
  );
}

export const rotuloCategoria = (c: string) => (c in CATEGORIAS ? CATEGORIAS[c as keyof typeof CATEGORIAS] : c);

/** Status mostrado: "aberta" vencida aparece como atrasada mesmo antes do job diário rodar. Parcial fica parcial (com aviso se vencida). */
export function SeloParcela({ status, vencimento, hoje }: { status: StatusParcela; vencimento: string; hoje: string }) {
  const s = situacaoParcela(status, vencimento, hoje);
  const cor: Record<string, string> = {
    paga: "bg-green-100 text-green-800", parcial: "bg-amber-100 text-amber-800", atrasada: "bg-red-100 text-red-700",
    cancelada: "bg-muted text-muted-foreground", aberta: "bg-sky-100 text-sky-800",
  };
  const vencida = s === "parcial" && vencimento < hoje;
  return <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold", vencida ? cor.atrasada : cor[s])}>{vencida ? "Parcial · vencida" : STATUS_PARCELA[s]}</span>;
}

export function Cartao({ titulo, valor, tom = "normal", nota }: { titulo: string; valor: number; tom?: "normal" | "alerta"; nota?: string }) {
  return (
    <div className={cn("rounded-[26px] p-6", tom === "alerta" && valor > 0 ? "bg-red-50" : "bg-white")}>
      <p className="text-sm text-muted-foreground">{titulo}</p>
      <p className={cn("mt-1 text-3xl font-semibold tracking-tight", tom === "alerta" && valor > 0 && "text-red-700")}>{formatarCentavos(valor)}</p>
      {nota ? <p className="mt-1 text-xs text-muted-foreground">{nota}</p> : null}
    </div>
  );
}

export function TabelaSaldos({ titulo, itens, base, vazio }: { titulo: string; itens: Saldo[]; base: string; vazio: string }) {
  return (
    <section className="rounded-[26px] bg-white p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{titulo}</h2>
      {itens.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">{vazio}</p> : (
        <ul className="mt-3 grid divide-y divide-border text-sm">
          {itens.slice(0, 15).map((s) => (
            <li key={s.id ?? "sem"} className="flex items-center justify-between gap-3 py-2">
              {s.id ? <Link href={`${base}/${s.id}`} className="min-w-0 truncate font-medium hover:underline">{s.nome ?? "—"}</Link> : <span className="text-muted-foreground">Sem vínculo</span>}
              <span className="shrink-0 text-right">
                <span className="font-semibold">{formatarCentavos(Number(s.em_aberto))}</span>
                {Number(s.atrasado) > 0 ? <span className="ml-2 text-xs font-semibold text-red-700">{formatarCentavos(Number(s.atrasado))} atrasado</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export type ItemLancamento = {
  id: string; tipo: "receita" | "despesa"; categoria: string; descricao: string; valor_centavos: number; data_competencia: string;
  cliente_nome: string | null; numero_cnj: string | null; cancelado_em: string | null;
  parcelas: number; pago: number; aberto: number; atrasado: number; proximo_vencimento: string | null;
};

export const dataBr = (d: string | null | undefined) => (d ? d.split("-").reverse().join("/") : "—");

export function TabelaLancamentos({ itens }: { itens: ItemLancamento[] }) {
  if (itens.length === 0) return <p className="mt-4 rounded-[26px] bg-white p-6 text-sm text-muted-foreground">Nenhum lançamento encontrado.</p>;
  return (
    <div className="mt-4 overflow-x-auto rounded-[26px] bg-white p-2">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="p-3">Competência</th><th className="p-3">Descrição</th><th className="p-3 text-right">Total</th>
            <th className="p-3 text-right">Pago</th><th className="p-3 text-right">Em aberto</th><th className="p-3">Situação</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {itens.map((l) => (
            <tr key={l.id} className={cn(l.cancelado_em && "text-muted-foreground line-through decoration-1")}>
              <td className="p-3 whitespace-nowrap">{dataBr(l.data_competencia)}</td>
              <td className="p-3">
                <Link href={`/app/financeiro/lancamentos/${l.id}`} className="font-medium hover:underline">{l.descricao}</Link>
                <p className="text-xs text-muted-foreground no-underline">
                  {l.tipo === "despesa" ? "Despesa" : "Receita"} · {rotuloCategoria(l.categoria)}{l.cliente_nome ? ` · ${l.cliente_nome}` : ""}{l.numero_cnj ? ` · ${l.numero_cnj}` : ""}
                </p>
              </td>
              <td className="p-3 text-right whitespace-nowrap">{formatarCentavos(Number(l.valor_centavos))}</td>
              <td className="p-3 text-right whitespace-nowrap">{formatarCentavos(Number(l.pago))}</td>
              <td className="p-3 text-right whitespace-nowrap font-semibold">{formatarCentavos(Number(l.aberto))}</td>
              <td className="p-3 whitespace-nowrap">
                {l.cancelado_em ? "Cancelado" : Number(l.atrasado) > 0 ? <span className="font-semibold text-red-700">Atrasado</span> : Number(l.aberto) > 0 ? "Em aberto" : "Quitado"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type LinhaExtrato = {
  id: string; lancamento_id: string; numero: number; total_parcelas: number; valor_centavos: number; valor_pago_centavos: number;
  vencimento: string; status: StatusParcela; tipo: "receita" | "despesa"; categoria: string; descricao: string; cancelado_em: string | null;
};
export type TotaisExtrato = { receita: { total: number; pago: number; em_aberto: number; atrasado: number }; despesa: { total: number; pago: number; em_aberto: number; atrasado: number } };

export function Extrato({ titulo, subtitulo, linhas, totais, truncado, hoje, exportar }: {
  titulo: string; subtitulo?: string; linhas: LinhaExtrato[]; totais: TotaisExtrato; truncado: boolean; hoje: string; exportar: string;
}) {
  return (
    <div className="mx-auto max-w-5xl">
      <p className="mt-2 text-sm"><Link href="/app/financeiro" className="text-muted-foreground hover:underline">← Financeiro</Link></p>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">{titulo}</h1>
      {subtitulo ? <p className="mt-2 text-muted-foreground">{subtitulo}</p> : null}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Cartao titulo="Receitas lançadas" valor={Number(totais.receita.total)} />
        <Cartao titulo="Recebido" valor={Number(totais.receita.pago)} />
        <Cartao titulo="Saldo em aberto" valor={Number(totais.receita.em_aberto)} nota={Number(totais.receita.atrasado) > 0 ? `${formatarCentavos(Number(totais.receita.atrasado))} atrasado` : undefined} />
      </div>
      {Number(totais.despesa.total) > 0 ? <p className="mt-3 text-sm text-muted-foreground">Despesas: {formatarCentavos(Number(totais.despesa.total))} lançadas, {formatarCentavos(Number(totais.despesa.em_aberto))} em aberto (não entram no saldo).</p> : null}
      <p className="mt-4 text-sm"><Link href={exportar} prefetch={false} className="font-medium hover:underline">Exportar CSV</Link></p>
      {linhas.length === 0 ? <p className="mt-4 rounded-[26px] bg-white p-6 text-sm text-muted-foreground">Nenhuma parcela encontrada.</p> : (
        <div className="mt-4 overflow-x-auto rounded-[26px] bg-white p-2">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wider text-muted-foreground"><th className="p-3">Vencimento</th><th className="p-3">Descrição</th><th className="p-3 text-right">Valor</th><th className="p-3 text-right">Pago</th><th className="p-3">Status</th></tr></thead>
            <tbody className="divide-y divide-border">
              {linhas.map((p) => (
                <tr key={p.id}>
                  <td className="p-3 whitespace-nowrap">{dataBr(p.vencimento)}</td>
                  <td className="p-3"><Link href={`/app/financeiro/lancamentos/${p.lancamento_id}`} className="font-medium hover:underline">{p.descricao}</Link>
                    <p className="text-xs text-muted-foreground">{p.tipo === "despesa" ? "Despesa" : "Receita"} · {rotuloCategoria(p.categoria)} · {p.numero}/{p.total_parcelas}</p></td>
                  <td className="p-3 text-right whitespace-nowrap">{formatarCentavos(Number(p.valor_centavos))}</td>
                  <td className="p-3 text-right whitespace-nowrap">{formatarCentavos(Number(p.valor_pago_centavos))}</td>
                  <td className="p-3"><SeloParcela status={p.status} vencimento={p.vencimento} hoje={hoje} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncado ? <p className="mt-3 text-xs text-muted-foreground">Mostrando as primeiras parcelas. Use o CSV para ver tudo.</p> : null}
    </div>
  );
}
