import Link from "next/link";
import { Dec, NOMES_SERIE, dataBr, mesBr } from "@/lib/calculos/base";
import { NOMES_TIPO, type Demonstrativo } from "@/lib/calculos/calculos";
import { descreverParcelas } from "@/lib/calculos/pdf";
import { formatarCentavos } from "@/lib/dinheiro";
import { cn } from "@/lib/utils";

const ABAS = [
  { href: "/app/calculos", rotulo: "Cálculos" },
  { href: "/app/calculos/novo", rotulo: "Novo cálculo" },
  { href: "/app/calculos/regimes", rotulo: "Regimes" },
  { href: "/app/calculos/indices", rotulo: "Índices" },
];

export function Abas({ atual }: { atual: string }) {
  return (
    <nav aria-label="Cálculos" className="mt-6 flex flex-wrap gap-2">
      {ABAS.map((a) => (
        <Link key={a.href} href={a.href} aria-current={a.href === atual ? "page" : undefined}
          className={cn("inline-flex h-9 items-center rounded-full px-4 text-sm font-medium", a.href === atual ? "bg-primary text-primary-foreground" : "bg-white hover:bg-muted")}>
          {a.rotulo}
        </Link>
      ))}
    </nav>
  );
}

const pct = (v: string, casas = 6) => `${new Dec(v).toFixed(casas).replace(".", ",")}%`;

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[26px] bg-white p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{titulo}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Pares({ itens }: { itens: { rotulo: string; valor: string }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[minmax(0,14rem)_1fr]">
      {itens.map((i, k) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{i.rotulo}</dt>
          <dd>{i.valor}</dd>
        </div>
      ))}
    </dl>
  );
}

