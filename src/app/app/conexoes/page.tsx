import { NOME_ASSISTENTE } from "@/lib/assistente/nome";
import { exigirEscritorio } from "@/lib/contexto";
import { mensagemDeErro } from "@/lib/erros";
import { mcpConfigurado } from "@/lib/mcp/ambiente";
import { recursoMcp, urlBase } from "@/lib/oauth/config";
import { cn } from "@/lib/utils";
import { configurarConectores, revogarConexao } from "./actions";

type Conexao = {
  id: string; cliente: string; perfil: string; escopos: string[]; pessoa: string; minha: boolean; criado_em: string;
  ultimo_uso_em: string | null; revogada_em: string | null; motivo: string | null; chamadas_24h: number; escritas_24h: number;
};
type Dados = { dono: boolean; conectores_ativos: boolean; expor_sigilo: boolean; conexoes: Conexao[] };

const OK: Record<string, string> = {
  conexao_revogada: "Acesso revogado. O aplicativo já não consegue mais usar o LAW.",
  conectores_salvos: "Configuração salva.",
};
const quando = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Bahia", dateStyle: "short", timeStyle: "short" }) : "nunca");
const MOTIVO: Record<string, string> = { usuario: "revogada por você", dono: "revogada pelo dono", refresh_reutilizado: "revogada automaticamente (uso suspeito do token)" };

export default async function PaginaConexoes({ searchParams }: PageProps<"/app/conexoes">) {
  const sp = await searchParams;
  const { supabase, vinculo, modulos } = await exigirEscritorio();
  const { data } = await supabase.rpc("conexoes_listar", { p_escritorio: vinculo.escritorioId });
  const d = (data ?? { dono: false, conectores_ativos: true, expor_sigilo: false, conexoes: [] }) as Dados;
  const base = urlBase();
  const aviso = typeof sp.aviso === "string" ? sp.aviso : null;
  const ativas = d.conexoes.filter((c) => !c.revogada_em);
  const revogadas = d.conexoes.filter((c) => c.revogada_em);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-5xl font-medium tracking-tight">Conexões</h1>
      <p className="mt-3 text-muted-foreground">
        Ligue o assistente de IA que você já usa (Claude, ChatGPT) à sua conta do LAW. Ele usa as <strong>suas</strong> permissões: só vê o que você vê.
      </p>
      {aviso ? (
        <p role={OK[aviso] ? "status" : "alert"} className={cn("mt-4 rounded-xl px-4 py-3 text-sm font-medium", OK[aviso] ? "bg-accent text-accent-foreground" : "bg-red-50 text-red-700")}>
          {OK[aviso] ?? mensagemDeErro(aviso.replace(/^erro_/, ""))}
        </p>
      ) : null}

      <section className="mt-6 rounded-[26px] bg-white p-6 text-sm">
        <h2 className="text-lg font-semibold">Como conectar</h2>
        {base && mcpConfigurado() ? (
          <>
            <p className="mt-2">No seu assistente, adicione um <strong>conector personalizado (MCP)</strong> com este endereço:</p>
            <code className="mt-2 block break-all rounded-xl bg-muted px-3 py-2 text-[13px]">{recursoMcp(base)}</code>
            <ol className="mt-3 grid list-decimal gap-1 pl-5 text-muted-foreground">
              <li>O assistente abre esta conta do LAW para você autorizar.</li>
              <li>Escolha o escritório e confirme o que ele poderá fazer.</li>
              <li><strong>Claude</strong>: pode ler e criar (pede sua aprovação a cada gravação). <strong>ChatGPT</strong> e outros: só leitura.</li>
            </ol>
          </>
        ) : <p className="mt-2 text-red-700">A conexão com assistentes externos ainda não foi ativada neste LAW (falta configuração do servidor).</p>}
        {!modulos.includes("assistente") ? (
          <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-amber-950">Você ainda não tem acesso à {NOME_ASSISTENTE} neste escritório; sem ele, a conexão é recusada. Peça ao dono.</p>
        ) : null}
      </section>

      {d.dono ? (
        <section className="mt-6 rounded-[26px] bg-white p-6 text-sm">
          <h2 className="text-lg font-semibold">Regras do escritório (só o dono)</h2>
          <form action={configurarConectores} className="mt-3 grid gap-3">
            <label className="flex items-start gap-2">
              <input type="checkbox" name="ativos" defaultChecked={d.conectores_ativos} className="mt-1" />
              <span><strong>Permitir conexões com assistentes externos.</strong> Desligar corta na hora todas as conexões do escritório.</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" name="expor_sigilo" defaultChecked={d.expor_sigilo} className="mt-1" />
              <span>
                <strong>Mostrar processos em segredo de justiça aos assistentes externos.</strong> Desligado (padrão), eles não aparecem de jeito nenhum,
                nem o número. Ligado, aparecem só o número, o tribunal e o link, sem partes, título ou texto de publicação.
              </span>
            </label>
            <button className="h-10 w-fit rounded-full bg-primary px-5 font-medium text-primary-foreground">Salvar</button>
          </form>
        </section>
      ) : null}

      <section className="mt-6">
        <h2 className="text-lg font-semibold">{d.dono ? "Conexões ativas no escritório" : "Suas conexões ativas"}</h2>
        {ativas.length ? (
          <ul className="mt-3 grid gap-2">
            {ativas.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 text-sm">
                <div>
                  <p className="font-medium">{c.cliente}{d.dono && !c.minha ? <span className="text-muted-foreground"> · {c.pessoa}</span> : null}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.escopos.includes("law.write") ? "Ler e criar" : "Só ler"} · conectado em {quando(c.criado_em)} · último uso {quando(c.ultimo_uso_em)}
                    · {c.chamadas_24h} chamada(s) e {c.escritas_24h} gravação(ões) nas últimas 24 h
                  </p>
                </div>
                <form action={revogarConexao.bind(null, c.id)}>
                  <button className="h-9 rounded-full bg-red-50 px-4 font-medium text-red-700 hover:bg-red-100">Revogar acesso</button>
                </form>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-muted-foreground">Nenhuma conexão ativa.</p>}
        {revogadas.length ? (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Revogadas nos últimos 30 dias ({revogadas.length})</summary>
            <ul className="mt-2 grid gap-1 text-muted-foreground">
              {revogadas.map((c) => <li key={c.id}>{c.cliente}{d.dono && !c.minha ? ` · ${c.pessoa}` : ""} — {quando(c.revogada_em)} ({MOTIVO[c.motivo ?? ""] ?? "revogada"})</li>)}
            </ul>
          </details>
        ) : null}
      </section>
    </div>
  );
}
