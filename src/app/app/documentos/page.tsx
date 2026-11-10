import { driveConfigurado } from "@/lib/drive/ambiente";
import { exigirModulo } from "@/lib/contexto";
import { linkDaPasta } from "@/lib/integrations/google/drive-api";
import { cn } from "@/lib/utils";
import { Aviso, botaoPequeno } from "../processos/comum";
import { desconectarDrive } from "./actions";

type StatusDrive = { conectado: boolean; status?: "ativa" | "revogada" | "erro"; erro?: string | null; raiz_id?: string; pastas?: number; pendentes?: number; falhas?: number };

export default async function PaginaDocumentos({ searchParams }: PageProps<"/app/documentos">) {
  const sp = await searchParams;
  const { supabase, vinculo } = await exigirModulo("documentos");
  const dono = vinculo.papel === "dono";
  const { data } = await supabase.rpc("drive_status", { p_escritorio: vinculo.escritorioId });
  const d = (data ?? { conectado: false }) as StatusDrive;
  const ok = driveConfigurado();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-5xl font-medium tracking-tight">Documentos</h1>
      <p className="mt-3 text-muted-foreground">Os arquivos de cada cliente e processo ficam organizados, sozinhos, no Google Drive do escritório.</p>
      <Aviso codigo={sp.aviso} />

      <section className={cn("mt-6 rounded-[26px] p-6 text-sm", d.conectado && d.status !== "ativa" ? "border border-amber-300 bg-amber-50" : "bg-white")}>
        <h2 className="text-lg font-semibold">Google Drive do escritório</h2>
        {d.conectado && d.status === "ativa" ? (
          <>
            <p className="mt-2 text-muted-foreground">
              Conectado. Ao confirmar um cliente, o LAW cria <span className="font-medium text-foreground">LAW / Clientes / nome do cliente</span>; ao confirmar um processo, cria a subpasta
              {" "}<span className="font-medium text-foreground">número CNJ - classe</span> dentro da pasta do cliente principal. Renomear o cliente renomeia a pasta.
            </p>
            <p className="mt-2">{d.pastas ?? 0} pasta(s) criada(s){d.pendentes ? ` · ${d.pendentes} na fila` : ""}{d.falhas ? ` · ${d.falhas} com problema (o LAW tenta de novo sozinho)` : ""}.</p>
            <div className="mt-3 flex flex-wrap gap-3">
              {d.raiz_id ? <a href={linkDaPasta(d.raiz_id)} target="_blank" rel="noopener noreferrer" className={cn(botaoPequeno, "h-9 bg-muted hover:bg-muted/70")}>Abrir a pasta LAW no Drive</a> : null}
              {dono ? <form action={desconectarDrive}><button className={cn(botaoPequeno, "h-9 bg-muted hover:bg-muted/70")}>Desconectar</button></form> : null}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              O LAW usa a permissão mais restrita do Google (“drive.file”): só enxerga o que ele mesmo criou. Nunca apaga nada no seu Drive; ao descartar ou desconectar, a pasta só deixa de ser acompanhada pelo LAW e continua lá.
            </p>
          </>
        ) : d.conectado ? (
          <>
            <p className="mt-2 text-amber-900">{d.status === "revogada" ? "O acesso ao Google Drive foi revogado ou expirou." : "A integração com o Google Drive parou por um erro."} A criação de pastas e os envios estão parados; o resto do LAW segue normal. Nada foi apagado no Drive.</p>
            {dono ? (
              <div className="mt-3 flex flex-wrap gap-3">
                {ok ? <a href="/api/google/conectar?para=drive" className={cn(botaoPequeno, "h-9 bg-primary text-primary-foreground")}>Reconectar</a> : null}
                <form action={desconectarDrive}><button className={cn(botaoPequeno, "h-9 bg-white hover:bg-white/70")}>Remover conexão</button></form>
              </div>
            ) : <p className="mt-2 text-muted-foreground">Peça ao dono do escritório para reconectar.</p>}
          </>
        ) : !ok ? (
          <p className="mt-2 text-muted-foreground">A conexão com o Google ainda não foi ativada neste LAW (faltam as credenciais). O resto do LAW funciona normalmente.</p>
        ) : dono ? (
          <>
            <p className="mt-2 text-muted-foreground">Conecte a conta Google do escritório. O LAW cria a pasta “LAW” no Drive e, dentro dela, uma pasta por cliente e uma por processo. Só o dono pode conectar.</p>
            <a href="/api/google/conectar?para=drive" className={cn(botaoPequeno, "mt-3 h-9 bg-primary text-primary-foreground")}>Conectar Google Drive</a>
          </>
        ) : (
          <p className="mt-2 text-muted-foreground">O Drive ainda não foi conectado. Só o dono do escritório pode conectar.</p>
        )}
      </section>
    </div>
  );
}
