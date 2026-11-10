import { MolduraEntrada } from "@/components/moldura-entrada";
import { servicoConfigurado } from "@/lib/supabase/servico";
import { FormularioPedirLink } from "./formulario";

const ERROS: Record<string, string> = {
  invalido: "Este link não é válido. Peça um novo abaixo.",
  usado: "Este link já foi usado. Por segurança, cada link vale uma vez só. Peça um novo abaixo.",
  expirado: "Este link venceu (ele vale 30 minutos). Peça um novo abaixo.",
  sessao: "Sua sessão terminou. Peça um novo link para entrar.",
};

export default async function PaginaEntrarPortal({ searchParams }: PageProps<"/portal/entrar">) {
  const sp = await searchParams;
  const erro = typeof sp.erro === "string" ? ERROS[sp.erro] : undefined;
  return (
    <MolduraEntrada titulo="Acompanhe seu processo" subtitulo="Sem senha: enviamos um link de acesso para o seu e-mail.">
      {erro ? (
        <p role="alert" className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{erro}</p>
      ) : null}
      {servicoConfigurado() ? (
        <FormularioPedirLink />
      ) : (
        <p className="text-sm text-muted-foreground">O portal ainda não está disponível. Fale com o seu advogado.</p>
      )}
    </MolduraEntrada>
  );
}
