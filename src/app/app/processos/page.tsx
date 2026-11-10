import Link from "next/link";
import { exigirModulo } from "@/lib/contexto";
import { Aviso, formatarCnj, formatarData, Selo } from "./comum";

type Linha = {
  id: string; numero_cnj: string; titulo: string | null; tribunal: string | null; classe: string | null;
  segredo_justica: boolean; confirmado_em: string | null; processo_parte?: { nome: string }[]; partes?: string | null;
};

export default async function Processos({ searchParams }: PageProps<"/app/processos">) {
  const sp = await searchParams;
  const termo = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 100);
  const { supabase, vinculo } = await exigirModulo("processos");
  const esc = vinculo.escritorioId;

  const [proc, cli, pub] = await Promise.all([
    supabase.from("processo").select("id", { count: "exact", head: true }).eq("escritorio_id", esc).eq("status", "provisorio"),
    supabase.from("cliente").select("id", { count: "exact", head: true }).eq("escritorio_id", esc).eq("status", "provisorio"),
    supabase.from("publicacao").select("id", { count: "exact", head: true }).eq("escritorio_id", esc).eq("status_triagem", "sem_processo"),
  ]);
  const naTriagem = (proc.count ?? 0) + (cli.count ?? 0) + (pub.count ?? 0);

  // Só confirmados aqui: provisório fica na triagem.
  let linhas: Linha[] = [];
  let erro = false;
  if (termo.length >= 3) {
    const { data, error } = await supabase.rpc("buscar_processos", { p_escritorio: esc, p_termo: termo });
    erro = !!error;
    linhas = ((data ?? []) as (Linha & { status: string })[]).filter((l) => l.status === "confirmado");
  } else {
    const { data, error } = await supabase
      .from("processo_confirmado")
      .select("id, numero_cnj, titulo, tribunal, classe, segredo_justica, confirmado_em")
      .eq("escritorio_id", esc)
      .order("confirmado_em", { ascending: false })
      .limit(100);
    erro = !!error;
    linhas = (data ?? []) as Linha[];
  }

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-5xl font-medium tracking-tight">Processos</h1>
      <Aviso codigo={sp.aviso} />

      <Link
        href="/app/processos/triagem"
        className="mt-6 flex items-center justify-between rounded-[26px] bg-accent px-5 py-4 font-medium"
      >
        <span>
          Triagem {naTriagem ? `— ${naTriagem} item(ns) esperando revisão` : "— nada pendente"}
        </span>
        <span aria-hidden>›</span>
      </Link>

      <form className="mt-6 flex gap-2" role="search">
        <label htmlFor="q" className="sr-only">
          Buscar processo
        </label>
        <input
          id="q"
          name="q"
          defaultValue={termo}
          maxLength={100}
          placeholder="Buscar por nº, parte, cliente ou apelido"
          className="h-10 min-w-0 flex-1 rounded-xl border bg-white px-3 text-sm"
        />
        <button className="h-10 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground">Buscar</button>
      </form>

      {erro ? <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Não foi possível carregar os processos.</p> : null}
      {linhas.length === 0 ? (
        <p className="mt-4 rounded-[26px] bg-white p-6 text-muted-foreground">
          {termo ? `Nenhum processo confirmado encontrado com “${termo}”.` : "Nenhum processo confirmado ainda. Os que a leitura do Diário encontrar aparecem na triagem."}
        </p>
      ) : (
        <ul className="mt-4 grid gap-2">
          {linhas.map((l) => (
            <li key={l.id}>
              <Link href={`/app/processos/${l.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-white px-4 py-3 hover:shadow-sm">
                <span className="font-mono text-sm font-semibold">{formatarCnj(l.numero_cnj)}</span>
                {l.segredo_justica ? <Selo tipo="segredo" /> : null}
                <span className="min-w-0 flex-1 truncate">{l.titulo ?? l.partes ?? ""}</span>
                <span className="text-xs text-muted-foreground">{[l.tribunal, l.classe].filter(Boolean).join(" · ")}</span>
                {l.confirmado_em ? <span className="text-xs text-muted-foreground">desde {formatarData(l.confirmado_em)}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
