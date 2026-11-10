import { redirect } from "next/navigation";
import { BotaoEnviar } from "@/components/formulario";
import { MolduraEntrada } from "@/components/moldura-entrada";
import { tokenComFormatoValido } from "@/lib/portal/token";
import { entrarComLink } from "../../actions";

/**
 * Esta página NÃO consome o link: só mostra o botão. Programas de segurança de e-mail abrem links antes da pessoa
 * e, se abrir já gastasse o link, ele chegaria "usado" para o cliente.
 */
export default async function PaginaAcesso({ params }: PageProps<"/portal/acesso/[token]">) {
  const { token } = await params;
  if (!tokenComFormatoValido(token)) redirect("/portal/entrar?erro=invalido");
  return (
    <MolduraEntrada titulo="Entrar no portal" subtitulo="Toque no botão para ver seus processos.">
      <form action={entrarComLink.bind(null, token)}>
        <BotaoEnviar className="w-full">Entrar</BotaoEnviar>
      </form>
      <p className="mt-4 text-xs text-muted-foreground">Se você não pediu este acesso, feche esta página. Nada acontece sem o seu toque.</p>
    </MolduraEntrada>
  );
}
