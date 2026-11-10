/**
 * Registro das fontes jurídicas. O job de captura recebe a lista pronta daqui.
 *
 * Provedor pago (Judit, Escavador, Codilo…): implemente `FonteJuridica` num arquivo novo nesta pasta,
 * com capacidades { publicacoes: true } e/ou { processo: true }, e acrescente abaixo, ligado por variável de ambiente.
 * Nada no job precisa mudar.
 */
import { FonteDataJud } from "./datajud";
import { FonteDjen } from "./djen";
import { FonteExemplo } from "./exemplos";
import type { FonteJuridica } from "./tipos";

export type Fontes = { publicacoes: FonteJuridica[]; processos: FonteJuridica | null };

export function criarFontes(env: Record<string, string | undefined> = process.env): Fontes {
  const usarExemplos = env.DJEN_USAR_EXEMPLOS === "1" && env.NODE_ENV !== "production";
  return {
    publicacoes: [usarExemplos ? new FonteExemplo() : new FonteDjen()],
    processos: new FonteDataJud({ apiKey: env.DATAJUD_API_KEY }),
  };
}

export type { FonteJuridica, Publicacao, ProcessoMetadados, Movimentacao, FiltroPublicacoes } from "./tipos";
export { ErroFonte } from "./fila";
