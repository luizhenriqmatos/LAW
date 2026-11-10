import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { exigirModulo } from "@/lib/contexto";
import { formatarCentavos } from "@/lib/dinheiro";
import type { ModuloId } from "@/lib/modulos";
import { cn } from "@/lib/utils";
import { descartarProcesso, restaurarProcesso } from "../actions";
import { Aviso, botaoPequeno, diasParaExpirar, formatarCnj, formatarData, POLOS, Selo } from "../comum";
import { FormularioProcesso } from "../formularios";
import { SecaoArquivos } from "../../documentos/arquivos";
import { dispensarPrazo } from "../../prazos/actions";
import { SeloPrazo } from "../../prazos/comum";
import { situacaoDoPrazo } from "@/lib/prazos/alertas";
import { hojeBrasilia } from "@/lib/prazos/servidor";

type Processo = {
  id: string; escritorio_id: string; numero_cnj: string; titulo: string | null; tribunal: string | null; classe: string | null;
  orgao_julgador: string | null; assuntos: string[]; area: string | null; data_ajuizamento: string | null; segredo_justica: boolean;
  status: "provisorio" | "confirmado" | "descartado"; confirmado_em: string | null; descartado_em: string | null; criado_em: string;
};
type Parte = { id: string; nome: string; polo: string; cliente: { id: string; nome: string; status: string } | null };
type Publicacao = {
  id: string; data_disponibilizacao: string; data_publicacao: string | null; tribunal: string; orgao: string | null;
  tipo_comunicacao: string | null; tipo_documento: string | null; texto: string; link: string | null; fonte: string;
  sem_prazo_em: string | null;
};
type PrazoDoProcesso = {
  id: string; descricao: string; data_final: string; status: string; publicacao_id: string | null; dias: number; tipo_contagem: string;
  responsavel: { nome: string; email: string } | null;
};
type Movimento = { dataHora: string | null; codigo: string | null; nome: string; complementos?: string[] };
type Evento =
  | { tipo: "publicacao"; data: string; pub: Publicacao }
  | { tipo: "movimentacao"; data: string; mov: Movimento };

