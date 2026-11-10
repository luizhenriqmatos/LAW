import { mensagemDeErro } from "@/lib/erros";
import { cn } from "@/lib/utils";

export const OK_ATENDIMENTO: Record<string, string> = {
  assumido: "Você assumiu o atendimento.",
  encerrado: "Atendimento encerrado. Se a pessoa escrever de novo, a recepcionista volta a atender.",
  enviado: "Mensagem enviada.",
  config_salva: "Configuração salva.",
  numero_salvo: "Número salvo.",
};

export function AvisoAtendimento({ codigo }: { codigo: string | string[] | undefined }) {
  const c = typeof codigo === "string" ? codigo : null;
  if (!c) return null;
  const ok = OK_ATENDIMENTO[c];
  return (
    <p role={ok ? "status" : "alert"} className={cn("mt-4 rounded-xl px-4 py-3 text-sm font-medium", ok ? "bg-accent text-accent-foreground" : "bg-red-50 text-red-700")}>
      {ok ?? mensagemDeErro(c.replace(/^erro_/, ""))}
    </p>
  );
}

export const quando = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Bahia", dateStyle: "short", timeStyle: "short" }) : "—";

export const ROTULO_STATUS: Record<string, string> = { aberto: "Aguardando alguém", em_andamento: "Em atendimento", encerrado: "Encerrado" };

/** Telefone do WhatsApp (55 + DDD + número) para leitura humana. */
export function telefoneBonito(t: string): string {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(t);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${t}`;
}

/** Janela de 24 h da Meta: conta a partir da última mensagem RECEBIDA da pessoa. */
export function janelaDe(ultimaEntradaEm: string | null): { aberta: boolean; ate: string | null } {
  if (!ultimaEntradaEm) return { aberta: false, ate: null };
  const ate = new Date(new Date(ultimaEntradaEm).getTime() + 24 * 3600 * 1000);
  return { aberta: ate.getTime() > Date.now(), ate: ate.toISOString() };
}
