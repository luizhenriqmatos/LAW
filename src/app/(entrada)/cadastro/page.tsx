import { MolduraEntrada } from "@/components/moldura-entrada";
import { caminhoSeguro } from "@/lib/erros";
import { FormularioCadastro } from "../formularios-entrada";

export default async function PaginaCadastro({ searchParams }: PageProps<"/cadastro">) {
  const sp = await searchParams;
  const proximo = caminhoSeguro(typeof sp.proximo === "string" ? sp.proximo : null, "/onboarding");
  return (
    <MolduraEntrada titulo="Criar conta" subtitulo="Depois você cadastra o escritório e a sua OAB.">
      <FormularioCadastro proximo={proximo} />
    </MolduraEntrada>
  );
}
