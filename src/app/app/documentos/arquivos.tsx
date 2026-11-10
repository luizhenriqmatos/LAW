import Link from "next/link";
import { listarArquivos } from "@/lib/drive/arquivos";
import { depsDriveDoAmbiente, driveConfigurado } from "@/lib/drive/ambiente";
import { mensagemDeErro } from "@/lib/erros";
import { linkDaPasta } from "@/lib/integrations/google/drive-api";
import type { criarClienteServidor } from "@/lib/supabase/servidor";
import { cn } from "@/lib/utils";
import { botaoPequeno } from "../processos/comum";
import { enviarArquivoDrive } from "./actions";

type Supabase = Awaited<ReturnType<typeof criarClienteServidor>>;

function tamanho(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

const data = (iso: string | null) => (iso ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(new Date(iso)) : "");

/**
 * Seção "Arquivos" das telas de cliente e processo: lista a pasta no Drive do escritório, envia arquivo e abre no Drive.
 * Mostra só o que o LAW enviou/criou (limite do escopo drive.file); o que for solto direto na pasta pelo Drive não aparece aqui.
 */
export async function SecaoArquivos({ supabase, escritorioId, tipo, refId, destino, margem = true }: {
  supabase: Supabase; escritorioId: string; tipo: "cliente" | "processo"; refId: string; destino: string; margem?: boolean;
}) {
  const titulo = <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Arquivos</h2>;
  const moldura = (corpo: React.ReactNode) => <section className={cn(margem && "mt-6", "rounded-[26px] bg-white p-6")}>{titulo}{corpo}</section>;

  const { data: st } = await supabase.rpc("drive_status", { p_escritorio: escritorioId });
  const status = (st ?? { conectado: false }) as { conectado: boolean; status?: string };
  if (!status.conectado) {
    return moldura(<p className="mt-2 text-sm text-muted-foreground">O Google Drive do escritório não está conectado. O dono conecta em <Link href="/app/documentos" className="font-semibold underline">Documentos</Link> e as pastas são criadas sozinhas.</p>);
  }
  if (status.status !== "ativa") {
    return moldura(<p className="mt-2 text-sm text-amber-800">A conexão com o Google Drive parou. O dono precisa reconectar em <Link href="/app/documentos" className="font-semibold underline">Documentos</Link>. Nada foi apagado.</p>);
  }

  const { data: pasta } = await supabase.rpc("drive_pasta_de", { p_tipo: tipo, p_ref: refId });
  const p = pasta as { drive_id: string; nome: string } | null;
  if (!p) {
    return moldura(<p className="mt-2 text-sm text-muted-foreground">A pasta no Drive ainda não foi criada. Ela aparece sozinha depois que o {tipo === "cliente" ? "cliente" : "processo"} é confirmado (leva alguns instantes).</p>);
  }

  const r = driveConfigurado() ? await listarArquivos(depsDriveDoAmbiente(), escritorioId, p.drive_id) : null;

  return moldura(
    <>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <span className="min-w-0 flex-1 truncate">Pasta: <span className="font-medium">{p.nome}</span></span>
        <a href={linkDaPasta(p.drive_id)} target="_blank" rel="noopener noreferrer" className={cn(botaoPequeno, "bg-muted hover:bg-muted/70")}>Abrir pasta no Drive</a>
      </div>

      {r === null ? (
        <p className="mt-3 text-sm text-muted-foreground">A conexão com o Google ainda não foi ativada neste LAW; não dá para listar os arquivos aqui.</p>
      ) : !r.ok ? (
        <p role="alert" className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{mensagemDeErro(r.codigo)}</p>
      ) : r.dados.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Nenhum arquivo enviado pelo LAW ainda.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border text-sm">
          {r.dados.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="min-w-0 flex-1 truncate font-medium">{a.pasta ? "📁 " : ""}{a.nome}</span>
              <span className="text-muted-foreground">{a.pasta ? "" : tamanho(a.tamanho)} {data(a.modificadoEm)}</span>
              {a.link ? <a href={a.link} target="_blank" rel="noopener noreferrer" className="font-semibold underline">Abrir no Drive</a> : null}
            </li>
          ))}
        </ul>
      )}

      <form action={enviarArquivoDrive.bind(null, tipo, refId, destino)} encType="multipart/form-data" className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <input type="file" name="arquivo" required aria-label="Arquivo para enviar" className="min-w-0 flex-1 text-sm file:mr-3 file:rounded-full file:border-0 file:bg-muted file:px-4 file:py-2 file:text-sm file:font-semibold" />
        <button className={cn(botaoPequeno, "bg-primary text-primary-foreground")}>Enviar para o Drive</button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">Até 4 MB por arquivo aqui; para arquivos maiores, abra a pasta no Drive. A lista mostra o que foi enviado pelo LAW; arquivos colocados direto na pasta pelo Drive ficam lá, mas não aparecem aqui.</p>
    </>,
  );
}
