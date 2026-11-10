import Link from "next/link";
import { exigirModulo } from "@/lib/contexto";
import { dataHoraBR } from "@/lib/portal/linguagem";
import { formatarCnj } from "../processos/comum";
import { configurarModo } from "./actions";
import { AvisoPortal } from "./avisos";

type Visao = {
  modo: "revisar" | "direto";
  e_dono: boolean;
  liberacoes: { id: string; processo_id: string; numero_cnj: string; cliente_nome: string; ver_movimentacoes: boolean; ver_resumo: boolean; ver_compromissos: boolean; ver_documentos: boolean; liberado_em: string }[];
  rascunhos: { id: string; processo_id: string; numero_cnj: string; criado_em: string; alertas: number }[];
  acessos: { criado_em: string; tipo: string; ip: string | null; cliente_nome: string; numero_cnj: string | null }[];
};

const TIPO_ACESSO: Record<string, string> = {
  link_gerado: "Link de acesso gerado",
  entrou: "Entrou no portal",
  processo: "Abriu o processo",
  documento: "Baixou um documento",
};

function oQueVe(l: Visao["liberacoes"][number]) {
  const itens = [l.ver_movimentacoes && "movimentações", l.ver_resumo && "resumo", l.ver_compromissos && "compromissos", l.ver_documentos && "documentos"].filter(Boolean);
  return itens.length ? itens.join(", ") : "só a situação";
}

export default async function PaginaPortalCliente({ searchParams }: PageProps<"/app/portal-cliente">) {
  const sp = await searchParams;
  const { supabase, vinculo } = await exigirModulo("portal_cliente");
  const { data, error } = await supabase.rpc("portal_visao_geral", { p_escritorio: vinculo.escritorioId });
  if (error) throw new Error("Não foi possível carregar o portal do cliente.");
  const v = data as Visao;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-5xl font-medium tracking-tight">Portal do cliente</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        O cliente acompanha os processos que você liberar, sem senha: entra por um link enviado ao e-mail dele. Para liberar, abra o processo em
        {" "}<Link href="/app/processos" className="font-semibold underline">Processos</Link> e use “Portal do cliente”. Por padrão, nada fica visível.
      </p>
      <p className="mt-2 max-w-2xl text-sm font-medium">Processo em segredo de justiça nunca aparece no portal, mesmo que alguém tente liberar.</p>
      <AvisoPortal codigo={sp.aviso} />

      {v.rascunhos.length > 0 ? (
        <section className="mt-6 rounded-[26px] bg-amber-50 p-6 ring-1 ring-amber-200">
          <h2 className="text-lg font-medium">Resumos esperando a sua revisão ({v.rascunhos.length})</h2>
          <ul className="mt-3 grid gap-2 text-sm">
            {v.rascunhos.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>{formatarCnj(r.numero_cnj)}{r.alertas > 0 ? ` · ${r.alertas} alerta(s) da verificação automática` : ""}</span>
                <Link href={`/app/portal-cliente/processos/${r.processo_id}`} className="font-semibold underline">Revisar</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-6 rounded-[26px] bg-white p-6">
        <h2 className="text-lg font-medium">Resumo por inteligência artificial</h2>
        {v.e_dono ? (
          <form action={configurarModo} className="mt-3 grid gap-3 text-sm">
            <label className="flex items-start gap-3">
              <input type="radio" name="modo" value="revisar" defaultChecked={v.modo === "revisar"} className="mt-1" />
              <span><strong>Revisar antes de publicar.</strong> O resumo nasce como rascunho e só vai ao cliente depois que você ler e publicar.</span>
            </label>
            <label className="flex items-start gap-3">
              <input type="radio" name="modo" value="direto" defaultChecked={v.modo === "direto"} className="mt-1" />
              <span><strong>Publicar direto.</strong> O resumo vai ao cliente assim que é gerado. Se a verificação automática achar algo estranho (opinião, previsão, data ou valor que não está nas movimentações), ele vira rascunho do mesmo jeito.</span>
            </label>
            <button type="submit" className="h-10 w-fit rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground">Salvar</button>
          </form>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Neste escritório, o resumo por IA {v.modo === "direto" ? "é publicado direto quando a verificação automática não acha problema" : "fica como rascunho até você revisar e publicar"}. Quem muda isso é o dono.
          </p>
        )}
      </section>

      <section className="mt-6 rounded-[26px] bg-white p-6">
        <h2 className="text-lg font-medium">Processos liberados ({v.liberacoes.length})</h2>
        {v.liberacoes.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nenhum processo liberado. Nenhum cliente consegue entrar no portal ainda.</p>
        ) : (
          <ul className="mt-3 grid gap-2 text-sm">
            {v.liberacoes.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2">
                <span><strong>{l.cliente_nome}</strong> · {formatarCnj(l.numero_cnj)} · vê: {oQueVe(l)}</span>
                <Link href={`/app/portal-cliente/processos/${l.processo_id}`} className="font-semibold underline">Gerenciar</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-[26px] bg-white p-6">
        <h2 className="text-lg font-medium">Últimos acessos dos clientes</h2>
        <p className="mt-1 text-xs text-muted-foreground">Cada acesso guarda a data, a hora e o endereço de rede (IP) de quem entrou.</p>
        {v.acessos.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Ainda não houve acesso.</p>
        ) : (
          <ul className="mt-3 grid gap-1.5 text-sm">
            {v.acessos.map((a, i) => (
              <li key={i}>
                {dataHoraBR(a.criado_em)} · <strong>{a.cliente_nome}</strong> · {TIPO_ACESSO[a.tipo] ?? a.tipo}
                {a.numero_cnj ? ` (${formatarCnj(a.numero_cnj)})` : ""} · IP {a.ip ?? "não identificado"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
