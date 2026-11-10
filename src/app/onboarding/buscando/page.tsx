import Link from "next/link";
import { MolduraEntrada } from "@/components/moldura-entrada";
import { exigirEscritorio } from "@/lib/contexto";
import { formatarCnpj } from "@/lib/validacao";

type Alvo = { tipo: "oab" | "sociedade"; oab_numero: string | null; oab_uf: string | null; cnpj: string | null; nome_sociedade: string | null };

const ETAPAS = [
  { id: "config", rotulo: "Configuração salva" },
  { id: "busca", rotulo: "Buscando publicações no DJEN" },
  { id: "vinculo", rotulo: "Ligando publicações aos processos" },
];

function estadoDaEtapa(etapa: string, status: string): "feito" | "agora" | "depois" | "erro" {
  if (etapa === "config") return "feito";
  if (status === "erro") return etapa === "busca" ? "erro" : "depois";
  if (status === "concluido") return "feito";
  if (status === "buscando") return etapa === "busca" ? "agora" : "depois";
  return etapa === "busca" ? "agora" : "depois";
}

export default async function PaginaBuscando() {
  const { supabase, vinculo } = await exigirEscritorio();
  const { data } = await supabase
    .from("alvo_monitoramento")
    .select("tipo, oab_numero, oab_uf, cnpj, nome_sociedade")
    .eq("escritorio_id", vinculo.escritorioId);
  const alvos = (data ?? []) as Alvo[];
  const status = vinculo.statusMonitoramento;

  return (
    <MolduraEntrada titulo="Estamos buscando seus processos" subtitulo={vinculo.escritorioNome}>
      <ol className="grid gap-3">
        {ETAPAS.map((e) => {
          const st = estadoDaEtapa(e.id, status);
          return (
            <li key={e.id} className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3">
              <span
                aria-hidden
                className={`grid size-6 place-items-center rounded-full text-xs font-bold ${
                  st === "feito" ? "bg-primary text-primary-foreground" : st === "agora" ? "animate-pulse bg-accent" : st === "erro" ? "bg-red-100 text-red-700" : "bg-muted"
                }`}
              >
                {st === "feito" ? "✓" : st === "erro" ? "!" : ""}
              </span>
              <span className="font-medium">{e.rotulo}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {st === "feito" ? "concluído" : st === "agora" ? (status === "aguardando_busca" ? "na fila" : "em andamento") : st === "erro" ? "falhou" : "a seguir"}
              </span>
            </li>
          );
        })}
      </ol>

      {status === "aguardando_busca" ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Sua configuração está na fila. A leitura do DJEN começa assim que a captura de publicações estiver ativa, e você é avisado quando terminar.
        </p>
      ) : null}

      <div className="mt-5 rounded-2xl bg-muted p-4 text-sm">
        <p className="font-semibold">O que vamos acompanhar</p>
        <ul className="mt-2 grid gap-1 text-muted-foreground">
          {alvos.map((a, i) => (
            <li key={i}>
              {a.tipo === "oab" ? `OAB ${a.oab_numero}/${a.oab_uf}` : [a.cnpj ? `CNPJ ${formatarCnpj(a.cnpj)}` : null, a.nome_sociedade].filter(Boolean).join(" · ")}
            </li>
          ))}
        </ul>
        {vinculo.papel === "dono" ? (
          <Link href="/onboarding/monitoramento" className="mt-3 inline-block font-semibold text-foreground underline">
            Alterar
          </Link>
        ) : null}
      </div>

      <Link href="/app" className="mt-6 inline-flex h-10 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground">
        Ir para o painel
      </Link>
    </MolduraEntrada>
  );
}