export default async function PaginaProcesso({ params, searchParams }: PageProps<"/app/processos/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, vinculo, modulos } = await exigirModulo("processos");

  const { data: proc } = await supabase
    .from("processo")
    .select("id, escritorio_id, numero_cnj, titulo, tribunal, classe, orgao_julgador, assuntos, area, data_ajuizamento, segredo_justica, status, confirmado_em, descartado_em, criado_em")
    .eq("id", id)
    .eq("escritorio_id", vinculo.escritorioId)
    .maybeSingle();
  if (!proc) notFound();
  const p = proc as Processo;

  const verPrazos = modulos.includes("prazos");
  const [partesR, pubsR, metaR, prazosR] = await Promise.all([
    supabase.from("processo_parte").select("id, nome, polo, cliente:cliente_id(id, nome, status)").eq("processo_id", id).order("polo").order("nome"),
    supabase
      .from("publicacao")
      .select("id, data_disponibilizacao, data_publicacao, tribunal, orgao, tipo_comunicacao, tipo_documento, texto, link, fonte, sem_prazo_em")
      .eq("processo_id", id)
      .in("status_triagem", ["vinculada", "aguardando"])
      .order("data_disponibilizacao", { ascending: false })
      .limit(200),
    supabase.from("processo_metadados").select("dados, erro, atualizado_em").eq("escritorio_id", p.escritorio_id).eq("numero_cnj", p.numero_cnj).maybeSingle(),
    verPrazos
      ? supabase.from("prazo").select("id, descricao, data_final, status, publicacao_id, dias, tipo_contagem, responsavel:responsavel_id(nome, email)").eq("processo_id", id).order("data_final")
      : Promise.resolve({ data: [] as unknown[] }),
  ]);
  const prazosDoProcesso = (prazosR.data ?? []) as unknown as PrazoDoProcesso[];
  const comPrazo = new Set(prazosDoProcesso.map((x) => x.publicacao_id).filter(Boolean));
  const hoje = hojeBrasilia();
  const partes = (partesR.data ?? []) as unknown as Parte[];
  const publicacoes = (pubsR.data ?? []) as Publicacao[];
  const meta = metaR.data as { dados: { movimentos?: Movimento[] } | null; erro: string | null; atualizado_em: string } | null;
  const movimentos = meta?.dados?.movimentos ?? [];

  // Linha do tempo: publicações + movimentações, mais recente primeiro.
  const eventos: Evento[] = [
    ...publicacoes.map((pub) => ({ tipo: "publicacao" as const, data: pub.data_disponibilizacao, pub })),
    ...movimentos.filter((m) => m.dataHora).map((mov) => ({ tipo: "movimentacao" as const, data: mov.dataHora!.slice(0, 10), mov })),
  ].sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : a.tipo === "publicacao" ? -1 : 1));

  const destino = `/app/processos/${p.id}`;
  const tem = (m: ModuloId) => modulos.includes(m);

  return (
    <div className="mx-auto max-w-5xl">
      <Link href={p.status === "confirmado" ? "/app/processos" : "/app/processos/triagem?aba=processos"} className="text-sm font-medium text-muted-foreground hover:underline">
        ‹ {p.status === "confirmado" ? "Processos" : "Triagem"}
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-3xl font-medium tracking-tight sm:text-4xl">{formatarCnj(p.numero_cnj)}</h1>
        <Selo tipo={p.status} />
        {p.segredo_justica ? <Selo tipo="segredo" /> : null}
      </div>
      {p.titulo ? <p className="mt-1 text-lg">{p.titulo}</p> : null}
      <Aviso codigo={sp.aviso} />

      {p.status === "provisorio" ? (
        <section className="mt-6 rounded-[26px] border-2 border-amber-300 bg-amber-50/60 p-6">
          <h2 className="text-lg font-semibold">Este processo é provisório</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Foi criado a partir de uma publicação. Confira os dados e confirme; se não for do escritório, descarte (dá para restaurar por 30 dias).
          </p>
          <div className="mt-4">
            <FormularioProcesso
              processoId={p.id}
              valores={{ titulo: p.titulo ?? "", area: p.area ?? "", classe: p.classe ?? "", orgao_julgador: p.orgao_julgador ?? "", segredo_justica: p.segredo_justica }}
            />
          </div>
          <form action={descartarProcesso.bind(null, p.id, "/app/processos/triagem?aba=processos")} className="mt-3">
            <button className={cn(botaoPequeno, "text-red-700 hover:bg-red-50")}>Não é do escritório — descartar</button>
          </form>
        </section>
      ) : null}

      {p.status === "descartado" ? (
        <section className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-[26px] bg-neutral-100 p-5 text-sm">
          <p>Processo descartado. Some de vez em {diasParaExpirar(p.descartado_em!)} dia(s).</p>
          <form action={restaurarProcesso.bind(null, p.id, destino)}>
            <button className={cn(botaoPequeno, "bg-white hover:bg-white/70")}>Restaurar</button>
          </form>
        </section>
      ) : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="grid content-start gap-4">
          <section className="rounded-[26px] bg-white p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Linha do tempo</h2>
            {meta?.erro ? (
              <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Não conseguimos buscar as movimentações no DataJud na última tentativa. As publicações abaixo estão completas.
              </p>
            ) : null}
            {eventos.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">Nenhuma publicação ou movimentação ainda.</p>
            ) : (
              <ol className="mt-4 grid gap-4 border-l-2 border-muted pl-5">
                {eventos.map((e, i) =>
                  e.tipo === "publicacao" ? (
                    <li key={`p-${e.pub.id}`} className="relative">
                      <span className="absolute -left-[27px] top-1.5 size-3 rounded-full bg-primary" aria-hidden />
                      <p className="text-sm">
                        <span className="font-semibold">{formatarData(e.data)}</span> · Publicação{e.pub.tipo_comunicacao ? ` (${e.pub.tipo_comunicacao})` : ""}
                        {e.pub.fonte === "exemplo" ? <span className="ml-2 rounded bg-muted px-1.5 text-xs">exemplo</span> : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {[e.pub.orgao, e.pub.tipo_documento, e.pub.data_publicacao ? `considerada publicada em ${formatarData(e.pub.data_publicacao)}` : null].filter(Boolean).join(" · ")}
                      </p>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-sm line-clamp-2">{e.pub.texto}</summary>
                        <p className="mt-2 whitespace-pre-line text-sm">{e.pub.texto}</p>
                        {e.pub.link ? (
                          <a href={e.pub.link} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs font-semibold underline">
                            Ver no Diário
                          </a>
                        ) : null}
                      </details>
                      {verPrazos && p.status === "confirmado" && !comPrazo.has(e.pub.id) && !e.pub.sem_prazo_em ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Link href={`/app/prazos/novo?publicacao=${e.pub.id}`} className={cn(botaoPequeno, "bg-primary text-primary-foreground")}>
                            Criar prazo
                          </Link>
                          <form action={dispensarPrazo.bind(null, e.pub.id, destino)}>
                            <button className={cn(botaoPequeno, "hover:bg-muted")}>Não gera prazo</button>
                          </form>
                        </div>
                      ) : null}
                    </li>
                  ) : (
                    <li key={`m-${i}`} className="relative">
                      <span className="absolute -left-[26px] top-1.5 size-2.5 rounded-full bg-muted-foreground/50" aria-hidden />
                      <p className="text-sm">
                        <span className="font-semibold">{formatarData(e.data)}</span> · {e.mov.nome}
                      </p>
                      {e.mov.complementos?.length ? <p className="text-xs text-muted-foreground">{e.mov.complementos.join("; ")}</p> : null}
                    </li>
                  ),
                )}
              </ol>
            )}
          </section>

          {verPrazos ? (
            <section className="rounded-[26px] bg-white p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Prazos</h2>
                {p.status === "confirmado" ? (
                  <Link href={`/app/prazos/novo?processo=${p.id}`} className={cn(botaoPequeno, "bg-muted hover:bg-muted/70")}>
                    Novo prazo
                  </Link>
                ) : null}
              </div>
              {p.status !== "confirmado" ? (
                <p className="mt-2 text-sm text-muted-foreground">Confirme o processo para criar prazos.</p>
              ) : prazosDoProcesso.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">Nenhum prazo ainda. Use “Criar prazo” numa publicação da linha do tempo.</p>
              ) : (
                <ul className="mt-3 grid gap-2 text-sm">
                  {prazosDoProcesso.map((x) => (
                    <li key={x.id} className="flex flex-wrap items-center gap-2">
                      <SeloPrazo situacao={situacaoDoPrazo(x.status, x.data_final, hoje)} hoje={x.status === "aberto" && x.data_final === hoje} />
                      <Link href={`/app/prazos?prazo=${x.id}`} className="font-semibold hover:underline">{formatarData(x.data_final)}</Link>
                      <span className="min-w-0 flex-1">{x.descricao}</span>
                      <span className="text-xs text-muted-foreground">{x.responsavel?.nome || x.responsavel?.email}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          <Secao titulo="Tarefas" visivel={tem("tarefas")}>
            As tarefas do processo chegam no Prompt 5.
          </Secao>
          {p.status === "confirmado" ? (
            <SecaoArquivos supabase={supabase} escritorioId={vinculo.escritorioId} tipo="processo" refId={p.id} destino={`/app/processos/${p.id}`} margem={false} />
          ) : null}
          {tem("financeiro") ? <Financeiro processoId={p.id} confirmado={p.status === "confirmado"} /> : null}
          {tem("calculos") && p.status === "confirmado" ? <Calculos processoId={p.id} /> : null}
          {tem("portal_cliente") && p.status === "confirmado" ? (
            <section className="rounded-[26px] bg-white p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Portal do cliente</h2>
              {p.segredo_justica ? (
                <p className="mt-2 text-sm font-medium text-red-800">Segredo de justiça: este processo nunca aparece no portal do cliente.</p>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  Por padrão o cliente não vê nada. <Link href={`/app/portal-cliente/processos/${p.id}`} className="font-semibold text-foreground underline">Escolher o que o cliente vê</Link>.
                </p>
              )}
            </section>
          ) : null}
        </div>

        <aside className="grid content-start gap-4">
          <section className="rounded-[26px] bg-white p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Dados</h2>
            <dl className="mt-3 grid gap-2 text-sm">
              <Dado rotulo="Tribunal" valor={p.tribunal} />
              <Dado rotulo="Classe" valor={p.classe} />
              <Dado rotulo="Vara / órgão" valor={p.orgao_julgador} />
              <Dado rotulo="Área" valor={p.area} />
              <Dado rotulo="Assuntos" valor={p.assuntos.join("; ") || null} />
              <Dado rotulo="Ajuizado em" valor={p.data_ajuizamento ? formatarData(p.data_ajuizamento) : null} />
              <Dado rotulo={p.status === "confirmado" ? "Confirmado em" : "Criado em"} valor={formatarData(p.confirmado_em ?? p.criado_em)} />
            </dl>
          </section>
          <section className="rounded-[26px] bg-white p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Partes</h2>
            {partes.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">A publicação não trouxe as partes.</p>
            ) : (
              <ul className="mt-3 grid gap-2 text-sm">
                {partes.map((pt) => (
                  <li key={pt.id}>
                    <p className="font-medium">{pt.nome}</p>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {POLOS[pt.polo] ?? pt.polo}
                      {pt.cliente && pt.cliente.status !== "descartado" ? (
                        <>
                          {" · "}
                          <Link href={`/app/processos/clientes/${pt.cliente.id}`} className="font-semibold underline">
                            cliente
                          </Link>
                          {pt.cliente.status === "provisorio" ? <Selo tipo="provisorio" /> : null}
                        </>
                      ) : null}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Dado({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2">
      <dt className="text-muted-foreground">{rotulo}</dt>
      <dd>{valor || "—"}</dd>
    </div>
  );
}

function Secao({ titulo, visivel, children }: { titulo: string; visivel: boolean; children: React.ReactNode }) {
  if (!visivel) return null;
  return (
    <section className="rounded-[26px] bg-white p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{titulo}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
    </section>
  );
}

async function Financeiro({ processoId, confirmado }: { processoId: string; confirmado: boolean }) {
  if (!confirmado) {
    return (
      <Secao titulo="Financeiro" visivel>
        Processo provisório não entra no financeiro. Confirme-o primeiro.
      </Secao>
    );
  }
  const { supabase, vinculo } = await exigirModulo("financeiro");
  const { data } = await supabase.rpc("financeiro_saldos", { p_escritorio: vinculo.escritorioId, p_por: "processo", p_hoje: hojeBrasilia() });
  const saldo = ((data ?? []) as { id: string | null; em_aberto: number; atrasado: number; recebido: number }[]).find((s) => s.id === processoId);
  return (
    <section className="rounded-[26px] bg-white p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Financeiro</h2>
      {!saldo ? (
        <p className="mt-2 text-sm text-muted-foreground">Nenhum lançamento ligado a este processo.</p>
      ) : (
        <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
          <div><dt className="text-muted-foreground">Em aberto</dt><dd className="font-semibold">{formatarCentavos(Number(saldo.em_aberto))}</dd></div>
          <div><dt className="text-muted-foreground">Atrasado</dt><dd className={Number(saldo.atrasado) > 0 ? "font-semibold text-red-700" : "font-semibold"}>{formatarCentavos(Number(saldo.atrasado))}</dd></div>
          <div><dt className="text-muted-foreground">Recebido</dt><dd className="font-semibold">{formatarCentavos(Number(saldo.recebido))}</dd></div>
        </dl>
      )}
      <p className="mt-3 text-sm"><Link href={`/app/financeiro/processos/${processoId}`} className="font-medium hover:underline">Ver extrato</Link>{" · "}<Link href="/app/financeiro/novo" className="font-medium hover:underline">Novo lançamento</Link></p>
    </section>
  );
}

async function Calculos({ processoId }: { processoId: string }) {
  const { supabase } = await exigirModulo("calculos");
  const { data } = await supabase.from("calculo").select("id, titulo, total_centavos").eq("processo_id", processoId).order("atualizado_em", { ascending: false }).limit(20);
  const calculos = (data ?? []) as { id: string; titulo: string; total_centavos: number }[];
  return (
    <section className="rounded-[26px] bg-white p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Cálculos</h2>
      {calculos.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Nenhum cálculo ligado a este processo.</p> : (
        <ul className="mt-3 grid gap-1 text-sm">
          {calculos.map((c) => (
            <li key={c.id} className="flex justify-between gap-3">
              <Link href={`/app/calculos/${c.id}`} className="min-w-0 truncate hover:underline">{c.titulo}</Link>
              <span className="font-semibold tabular-nums">{formatarCentavos(Number(c.total_centavos))}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-sm"><Link href={`/app/calculos/novo?tipo=atualizacao&processo=${processoId}`} className="font-medium hover:underline">Novo cálculo para este processo</Link></p>
    </section>
  );
}
