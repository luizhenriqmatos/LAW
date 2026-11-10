import { MolduraEntrada } from "@/components/moldura-entrada";
import { exigirDono } from "@/lib/contexto";
import { FormularioMonitoramento } from "../formularios";

// A primeira captura roda no after() da ação desta página: dá tempo para ela terminar.
export const maxDuration = 300;

export default async function PaginaMonitoramento() {
  const { vinculo } = await exigirDono();
  return (
    <MolduraEntrada titulo="O que acompanhar" subtitulo={`Passo 2 de 2 · ${vinculo.escritorioNome}. Usamos isso para encontrar publicações e processos.`}>
      <FormularioMonitoramento />
    </MolduraEntrada>
  );
}
