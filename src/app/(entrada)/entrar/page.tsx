import { MolduraEntrada } from "@/components/moldura-entrada";
import { caminhoSeguro, ERROS_DE_LINK } from "@/lib/erros";
import { FormularioEntrar } from "../formularios-entrada";

export default async function PaginaEntrar({ searchParams }: PageProps<"/entrar">) {
  const sp = await searchParams;
  const proximo = caminhoSeguro(typeof sp.proximo === "string" ? sp.proximo : null);
  const erroLink = typeof sp.erro === "string" ? (ERROS_DE_LINK[sp.erro] ?? null) : null;
  return (
    <MolduraEntrada titulo="Entrar" subtitulo="Bom te ver de novo.">
      {erroLink ? (
        <p role="alert" className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {erroLink}
        </p>
      ) : null}
      <FormularioEntrar proximo={proximo} />
    </MolduraEntrada>
  );
}
