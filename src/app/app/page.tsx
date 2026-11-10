import Link from "next/link";
import { exigirEscritorio } from "@/lib/contexto";
import { itensDoMenu } from "@/lib/modulos";

const STATUS: Record<string, string> = {
  nao_configurado: "Monitoramento não configurado",
  aguardando_busca: "Busca de processos na fila",
  buscando: "Buscando processos",
  concluido: "Processos encontrados",
  erro: "A busca falhou",
};

export default async function Painel() {
  const { vinculo, modulos } = await exigirEscritorio();
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-5xl font-medium tracking-tight">Painel</h1>
      <p className="mt-2 text-muted-foreground">{vinculo.escritorioNome}</p>

      <Link href={vinculo.modoMonitoramento ? "/onboarding/buscando" : "/onboarding/monitoramento"} className="mt-6 flex items-center justify-between rounded-[26px] bg-accent px-5 py-4 font-medium">
        <span>{STATUS[vinculo.statusMonitoramento] ?? "Monitoramento"}</span>
        <span aria-hidden>›</span>
      </Link>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Seus módulos</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {itensDoMenu(modulos).map((m) => (
          <Link key={m.id} href={m.rota} className="rounded-[26px] bg-white p-5 font-semibold hover:shadow-sm">
            {m.rotulo}
          </Link>
        ))}
      </div>
    </div>
  );
}
