import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Marca } from "@/components/marca";
import { criarClienteServidor } from "@/lib/supabase/servidor";
import { supabaseConfigurado } from "@/lib/supabase/config";

export default async function Inicio() {
  await connection();
  if (!supabaseConfigurado()) redirect("/configuracao-pendente");
  const supabase = await criarClienteServidor();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/app");
  return (
    <main className="grid flex-1 place-items-center px-4">
      <div className="max-w-xl text-center">
        <Marca />
        <h1 className="mt-6 text-5xl font-medium tracking-tight">O escritório inteiro, num app só.</h1>
        <div className="mt-8 flex justify-center gap-2">
          <Link href="/cadastro" className="inline-flex h-11 items-center rounded-full bg-primary px-6 font-medium text-primary-foreground">
            Criar conta
          </Link>
          <Link href="/entrar" className="inline-flex h-11 items-center rounded-full bg-white px-6 font-medium">
            Entrar
          </Link>
        </div>
        <p className="mt-8 flex justify-center gap-4 text-xs text-muted-foreground">
          <Link href="/termos" className="underline">Termos de uso</Link>
          <Link href="/privacidade" className="underline">Política de privacidade</Link>
        </p>
      </div>
    </main>
  );
}