/** O mesmo demonstrativo do PDF, na tela. */
export function VerDemonstrativo({ d }: { d: Demonstrativo }) {
  return (
    <div className="mt-6 grid gap-4">
      <Secao titulo={NOMES_TIPO[d.tipo]}>
        <Pares itens={[
          { rotulo: "Processo", valor: d.cabecalho.processo ?? "Não vinculado" },
          { rotulo: "Partes", valor: d.cabecalho.partes ?? "—" },
          { rotulo: "Data do cálculo", valor: dataBr(d.dataCalculo) },
          ...d.cabecalho.parametros,
        ]} />
      </Secao>

      {d.regras.length ? <Secao titulo="Regras aplicadas (linha do tempo)"><ListaRegras regras={d.regras} /></Secao> : null}

      {d.apuracao?.length ? (
        <Secao titulo="Apuração das verbas rescisórias">
          <ul className="grid gap-2 text-sm">
            {d.apuracao.map((v) => (
              <li key={v.descricao} className="rounded-2xl bg-muted/50 p-3">
                <div className="flex justify-between gap-3 font-medium"><span>{v.descricao}</span><span className="tabular-nums">{v.centavos ? formatarCentavos(v.centavos) : "não devido"}</span></div>
                <p className="mt-0.5 text-xs text-muted-foreground">{v.regra}</p>
              </li>
            ))}
          </ul>
        </Secao>
      ) : null}

      {d.verbas?.length ? (
        <Secao titulo="Atualização verba por verba">
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead><tr className="text-left text-xs uppercase tracking-wider text-muted-foreground"><th className="p-2">Verba</th><th className="p-2">Vencimento</th><th className="p-2 text-right">Original</th><th className="p-2 text-right">Corrigido</th><th className="p-2 text-right">Juros</th><th className="p-2 text-right">Total</th></tr></thead>
              <tbody className="divide-y divide-border">
                {d.verbas.map((v, i) => (
                  <tr key={i}><td className="p-2">{v.descricao}</td><td className="p-2">{dataBr(v.vencimento)}</td><td className="p-2 text-right tabular-nums">{formatarCentavos(v.original)}</td><td className="p-2 text-right tabular-nums">{formatarCentavos(v.corrigido)}</td><td className="p-2 text-right tabular-nums">{formatarCentavos(v.juros)}</td><td className="p-2 text-right font-medium tabular-nums">{formatarCentavos(v.total)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Secao>
      ) : null}

      {d.grupos?.map((g) => (
        <Secao key={g.vencimento} titulo={g.titulo}>
          <ListaRegras regras={g.regras} />
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium">Evolução mês a mês ({g.tabela.length} meses)</summary>
            <div className="mt-3"><TabelaMensal tabela={g.tabela} valorBase={g.valorBaseCentavos} regras={g.regras} /></div>
          </details>
        </Secao>
      ))}

      {d.blocos.map((b) => (
        <Secao key={b.titulo} titulo={b.titulo}><Pares itens={b.linhas} /></Secao>
      ))}

      {d.tabela?.length ? <Secao titulo="Evolução mês a mês"><TabelaMensal tabela={d.tabela} valorBase={d.valorBaseCentavos} regras={d.regras} /></Secao> : null}

      <section className="rounded-[26px] bg-primary p-6 text-primary-foreground">
        <dl className="grid gap-2 text-sm">
          {d.totais.map((t) => (
            <div key={t.rotulo} className={cn("flex items-baseline justify-between gap-4", t.destaque && "border-t border-white/20 pt-2 text-lg font-semibold")}>
              <dt className={t.destaque ? "" : "opacity-80"}>{t.rotulo}</dt>
              <dd className="tabular-nums">{formatarCentavos(t.centavos)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {d.series.length ? (
        <Secao titulo="Fonte dos índices">
          <ul className="grid gap-1 text-sm">
            {d.series.map((s) => (
              <li key={s.codigo}>
                <span className="font-medium">{NOMES_SERIE[s.codigo] ?? s.nome}</span>: {s.fonte}. Coletado em {s.coletado_em ? new Date(s.coletado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"}; último mês no cache: {s.ultimo_mes ? mesBr(s.ultimo_mes.slice(0, 7)) : "—"}.
              </li>
            ))}
          </ul>
        </Secao>
      ) : null}

      <div className="rounded-[26px] bg-amber-50 p-5 text-sm text-amber-900">
        {d.avisos.map((a) => <p key={a}>{a}</p>)}
      </div>
    </div>
  );
}

function ListaRegras({ regras }: { regras: Demonstrativo["regras"] }) {
  return (
    <ol className="grid gap-3">
      {regras.map((r, i) => (
        <li key={i} className="rounded-2xl bg-muted/50 p-4 text-sm">
          <p className="font-semibold">Trecho {i + 1}: {dataBr(r.inicio)} a {dataBr(r.fim)}</p>
          <p className="mt-0.5">{r.regime} <span className="text-muted-foreground">(versão {r.versao})</span></p>
          <p className="mt-1">Correção: {r.correcao}{r.mesesCorrecao ? `; índices de ${r.mesesCorrecao}` : ""}.</p>
          <p>Juros: {r.juros}.</p>
          <p className="mt-1 text-xs text-muted-foreground">Fundamento: {r.fundamento}</p>
        </li>
      ))}
    </ol>
  );
}

function TabelaMensal({ tabela, valorBase, regras }: { tabela: NonNullable<Demonstrativo["tabela"]>; valorBase: number | null; regras: Demonstrativo["regras"] }) {
  return (
    <>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[980px] text-xs">
          <thead>
            <tr className="text-left uppercase tracking-wider text-muted-foreground">
              <th className="p-2">Mês</th><th className="p-2 text-right">Valor base</th><th className="p-2">Índice do mês</th><th className="p-2 text-right">Fator acumulado</th>
              <th className="p-2 text-right">Valor corrigido</th><th className="p-2 text-right">Juros do mês</th><th className="p-2 text-right">Juros acumulados</th>
              <th className="p-2 text-right">Subtotal</th><th className="p-2">Trecho</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tabela.map((l) => (
              <tr key={l.mes}>
                <td className="whitespace-nowrap p-2">{mesBr(l.mes)}</td>
                <td className="whitespace-nowrap p-2 text-right">{valorBase === null ? "—" : formatarCentavos(valorBase)}</td>
                <td className="p-2">{descreverParcelas(l.correcao)}</td>
                <td className="whitespace-nowrap p-2 text-right tabular-nums">{new Dec(l.fatorAcumulado).toFixed(8).replace(".", ",")}</td>
                <td className="whitespace-nowrap p-2 text-right tabular-nums">{formatarCentavos(l.valorCorrigido)}</td>
                <td className="whitespace-nowrap p-2 text-right tabular-nums" title={descreverParcelas(l.juros)}>
                  {formatarCentavos(l.jurosMes)} <span className="text-muted-foreground">({pct(l.jurosMesPercentual)})</span>{l.ajusteTeto ? " · teto" : ""}
                </td>
                <td className="whitespace-nowrap p-2 text-right tabular-nums">{formatarCentavos(l.jurosAcumulados)} <span className="text-muted-foreground">({pct(l.jurosAcumuladoPercentual)})</span></td>
                <td className="whitespace-nowrap p-2 text-right font-medium tabular-nums">{formatarCentavos(l.subtotal)}</td>
                <td className="whitespace-nowrap p-2">{[...new Set(l.regimes.map((id) => `T${regras.findIndex((r) => r.regimeId === id) + 1}`))].join(" + ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Juros do mês = valor corrigido do mês × taxa do mês. Juros acumulados = valor corrigido × soma das taxas (juros simples sobre o valor corrigido). Na fase da Selic, ela entra no fator (soma simples) e não há juros à parte.</p>
    </>
  );
}
