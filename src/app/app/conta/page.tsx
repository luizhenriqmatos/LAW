import Link from "next/link";
import { exigirDono } from "@/lib/contexto";
import { mensagemDeErro } from "@/lib/erros";
import { cn } from "@/lib/utils";
import { cancelarEncerramento, solicitarEncerramento } from "./actions";

const OK: Record<string, string> = {
  encerramento_pedido: "Pedido registrado. A conta ficou somente para leitura por 30 dias. Enviamos um aviso por e-mail ao dono.",
  encerramento_cancelado: "Encerramento cancelado. A conta voltou ao normal.",
};
const dataHora = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Bahia", dateStyle: "long", timeStyle: "short" });

export default async function PaginaConta({ searchParams }: PageProps<"/app/conta">) {
  const sp = await searchParams;
  const { vinculo } = await exigirDono();
  const aviso = typeof sp.aviso === "string" ? sp.aviso : null;
  const encerrando = vinculo.encerramentoAte;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-5xl font-medium tracking-tight">Conta</h1>
      <p className="mt-3 text-muted-foreground">{vinculo.escritorioNome}</p>
      {aviso ? (
        <p role={OK[aviso] ? "status" : "alert"} className={cn("mt-4 rounded-xl px-4 py-3 text-sm font-medium", OK[aviso] ? "bg-accent text-accent-foreground" : "bg-red-50 text-red-700")}>
          {OK[aviso] ?? (aviso === "erro_confirmacao" ? "O nome digitado não confere com o nome do escritório." : mensagemDeErro(aviso.replace(/^erro_/, "")))}
        </p>
      ) : null}

      <section className="mt-6 rounded-[26px] bg-white p-6 text-sm">
        <h2 className="text-lg font-semibold">Baixar tudo</h2>
        <p className="mt-2 text-muted-foreground">
          Um arquivo ZIP com planilhas (CSV) de todos os dados do escritório e os PDFs dos documentos assinados. Dá para baixar quando quiser, não só ao encerrar.
        </p>
        <a href="/app/conta/exportar" download className="mt-4 inline-block rounded-full bg-primary px-5 py-2.5 font-semibold text-primary-foreground">
          Baixar exportação completa
        </a>
        <p className="mt-3 text-xs text-muted-foreground">Os arquivos que estão no seu Google Drive continuam lá; o ZIP não os copia.</p>
      </section>

      {encerrando ? (
        <section role="alert" className="mt-6 rounded-[26px] border border-amber-300 bg-amber-50 p-6 text-sm text-amber-950">
          <h2 className="text-lg font-semibold">Conta em encerramento</h2>
          <p className="mt-2">
            Até <strong>{dataHora(encerrando)}</strong> a conta só permite leitura e exportação. Depois disso, os dados do escritório são apagados.
            Ficam guardados por 5 anos apenas os documentos assinados e as evidências das assinaturas.
          </p>
          <form action={cancelarEncerramento} className="mt-4">
            <button className="rounded-full border border-amber-900 px-5 py-2.5 font-semibold">Cancelar o encerramento</button>
          </form>
        </section>
      ) : (
        <section className="mt-6 rounded-[26px] border border-red-200 bg-white p-6 text-sm">
          <h2 className="text-lg font-semibold text-red-800">Encerrar a conta</h2>
          <ul className="mt-2 grid list-disc gap-1 pl-5 text-muted-foreground">
            <li>Por 30 dias a conta fica somente para leitura, com exportação liberada.</li>
            <li>Você pode cancelar nesse período.</li>
            <li>Passados os 30 dias, apagamos os dados do escritório e não conseguimos recuperar.</li>
            <li>Os documentos assinados e suas evidências ficam guardados por 5 anos (obrigação de guarda) e continuam verificáveis.</li>
            <li>Avisamos por e-mail agora, 7 dias antes e na exclusão.</li>
          </ul>
          <form action={solicitarEncerramento} className="mt-4 grid gap-2">
            <label htmlFor="confirmacao" className="font-medium">Para confirmar, digite o nome do escritório: <span className="font-semibold">{vinculo.escritorioNome}</span></label>
            <input id="confirmacao" name="confirmacao" required autoComplete="off" className="h-11 rounded-xl border px-3" />
            <button className="w-fit rounded-full bg-red-700 px-5 py-2.5 font-semibold text-white">Encerrar a conta</button>
          </form>
        </section>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        <Link href="/termos" className="underline">Termos de uso</Link> · <Link href="/privacidade" className="underline">Política de privacidade</Link>
      </p>
    </div>
  );
}
