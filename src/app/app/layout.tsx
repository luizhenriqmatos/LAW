import Link from "next/link";
import { Marca } from "@/components/marca";
import { exigirEscritorio } from "@/lib/contexto";
import { itensDoMenu } from "@/lib/modulos";
import { situacaoCaptura } from "@/lib/captura/atraso";
import { sair } from "@/app/(entrada)/actions";
import { trocarEscritorio } from "./actions";

export default async function LayoutApp({ children }: LayoutProps<"/app">) {
  const { supabase, vinculo, vinculos, modulos, usuario } = await exigirEscritorio();
  // Camada 1 (menu): só aparece o que o membro pode ver.
  const itens = itensDoMenu(modulos);
  // Avisos não lidos do usuário (alertas de prazo etc.).
  const { count: avisosNaoLidos } = await supabase
    .from("notificacao")
    .select("id", { count: "exact", head: true })
    .eq("escritorio_id", vinculo.escritorioId)
    .is("lida_em", null);
  // Google Agenda do próprio usuário: se parou (token revogado), avisa em qualquer tela. Falha aqui nunca derruba a página.
  const { data: googleBruto } = modulos.includes("agenda")
    ? await supabase.rpc("google_status", { p_escritorio: vinculo.escritorioId })
    : { data: null };
  const googleParou = (googleBruto as { conectado?: boolean; status?: string } | null)?.conectado && (googleBruto as { status?: string }).status !== "ativa";
  const captura = situacaoCaptura({ modo: vinculo.modoMonitoramento, status: vinculo.statusMonitoramento, ultimaOk: vinculo.ultimaCapturaOk });

  return (
    <div className="grid min-h-screen md:grid-cols-[250px_1fr]">
      <aside className="flex flex-col gap-1 p-4 md:sticky md:top-0 md:h-screen">
        <div className="px-3 pb-4">
          <Marca href="/app" />
        </div>
        <nav aria-label="Módulos" className="grid gap-1">
          <Link href="/app" className="rounded-full px-4 py-2.5 text-sm font-medium hover:bg-white/70">
            Painel
          </Link>
          {itens.map((m) => (
            <Link key={m.id} href={m.rota} className="rounded-full px-4 py-2.5 text-sm font-medium hover:bg-white/70">
              {m.rotulo}
            </Link>
          ))}
          <Link href="/app/avisos" className="flex items-center justify-between rounded-full px-4 py-2.5 text-sm font-medium hover:bg-white/70">
            Avisos
            {avisosNaoLidos ? <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">{avisosNaoLidos}</span> : null}
          </Link>
          <Link href="/app/conexoes" className="rounded-full px-4 py-2.5 text-sm font-medium hover:bg-white/70">
            Conexões
          </Link>
          {vinculo.papel === "dono" ? (
            <Link href="/app/equipe" className="rounded-full px-4 py-2.5 text-sm font-medium hover:bg-white/70">
              Equipe e permissões
            </Link>
          ) : null}
          {vinculo.papel === "dono" ? (
            <Link href="/app/conta" className="rounded-full px-4 py-2.5 text-sm font-medium hover:bg-white/70">
              Conta
            </Link>
          ) : null}
        </nav>
        <div className="mt-auto grid gap-2 px-3 pt-6 text-sm">
          {vinculos.length > 1 ? (
            <form action={trocarEscritorio} className="grid gap-1">
              <label htmlFor="escritorio" className="text-xs text-muted-foreground">
                Escritório
              </label>
              <select id="escritorio" name="escritorio" defaultValue={vinculo.escritorioId} className="h-9 rounded-xl border bg-white px-2">
                {vinculos.map((v) => (
                  <option key={v.escritorioId} value={v.escritorioId}>
                    {v.escritorioNome}
                  </option>
                ))}
              </select>
              <button className="w-fit text-xs font-semibold underline">Trocar</button>
            </form>
          ) : (
            <p className="font-semibold">{vinculo.escritorioNome}</p>
          )}
          <p className="truncate text-xs text-muted-foreground">
            {usuario.email} · {vinculo.papel === "dono" ? "Dono" : "Membro"}
          </p>
          <form action={sair}>
            <button className="text-xs font-semibold underline">Sair</button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 p-4 md:p-8">
        {vinculo.encerramentoAte ? (
          <div role="alert" className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            <p className="font-semibold">Esta conta está em encerramento: somente leitura.</p>
            <p className="mt-1">
              Os dados serão apagados em {new Date(vinculo.encerramentoAte).toLocaleDateString("pt-BR", { timeZone: "America/Bahia", dateStyle: "long" })}.
              {vinculo.papel === "dono" ? <> <Link href="/app/conta" className="font-semibold underline">Baixar tudo ou cancelar</Link>.</> : " Peça ao dono para baixar a exportação."}
            </p>
          </div>
        ) : null}
        {captura === "atrasada" || captura === "falhou" ? (
          <div role="alert" className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            <p className="font-semibold">
              {captura === "falhou" ? "A leitura das publicações falhou." : "A leitura de hoje das publicações atrasou."}
            </p>
            <p className="mt-1">
              Isso não quer dizer que não há intimações. Até resolvermos, confira em{" "}
              <a href="https://comunica.pje.jus.br" target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                comunica.pje.jus.br
              </a>
              .
            </p>
          </div>
        ) : null}
        {googleParou ? (
          <div role="alert" className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            <p className="font-semibold">A sincronização com o seu Google Agenda parou.</p>
            <p className="mt-1">
              O acesso foi revogado ou expirou. Nada mais do LAW foi afetado.{" "}
              <Link href="/app/agenda" className="font-semibold underline">Reconectar na Agenda</Link>.
            </p>
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
