import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { exigirModulo } from "@/lib/contexto";
import { sugerirMesclagem } from "@/lib/triagem/similaridade";
import { formatarDocumento } from "@/lib/validacao";
import { cn } from "@/lib/utils";
import { SecaoArquivos } from "../../../documentos/arquivos";
import { descartarCliente, mesclarCliente, renomearCliente, restaurarCliente } from "../../actions";
import { Aviso, botaoPequeno, diasParaExpirar, formatarCnj, POLOS, Selo } from "../../comum";
import { FormularioCliente } from "../../formularios";

type Cliente = {
  id: string; nome: string; documento: string | null; email: string | null; telefone: string | null;
  status: "provisorio" | "confirmado" | "mesclado" | "descartado"; descartado_em: string | null; mesclado_em: string | null;
  processo_parte: { polo: string; processo: { id: string; numero_cnj: string; status: string; titulo: string | null } | null }[];
};

export default async function PaginaCliente({ params, searchParams }: PageProps<"/app/processos/clientes/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, vinculo } = await exigirModulo("processos");

  const { data } = await supabase
    .from("cliente")
    .select("id, nome, documento, email, telefone, status, descartado_em, mesclado_em, processo_parte(polo, processo:processo_id(id, numero_cnj, status, titulo))")
    .eq("id", id)
    .eq("escritorio_id", vinculo.escritorioId)
    .maybeSingle();
  if (!data) notFound();
  const c = data as unknown as Cliente;

  let sugestoes: ReturnType<typeof sugerirMesclagem<{ id: string; nome: string; documento: string | null }>> = [];
  if (c.status === "provisorio") {
    const { data: base } = await supabase.from("cliente").select("id, nome, documento").eq("escritorio_id", vinculo.escritorioId).eq("status", "confirmado").limit(5000);
    sugestoes = sugerirMesclagem(c, (base ?? []) as { id: string; nome: string; documento: string | null }[]);
  }
  const destino = `/app/processos/clientes/${c.id}`;
  const processos = c.processo_parte.filter((pp) => pp.processo && pp.processo.status !== "descartado");

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/app/processos/triagem?aba=clientes" className="text-sm font-medium text-muted-foreground hover:underline">
        ‹ Triagem
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-4xl font-medium tracking-tight">{c.nome}</h1>
        <Selo tipo={c.status} />
      </div>
      <Aviso codigo={sp.aviso} />

      {sugestoes.length ? (
        <section className="mt-6 rounded-[26px] border-2 border-amber-300 bg-amber-50 p-5">
          <h2 className="font-semibold">Pode ser alguém que já é cliente</h2>
          <p className="mt-1 text-sm text-muted-foreground">Mesclar junta os dois: os processos passam para o cliente já cadastrado.</p>
          <ul className="mt-3 grid gap-2">
            {sugestoes.map((s) => (
              <li key={s.cliente.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{s.cliente.nome}</span>
                  {s.cliente.documento ? ` · ${formatarDocumento(s.cliente.documento)}` : ""}
                  <span className="text-muted-foreground">{s.motivo === "documento" ? " — mesmo CPF/CNPJ" : " — nome parecido"}</span>
                </span>
                <form action={mesclarCliente.bind(null, c.id, s.cliente.id, "/app/processos/triagem?aba=clientes")}>
                  <button className={cn(botaoPequeno, "bg-primary text-primary-foreground")}>Mesclar com este</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {c.status === "provisorio" ? (
        <section className="mt-6 rounded-[26px] bg-white p-6">
          <h2 className="text-lg font-semibold">Editar e confirmar</h2>
          <p className="mt-1 text-sm text-muted-foreground">O nome veio da publicação. Complete o que souber; o resto pode ficar para depois.</p>
          <div className="mt-4">
            <FormularioCliente
              clienteId={c.id}
              valores={{ nome: c.nome, documento: c.documento ? formatarDocumento(c.documento) : "", email: c.email ?? "", telefone: c.telefone ?? "" }}
            />
          </div>
          <form action={descartarCliente.bind(null, c.id, "/app/processos/triagem?aba=clientes")} className="mt-3">
            <button className={cn(botaoPequeno, "text-red-700 hover:bg-red-50")}>Não é cliente — descartar</button>
          </form>
        </section>
      ) : (
        <section className="mt-6 rounded-[26px] bg-white p-6 text-sm">
          <dl className="grid gap-2">
            <div className="grid grid-cols-[110px_1fr]"><dt className="text-muted-foreground">CPF/CNPJ</dt><dd>{c.documento ? formatarDocumento(c.documento) : "—"}</dd></div>
            <div className="grid grid-cols-[110px_1fr]"><dt className="text-muted-foreground">E-mail</dt><dd>{c.email ?? "—"}</dd></div>
            <div className="grid grid-cols-[110px_1fr]"><dt className="text-muted-foreground">Telefone</dt><dd>{c.telefone ?? "—"}</dd></div>
          </dl>
          {c.status === "confirmado" ? (
            <form action={renomearCliente.bind(null, c.id, destino)} className="mt-4 flex flex-wrap items-center gap-2">
              <label htmlFor="nome-cliente" className="text-muted-foreground">Nome</label>
              <input id="nome-cliente" name="nome" defaultValue={c.nome} required minLength={2} maxLength={200} className="h-9 min-w-0 flex-1 rounded-full border border-border bg-white px-4 text-sm" />
              <button className={cn(botaoPequeno, "h-9 bg-muted hover:bg-muted/70")}>Renomear</button>
            </form>
          ) : null}
          {c.status === "mesclado" && c.mesclado_em ? (
            <p className="mt-3">
              Este cadastro foi juntado a{" "}
              <Link href={`/app/processos/clientes/${c.mesclado_em}`} className="font-semibold underline">
                outro cliente
              </Link>
              .
            </p>
          ) : null}
          {c.status === "descartado" && c.descartado_em ? (
            <form action={restaurarCliente.bind(null, c.id, destino)} className="mt-3 flex flex-wrap items-center gap-3">
              <span>Descartado. Some de vez em {diasParaExpirar(c.descartado_em)} dia(s).</span>
              <button className={cn(botaoPequeno, "bg-muted hover:bg-muted/70")}>Restaurar</button>
            </form>
          ) : null}
        </section>
      )}

      {c.status === "confirmado" ? <SecaoArquivos supabase={supabase} escritorioId={vinculo.escritorioId} tipo="cliente" refId={c.id} destino={destino} /> : null}

      <section className="mt-6 rounded-[26px] bg-white p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Processos</h2>
        {processos.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nenhum processo ligado.</p>
        ) : (
          <ul className="mt-3 grid gap-2 text-sm">
            {processos.map((pp) => (
              <li key={pp.processo!.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/app/processos/${pp.processo!.id}`} className="font-mono font-semibold hover:underline">
                  {formatarCnj(pp.processo!.numero_cnj)}
                </Link>
                <span className="text-muted-foreground">{POLOS[pp.polo] ?? pp.polo}</span>
                {pp.processo!.status === "provisorio" ? <Selo tipo="provisorio" /> : null}
                {pp.processo!.titulo ? <span>{pp.processo!.titulo}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
