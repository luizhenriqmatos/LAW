import { mensagemDeErro } from "@/lib/erros";
import { cn } from "@/lib/utils";

const OK: Record<string, string> = {
  portal_liberado: "Liberação salva. O cliente já vê o que você marcou.",
  portal_revogado: "Acesso retirado. O cliente não vê mais este processo.",
  portal_compromisso: "Visibilidade do compromisso atualizada.",
  portal_configurado: "Configuração salva.",
  portal_resumo_publicado: "Resumo publicado no portal do cliente.",
  portal_resumo_rascunho: "Resumo salvo como rascunho. Leia, ajuste e publique quando estiver bom.",
  portal_resumo_editado: "Rascunho atualizado.",
  portal_resumo_encerrado: "Resumo retirado.",
  portal_documento: "Documento compartilhado com o cliente.",
  portal_documento_revogado: "Documento deixou de ser compartilhado.",
};

export function AvisoPortal({ codigo }: { codigo?: string | string[] }) {
  const c = typeof codigo === "string" ? codigo : undefined;
  if (!c) return null;
  const ok = OK[c];
  return (
    <p role={ok ? "status" : "alert"} className={cn("mt-4 rounded-xl px-4 py-3 text-sm font-medium", ok ? "bg-accent text-accent-foreground" : "bg-red-50 text-red-700")}>
      {ok ?? mensagemDeErro(c.replace(/^erro_/, ""))}
    </p>
  );
}
