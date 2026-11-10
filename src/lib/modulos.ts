/**
 * Módulos (telas) controlados por permissão. Manter igual a public.modulos_validos() no banco.
 * Menu e guarda de rota usam as MESMAS funções daqui, para as três camadas baterem.
 */
export const MODULOS = [
  { id: "agenda", rotulo: "Agenda", rota: "/app/agenda" },
  { id: "processos", rotulo: "Processos", rota: "/app/processos" },
  { id: "prazos", rotulo: "Prazos", rota: "/app/prazos" },
  { id: "tarefas", rotulo: "Tarefas", rota: "/app/tarefas" },
  { id: "financeiro", rotulo: "Financeiro", rota: "/app/financeiro" },
  { id: "calculos", rotulo: "Cálculos", rota: "/app/calculos" },
  { id: "documentos", rotulo: "Documentos", rota: "/app/documentos" },
  { id: "portal_cliente", rotulo: "Portal do cliente", rota: "/app/portal-cliente" },
  { id: "assinaturas", rotulo: "Assinaturas", rota: "/app/assinaturas" },
  { id: "assistente", rotulo: "Lia (assistente)", rota: "/app/assistente" },
  { id: "atendimento", rotulo: "Atendimentos", rota: "/app/atendimentos" },
  { id: "configuracoes", rotulo: "Configurações", rota: "/app/configuracoes" },
] as const;

export type ModuloId = (typeof MODULOS)[number]["id"];

export const IDS_MODULOS: ModuloId[] = MODULOS.map((m) => m.id);

export function ehModulo(valor: string): valor is ModuloId {
  return (IDS_MODULOS as string[]).includes(valor);
}

/** Qual módulo protege esta rota (null = rota livre para qualquer membro, ex.: /app). */
export function moduloDaRota(caminho: string): ModuloId | null {
  const limpo = caminho.split("?")[0].replace(/\/+$/, "");
  for (const m of MODULOS) {
    if (limpo === m.rota || limpo.startsWith(m.rota + "/")) return m.id;
  }
  return null;
}

/** Camada 2 (rota): a rota pode ser aberta com estes módulos? */
export function podeAcessar(caminho: string, modulos: readonly string[]): boolean {
  const modulo = moduloDaRota(caminho);
  return modulo === null || modulos.includes(modulo);
}

/** Camada 1 (menu): itens visíveis, na ordem padrão. */
export function itensDoMenu(modulos: readonly string[]) {
  return MODULOS.filter((m) => modulos.includes(m.id));
}
