import Link from "next/link";
import { exigirModulo } from "@/lib/contexto";
import { sugerirMesclagem } from "@/lib/triagem/similaridade";
import { formatarDocumento } from "@/lib/validacao";
import { cn } from "@/lib/utils";
import {
  confirmarClientesEmLote,
  confirmarProcessosEmLote,
  descartarCliente,
  descartarProcesso,
  descartarPublicacao,
  mesclarCliente,
  restaurarCliente,
  restaurarProcesso,
  restaurarPublicacao,
  vincularPublicacao,
} from "../actions";
import { Aviso, botaoPequeno, diasParaExpirar, formatarCnj, formatarData, inicioLixeira, POLOS, Selo } from "../comum";

type Aba = "processos" | "clientes" | "publicacoes";
const ABAS: { id: Aba; rotulo: string }[] = [
  { id: "processos", rotulo: "Processos novos" },
  { id: "clientes", rotulo: "Clientes novos" },
  { id: "publicacoes", rotulo: "Publicações sem processo" },
];

type ProcessoFila = {
  id: string; numero_cnj: string; tribunal: string | null; classe: string | null; orgao_julgador: string | null;
  segredo_justica: boolean; criado_em: string; descartado_em: string | null;
  processo_parte: { nome: string; polo: string }[]; publicacao: { count: number }[];
};
type ClienteFila = {
  id: string; nome: string; documento: string | null; criado_em: string; descartado_em: string | null;
  processo_parte: { polo: string; processo: { id: string; numero_cnj: string; status: string } | null }[];
};
type PublicacaoFila = {
  id: string; data_disponibilizacao: string; tribunal: string; orgao: string | null; tipo_comunicacao: string | null;
  tipo_documento: string | null; texto: string; link: string | null; descartada_em: string | null;
};
type Achado = { id: string; numero_cnj: string; status: string; tribunal: string | null; classe: string | null; titulo: string | null; partes: string | null };

const LIMITE = 100;
const um = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function Triagem({ searchParams }: PageProps<"/app/processos/triagem">) {
  const sp = await searchParams;
  const aba: Aba = (ABAS.find((a) => a.id === um(sp.aba))?.id ?? "processos") as Aba;
  const { supabase, vinculo } = await exigirModulo("processos");
  const esc = vinculo.escritorioId;
  const ha30dias = inicioLixeira();

  // Contador de cada aba.
  const [cProc, cCli, cPub] = await Promise.all([
    supabase.from("processo").select("id", { count: "exact", head: true }).eq("escritorio_id", esc).eq("status", "provisorio"),
    supabase.from("cliente").select("id", { count: "exact", head: true }).eq("escritorio_id", esc).eq("status", "provisorio"),
    supabase.from("publicacao").select("id", { count: "exact", head: true }).eq("escritorio_id", esc).eq("status_triagem", "sem_processo"),
  ]);
  const contadores: Record<Aba, number> = { processos: cProc.count ?? 0, clientes: cCli.count ?? 0, publicacoes: cPub.count ?? 0 };
  const falhou = cProc.error || cCli.error || cPub.error;

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/app/processos" className="text-sm font-medium text-muted-foreground hover:underline">
        ‹ Processos
      </Link>
      <h1 className="mt-2 text-5xl font-medium tracking-tight">Triagem</h1>
      <p className="mt-2 text-muted-foreground">
        O que a leitura do Diário trouxe e ainda precisa da sua revisão. Itens provisórios não entram em relatórios, financeiro nem portal do cliente.
      </p>
      <Aviso codigo={sp.aviso} />
      {falhou ? <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Não foi possível carregar a triagem. Tente de novo.</p> : null}

      <nav aria-label="Abas da triagem" className="mt-6 flex flex-wrap gap-2">
        {ABAS.map((a) => (
          <Link
            key={a.id}
            href={`?aba=${a.id}`}
            aria-current={a.id === aba ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold",
              a.id === aba ? "bg-primary text-primary-foreground" : "bg-white hover:bg-white/70",
            )}
          >
            {a.rotulo}
            <span className={cn("rounded-full px-2 py-0.5 text-xs", a.id === aba ? "bg-white/20" : "bg-muted")}>{contadores[a.id]}</span>
          </Link>
        ))}
      </nav>

      {aba === "processos" ? <AbaProcessos esc={esc} desde={ha30dias} /> : null}
      {aba === "clientes" ? <AbaClientes esc={esc} desde={ha30dias} /> : null}
      {aba === "publicacoes" ? <AbaPublicacoes esc={esc} desde={ha30dias} pub={um(sp.pub)} termo={um(sp.q)} /> : null}
    </div>
  );
}

