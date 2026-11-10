import Link from "next/link";
import { exigirModulo } from "@/lib/contexto";
import { lerFiltros, paraLancamentos, paraQuery, POR_PAGINA } from "@/lib/financeiro/filtros";
import { CATEGORIAS, SITUACOES_LANCAMENTO, TIPOS } from "@/lib/financeiro/rotulos";
import { Aviso } from "../../processos/comum";
import { Abas, TabelaLancamentos, type ItemLancamento } from "../comum";

const selecao = "h-10 w-full rounded-xl border border-border bg-white px-3 text-sm";

export default async function Lancamentos({ searchParams }: PageProps<"/app/financeiro/lancamentos">) {
  const { supabase, vinculo } = await exigirModulo("financeiro");
  const sp = await searchParams;
  const f = lerFiltros(sp);
  const esc = vinculo.escritorioId;
  const [lista, opcoes] = await Promise.all([
    supabase.rpc("financeiro_lancamentos", { p_escritorio: esc, p_filtros: paraLancamentos(f) }),
    supabase.rpc("financeiro_opcoes", { p_escritorio: esc }),
  ]);
  const dados = (lista.data ?? { total: 0, itens: [] }) as { total: number; itens: ItemLancamento[] };
  const op = (opcoes.data ?? { clientes: [], processos: [] }) as { clientes: { id: string; nome: string }[]; processos: { id: string; numero_cnj: string }[] };
  const pagina = f.pagina ?? 1;
  const paginas = Math.max(Math.ceil(dados.total / POR_PAGINA), 1);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-5xl font-medium tracking-tight">Lançamentos</h1>
      <Abas atual="/app/financeiro/lancamentos" />
      <Aviso codigo={sp.aviso} />
      <form method="get" className="mt-6 grid gap-3 rounded-[26px] bg-white p-6 sm:grid-cols-3">
        <label className="grid gap-1 text-xs font-medium">Tipo
          <select name="tipo" defaultValue={f.tipo ?? ""} className={selecao}><option value="">Todos</option>{Object.entries(TIPOS).map(([k, r]) => <option key={k} value={k}>{r}</option>)}</select>
        </label>
        <label className="grid gap-1 text-xs font-medium">Categoria
          <select name="categoria" defaultValue={f.categoria ?? ""} className={selecao}><option value="">Todas</option>{Object.entries(CATEGORIAS).map(([k, r]) => <option key={k} value={k}>{r}</option>)}</select>
        </label>
        <label className="grid gap-1 text-xs font-medium">Situação
          <select name="situacao" defaultValue={f.situacao ?? ""} className={selecao}><option value="">Todas</option>{Object.entries(SITUACOES_LANCAMENTO).map(([k, r]) => <option key={k} value={k}>{r}</option>)}</select>
        </label>
        <label className="grid gap-1 text-xs font-medium">Cliente
          <select name="cliente" defaultValue={f.cliente ?? ""} className={selecao}><option value="">Todos</option>{op.clientes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select>
        </label>
        <label className="grid gap-1 text-xs font-medium">Processo
          <select name="processo" defaultValue={f.processo ?? ""} className={selecao}><option value="">Todos</option>{op.processos.map((p) => <option key={p.id} value={p.id}>{p.numero_cnj}</option>)}</select>
        </label>
        <label className="grid gap-1 text-xs font-medium">Busca na descrição
          <input name="busca" defaultValue={f.busca ?? ""} maxLength={100} className={selecao} />
        </label>
        <label className="grid gap-1 text-xs font-medium">Competência de
          <input type="date" name="de" defaultValue={f.de ?? ""} className={selecao} />
        </label>
        <label className="grid gap-1 text-xs font-medium">Competência até
          <input type="date" name="ate" defaultValue={f.ate ?? ""} className={selecao} />
        </label>
        <div className="flex items-end gap-2">
          <button type="submit" className="h-10 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground">Filtrar</button>
          <Link href="/app/financeiro/lancamentos" className="inline-flex h-10 items-center rounded-full px-4 text-sm hover:bg-muted">Limpar</Link>
        </div>
      </form>
      {lista.error ? <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">Não foi possível carregar os lançamentos.</p> : null}
      <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
        <span>{dados.total} lançamento(s)</span>
        <Link href={`/app/financeiro/exportar${paraQuery({ ...f, pagina: undefined })}`} prefetch={false} className="font-medium text-foreground hover:underline">Exportar CSV (parcelas)</Link>
      </div>
      <TabelaLancamentos itens={dados.itens} />
      {paginas > 1 ? (
        <nav aria-label="Páginas" className="mt-4 flex items-center justify-between text-sm">
          {pagina > 1 ? <Link href={`/app/financeiro/lancamentos${paraQuery(f, { pagina: pagina - 1 })}`}>← Anterior</Link> : <span />}
          <span className="text-muted-foreground">Página {pagina} de {paginas}</span>
          {pagina < paginas ? <Link href={`/app/financeiro/lancamentos${paraQuery(f, { pagina: pagina + 1 })}`}>Próxima →</Link> : <span />}
        </nav>
      ) : null}
    </div>
  );
}
