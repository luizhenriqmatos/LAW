import Link from "next/link";
import { redirect } from "next/navigation";
import { situacaoAtual, dataBR } from "@/lib/portal/linguagem";
import { carregarInicio } from "@/lib/portal/servidor";
import { BotaoSair } from "./sair";

function cnj(n: string) {
  return n.replace(/^(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})$/, "$1-$2.$3.$4.$5.$6");
}

export default async function PaginaPortal() {
  const inicio = await carregarInicio();
  if (!inicio) redirect("/portal/entrar?erro=sessao");
  const nome = inicio.clientes[0]?.split(" ")[0];

  return (
    <main>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-4xl font-medium tracking-tight">{nome ? `Olá, ${nome}` : "Olá"}</h1>
        <BotaoSair />
      </div>
      <p className="mt-2 text-muted-foreground">Estes são os processos que o seu advogado liberou para você acompanhar.</p>

      <ul className="mt-6 grid gap-4">
        {inicio.processos.map((p) => {
          const s = situacaoAtual(p.situacao_texto, p.ultima_movimentacao);
          return (
            <li key={p.processo_id} className="rounded-[26px] bg-card p-6 shadow-sm">
              <p className="text-sm text-muted-foreground">{p.escritorio}</p>
              <h2 className="mt-1 text-xl font-medium">{p.titulo ?? "Processo"}</h2>
              <p className="text-sm text-muted-foreground">
                Nº {cnj(p.numero_cnj)}
                {p.tribunal ? ` · ${p.tribunal}` : ""}
              </p>
              <p className="mt-4 text-sm font-medium">Situação atual</p>
              <p className="mt-1">{s.texto}</p>
              {s.data ? <p className="mt-1 text-xs text-muted-foreground">Último andamento em {dataBR(s.data)}</p> : null}
              <Link href={`/portal/processos/${p.processo_id}`} className="mt-4 inline-block rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground">
                Ver detalhes
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
