import { mensagemDeErro } from "@/lib/erros";
import { cn } from "@/lib/utils";

const OK: Record<string, string> = {
  assinatura_criada: "Envelope criado e congelado. Os primeiros signatários já receberam o link por e-mail.",
  assinatura_criada_sem_email: "Envelope criado e congelado, mas o e-mail NÃO saiu (envio de e-mail não configurado). Gere o link de cada signatário na tela do envelope.",
  assinatura_reenviada: "Novo link enviado. O link anterior deixou de valer.",
  assinatura_reenviada_sem_email: "Novo link gerado, mas o e-mail não saiu. O link anterior deixou de valer.",
  assinatura_cancelada: "Envelope cancelado. Os links dos signatários deixaram de funcionar. Documento e evidências continuam guardados.",
  assinatura_concluida: "PDF final gerado e hash registrado.",
};

export function AvisoAssinatura({ codigo }: { codigo?: string | string[] }) {
  const c = typeof codigo === "string" ? codigo : undefined;
  if (!c) return null;
  const ok = OK[c];
  return (
    <p role={ok ? "status" : "alert"} className={cn("mt-4 rounded-xl px-4 py-3 text-sm font-medium", ok ? "bg-accent text-accent-foreground" : "bg-red-50 text-red-700")}>
      {ok ?? mensagemDeErro(c.replace(/^erro_/, ""))}
    </p>
  );
}

/** Aviso fixo da interface: o que esta assinatura é e o que não é. */
export function AvisoTipoAssinatura({ className }: { className?: string }) {
  return (
    <p className={cn("rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950", className)}>
      <strong>Assinatura eletrônica avançada, não qualificada.</strong> Vale pela Lei 14.063/2020 (art. 4º, II) quando as partes aceitam esse meio; não usa certificado ICP-Brasil.
      Documentos que a lei exige assinar com certificado qualificado não devem ser assinados por aqui.
    </p>
  );
}

export const STATUS_ENVELOPE: Record<string, { rotulo: string; estilo: string }> = {
  enviado: { rotulo: "Aguardando assinaturas", estilo: "bg-amber-100 text-amber-900" },
  assinado: { rotulo: "Todos assinaram (gerando PDF final)", estilo: "bg-sky-100 text-sky-900" },
  concluido: { rotulo: "Concluído", estilo: "bg-emerald-50 text-emerald-800" },
  cancelado: { rotulo: "Cancelado", estilo: "bg-neutral-100 text-neutral-600" },
};

export const ROTULO_EVIDENCIA: Record<string, string> = {
  envelope_criado: "Envelope criado e arquivo congelado",
  envio_email: "E-mail com o link",
  abertura_link: "Link aberto",
  visualizacao: "Documento visualizado",
  aceite: "Aceite",
  assinatura: "Assinatura",
  conclusao_envelope: "Envelope concluído (PDF final)",
  envelope_cancelado: "Envelope cancelado",
};

export function dataHora(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Bahia", dateStyle: "short", timeStyle: "medium" }) : "—";
}
