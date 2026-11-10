import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { MolduraEntrada } from "@/components/moldura-entrada";
import { criarClienteServidor } from "@/lib/supabase/servidor";
import { supabaseConfigurado } from "@/lib/supabase/config";
import { FormularioAceite } from "./formulario";

export default async function PaginaConvite({ params }: PageProps<"/convite/[token]">) {
  await connection();
  if (!supabaseConfigurado()) redirect("/configuracao-pendente");
  const { token } = await params;
  const valido = /^[0-9a-f]{64}$/.test(token);
  const supabase = await criarClienteServidor();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const aqui = `/convite/${token}`;

  if (!valido) {
    return (
      <MolduraEntrada titulo="Convite inválido" subtitulo="Confira se copiou o link inteiro.">
        <Link href="/entrar" className="font-semibold underline">Ir para a entrada</Link>
      </MolduraEntrada>
    );
  }

  if (!user) {
    return (
      <MolduraEntrada titulo="Você foi convidado" subtitulo="Entre ou crie sua conta com o mesmo e-mail que recebeu o convite.">
        <div className="flex flex-wrap gap-2">
          <Link href={`/cadastro?proximo=${encodeURIComponent(aqui)}`} className="inline-flex h-10 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground">
            Criar conta
          </Link>
          <Link href={`/entrar?proximo=${encodeURIComponent(aqui)}`} className="inline-flex h-10 items-center rounded-full bg-white px-5 text-sm font-medium">
            Já tenho conta
          </Link>
        </div>
      </MolduraEntrada>
    );
  }

  return (
    <MolduraEntrada titulo="Aceitar convite" subtitulo={`Você vai entrar na equipe com o e-mail ${user.email}.`}>
      <FormularioAceite token={token} />
    </MolduraEntrada>
  );
}
