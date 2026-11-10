import { redirect } from "next/navigation";
import { MolduraEntrada } from "@/components/moldura-entrada";
import { obterContexto } from "@/lib/contexto";
import { FormularioEscritorio } from "./formularios";

export default async function PaginaOnboarding() {
  const { vinculo } = await obterContexto();
  if (vinculo) redirect(vinculo.modoMonitoramento ? "/app" : "/onboarding/monitoramento");
  return (
    <MolduraEntrada titulo="Seu escritório" subtitulo="Passo 1 de 2. Você será o dono da conta.">
      <FormularioEscritorio />
    </MolduraEntrada>
  );
}