function Vazio({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 rounded-[26px] bg-white p-6 text-muted-foreground">{children}</p>;
}

function Lixeira({ titulo, children, quantos }: { titulo: string; children: React.ReactNode; quantos: number }) {
  if (!quantos) return null;
  return (
    <details className="mt-8 rounded-[26px] bg-white/60 p-5">
      <summary className="cursor-pointer text-sm font-semibold">
        {titulo} ({quantos}) — recuperáveis por 30 dias
      </summary>
      <ul className="mt-3 grid gap-2">{children}</ul>
    </details>
  );
}

// ------------------------------------------------------------------ Processos novos

async function AbaProcessos({ esc, desde }: { esc: string; desde: string }) {
  const { supabase } = await exigirModulo("processos");
  const campos = "id, numero_cnj, tribunal, classe, orgao_julgador, segredo_justica, criado_em, descartado_em, processo_parte(nome, polo), publicacao(count)";
  const [fila, lixo] = await Promise.all([
    supabase.from("processo").select(campos).eq("escritorio_id", esc).eq("status", "provisorio").order("criado_em", { ascending: false }).limit(LIMITE),
    supabase.from("processo").select(campos).eq("escritorio_id", esc).eq("status", "descartado").gte("descartado_em", desde).order("descartado_em", { ascending: false }).limit(LIMITE),
  ]);
  const processos = (fila.data ?? []) as unknown as ProcessoFila[];
  const descartados = (lixo.data ?? []) as unknown as ProcessoFila[];
  const destino = "/app/processos/triagem?aba=processos";

  return (
    <section className="mt-6">
      {processos.length === 0 ? (
        <Vazio>Nenhum processo novo esperando revisão.</Vazio>
      ) : (
        <form action={confirmarProcessosEmLote}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">Marque os que são do escritório e confirme de uma vez, ou abra para revisar.</p>
            <button className="h-10 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground">Confirmar selecionados</button>
          </div>
          <ul className="grid gap-2">
            {processos.map((p) => (
              <li key={p.id} className="flex flex-wrap items-start gap-3 rounded-2xl bg-white px-4 py-3">
                <input type="checkbox" name="ids" value={p.id} aria-label={`Selecionar ${formatarCnj(p.numero_cnj)}`} className="mt-1.5 size-4 accent-black" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/app/processos/${p.id}`} className="font-mono text-sm font-semibold hover:underline">
                      {formatarCnj(p.numero_cnj)}
                    </Link>
                    <Selo tipo="provisorio" />
                    {p.segredo_justica ? <Selo tipo="segredo" /> : null}
                  </div>
                  <p className="mt-1 text-sm">{[p.tribunal, p.classe, p.orgao_julgador].filter(Boolean).join(" · ") || "Sem dados do processo ainda"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {p.processo_parte.length ? p.processo_parte.map((pp) => `${pp.nome} (${POLOS[pp.polo] ?? pp.polo})`).join("; ") : "Partes não informadas na publicação"}
                    {" · "}
                    {p.publicacao[0]?.count ?? 0} publicação(ões)
                  </p>
                </div>
                <div className="flex gap-2">
                  <Link href={`/app/processos/${p.id}`} className={cn(botaoPequeno, "bg-muted hover:bg-muted/70")}>
                    Revisar
                  </Link>
                  <button formAction={descartarProcesso.bind(null, p.id, destino)} className={cn(botaoPequeno, "text-red-700 hover:bg-red-50")}>
                    Descartar
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {processos.length === LIMITE ? <p className="mt-3 text-xs text-muted-foreground">Mostrando os {LIMITE} mais recentes.</p> : null}
        </form>
      )}

      <Lixeira titulo="Processos descartados" quantos={descartados.length}>
        {descartados.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-white px-4 py-2 text-sm">
            <span className="font-mono">{formatarCnj(p.numero_cnj)}</span>
            <span className="text-xs text-muted-foreground">some em {diasParaExpirar(p.descartado_em!)} dia(s)</span>
            <form action={restaurarProcesso.bind(null, p.id, destino)}>
              <button className={cn(botaoPequeno, "bg-muted hover:bg-muted/70")}>Restaurar</button>
            </form>
          </li>
        ))}
      </Lixeira>
    </section>
  );
}

// ------------------------------------------------------------------ Clientes novos

async function AbaClientes({ esc, desde }: { esc: string; desde: string }) {
  const { supabase } = await exigirModulo("processos");
  const campos = "id, nome, documento, criado_em, descartado_em, processo_parte(polo, processo:processo_id(id, numero_cnj, status))";
  const [fila, lixo, base] = await Promise.all([
    supabase.from("cliente").select(campos).eq("escritorio_id", esc).eq("status", "provisorio").order("criado_em", { ascending: false }).limit(LIMITE),
    supabase.from("cliente").select(campos).eq("escritorio_id", esc).eq("status", "descartado").gte("descartado_em", desde).order("descartado_em", { ascending: false }).limit(LIMITE),
    // PENDENCIA P-021: comparação feita no servidor do app; com muitos milhares de clientes, mover para o banco.
    supabase.from("cliente").select("id, nome, documento").eq("escritorio_id", esc).eq("status", "confirmado").limit(5000),
  ]);
  const clientes = (fila.data ?? []) as unknown as ClienteFila[];
  const descartados = (lixo.data ?? []) as unknown as ClienteFila[];
  const confirmados = (base.data ?? []) as { id: string; nome: string; documento: string | null }[];
  const destino = "/app/processos/triagem?aba=clientes";

  return (
    <section className="mt-6">
      {clientes.length === 0 ? (
        <Vazio>Nenhum cliente novo esperando revisão.</Vazio>
      ) : (
        <form action={confirmarClientesEmLote}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              As partes das publicações viram clientes provisórios. Descarte quem não é cliente (ex.: a parte contrária).
            </p>
            <button className="h-10 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground">Confirmar selecionados</button>
          </div>
          <ul className="grid gap-2">
            {clientes.map((c) => {
              const sugestoes = sugerirMesclagem(c, confirmados);
              return (
                <li key={c.id} className="rounded-2xl bg-white px-4 py-3">
                  <div className="flex flex-wrap items-start gap-3">
                    <input type="checkbox" name="ids" value={c.id} aria-label={`Selecionar ${c.nome}`} className="mt-1.5 size-4 accent-black" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/app/processos/clientes/${c.id}`} className="font-semibold hover:underline">
                          {c.nome}
                        </Link>
                        <Selo tipo="provisorio" />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {c.processo_parte
                          .filter((pp) => pp.processo)
                          .map((pp) => `${POLOS[pp.polo] ?? pp.polo} em ${formatarCnj(pp.processo!.numero_cnj)}`)
                          .join("; ") || "Sem processo ligado"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Link href={`/app/processos/clientes/${c.id}`} className={cn(botaoPequeno, "bg-muted hover:bg-muted/70")}>
                        Editar e confirmar
                      </Link>
                      <button formAction={descartarCliente.bind(null, c.id, destino)} className={cn(botaoPequeno, "text-red-700 hover:bg-red-50")}>
                        Descartar
                      </button>
                    </div>
                  </div>
                  {sugestoes.length ? (
                    <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-950">
                      <p className="font-medium">Pode ser alguém que já é cliente:</p>
                      <ul className="mt-1 grid gap-1">
                        {sugestoes.map((s) => (
                          <li key={s.cliente.id} className="flex flex-wrap items-center gap-2">
                            <span>
                              {s.cliente.nome}
                              {s.cliente.documento ? ` · ${formatarDocumento(s.cliente.documento)}` : ""}
                              {s.motivo === "documento" ? " (mesmo CPF/CNPJ)" : " (nome parecido)"}
                            </span>
                            <button formAction={mesclarCliente.bind(null, c.id, s.cliente.id, destino)} className={cn(botaoPequeno, "bg-white hover:bg-white/70")}>
                              Mesclar com este
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </form>
      )}

      <Lixeira titulo="Clientes descartados" quantos={descartados.length}>
        {descartados.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-white px-4 py-2 text-sm">
            <span>{c.nome}</span>
            <span className="text-xs text-muted-foreground">some em {diasParaExpirar(c.descartado_em!)} dia(s)</span>
            <form action={restaurarCliente.bind(null, c.id, destino)}>
              <button className={cn(botaoPequeno, "bg-muted hover:bg-muted/70")}>Restaurar</button>
            </form>
          </li>
        ))}
      </Lixeira>
    </section>
  );
}

// ------------------------------------------------------------------ Publicações sem processo

async function AbaPublicacoes({ esc, desde, pub, termo }: { esc: string; desde: string; pub?: string; termo?: string }) {
  const { supabase } = await exigirModulo("processos");
  const campos = "id, data_disponibilizacao, tribunal, orgao, tipo_comunicacao, tipo_documento, texto, link, descartada_em";
  const [fila, lixo] = await Promise.all([
    supabase.from("publicacao").select(campos).eq("escritorio_id", esc).eq("status_triagem", "sem_processo").order("data_disponibilizacao", { ascending: false }).limit(LIMITE),
    supabase.from("publicacao").select(campos).eq("escritorio_id", esc).eq("status_triagem", "descartada").is("processo_id", null).gte("descartada_em", desde).order("descartada_em", { ascending: false }).limit(LIMITE),
  ]);
  const publicacoes = (fila.data ?? []) as PublicacaoFila[];
  const descartadas = (lixo.data ?? []) as PublicacaoFila[];

  const termoLimpo = (termo ?? "").trim().slice(0, 100);
  let achados: Achado[] = [];
  let buscou = false;
  if (pub && termoLimpo.length >= 3) {
    buscou = true;
    const { data } = await supabase.rpc("buscar_processos", { p_escritorio: esc, p_termo: termoLimpo });
    achados = (data ?? []) as Achado[];
  }

  return (
    <section className="mt-6">
      {publicacoes.length === 0 ? (
        <Vazio>Nenhuma publicação sem processo. Tudo o que chegou tinha número de processo.</Vazio>
      ) : (
        <ul className="grid gap-3">
          {publicacoes.map((p) => (
            <li key={p.id} className="rounded-2xl bg-white px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold">{formatarData(p.data_disponibilizacao)}</span>
                <span>{p.tribunal}</span>
                <span className="text-muted-foreground">{[p.orgao, p.tipo_comunicacao, p.tipo_documento].filter(Boolean).join(" · ")}</span>
              </div>
              <p className="mt-2 line-clamp-4 text-sm whitespace-pre-line">{p.texto}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Link href={`?aba=publicacoes&pub=${p.id}`} className={cn(botaoPequeno, "bg-primary text-primary-foreground")}>
                  Ligar a um processo
                </Link>
                <form action={descartarPublicacao.bind(null, p.id)}>
                  <button className={cn(botaoPequeno, "text-red-700 hover:bg-red-50")}>Descartar</button>
                </form>
                {p.link ? (
                  <a href={p.link} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold underline">
                    Ver no Diário
                  </a>
                ) : null}
              </div>

              {pub === p.id ? (
                <div className="mt-3 rounded-xl bg-muted p-3">
                  <form className="flex flex-wrap gap-2" role="search">
                    <input type="hidden" name="aba" value="publicacoes" />
                    <input type="hidden" name="pub" value={p.id} />
                    <label htmlFor={`busca-${p.id}`} className="sr-only">
                      Buscar processo
                    </label>
                    <input
                      id={`busca-${p.id}`}
                      name="q"
                      defaultValue={termoLimpo}
                      minLength={3}
                      maxLength={100}
                      required
                      autoFocus
                      placeholder="Nº do processo, nome da parte ou do cliente"
                      className="h-10 min-w-0 flex-1 rounded-xl border bg-white px-3 text-sm"
                    />
                    <button className="h-10 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground">Buscar</button>
                  </form>
                  {buscou ? (
                    achados.length ? (
                      <ul className="mt-3 grid gap-2">
                        {achados.map((a) => (
                          <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm">
                            <span className="font-mono font-semibold">{formatarCnj(a.numero_cnj)}</span>
                            {a.status === "provisorio" ? <Selo tipo="provisorio" /> : null}
                            <span className="min-w-0 flex-1 truncate text-muted-foreground">{[a.titulo, a.partes].filter(Boolean).join(" · ")}</span>
                            <form action={vincularPublicacao.bind(null, p.id, a.id)}>
                              <button className={cn(botaoPequeno, "bg-primary text-primary-foreground")}>Ligar</button>
                            </form>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-3 text-sm text-muted-foreground">Nenhum processo encontrado com “{termoLimpo}”.</p>
                    )
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Lixeira titulo="Publicações descartadas" quantos={descartadas.length}>
        {descartadas.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-white px-4 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {formatarData(p.data_disponibilizacao)} · {p.tribunal} · {p.texto.slice(0, 80)}
            </span>
            <span className="text-xs text-muted-foreground">some em {diasParaExpirar(p.descartada_em!)} dia(s)</span>
            <form action={restaurarPublicacao.bind(null, p.id)}>
              <button className={cn(botaoPequeno, "bg-muted hover:bg-muted/70")}>Restaurar</button>
            </form>
          </li>
        ))}
      </Lixeira>
    </section>
  );
}
