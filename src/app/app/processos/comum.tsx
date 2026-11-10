import { mensagemDeErro } from "@/lib/erros";
import { cn } from "@/lib/utils";

export { formatarCnj } from "@/lib/integrations/fontes/cnj";

const AVISOS_OK: Record<string, string> = {
  processos_confirmados: "Processos confirmados.",
  processo_confirmado: "Processo confirmado. As publicações dele já estão na linha do tempo — crie os prazos em “Criar prazo”.",
  processo_descartado_ok: "Processo descartado. Dá para restaurar por 30 dias.",
  clientes_confirmados: "Clientes confirmados.",
  cliente_confirmado: "Cliente confirmado.",
  cliente_renomeado: "Nome atualizado. A pasta no Drive será renomeada em instantes.",
  cliente_mesclado: "Clientes mesclados.",
  publicacao_ligada: "Publicação ligada ao processo.",
  descartado: "Descartado. Dá para restaurar por 30 dias.",
  restaurado: "Restaurado.",
  prazo_criado: "Prazo criado. Você e o responsável serão avisados 3 dias antes, no dia e a cada dia depois do vencimento.",
  prazo_atualizado: "Prazo atualizado.",
  sem_prazo: "Ok, essa publicação não gera prazo.",
  calendario_salvo: "Calendário atualizado.",
  avisos_lidos: "Avisos marcados como lidos.",
  tarefa_criada: "Tarefa criada.",
  tarefa_salva: "Tarefa salva.",
  tarefa_apagada: "Tarefa apagada.",
  comentario_ok: "Comentário adicionado.",
  colunas_salvas: "Colunas atualizadas.",
  compromisso_salvo: "Compromisso salvo.",
  compromisso_apagado: "Compromisso apagado.",
  google_conectado: "Google Agenda conectado. O calendário “LAW” foi criado e seus itens já estão subindo.",
  drive_conectado: "Google Drive conectado. A pasta “LAW” foi criada e as pastas dos clientes e processos já estão sendo montadas.",
  drive_desconectado_ok: "Google Drive desconectado. Nada foi apagado no Drive: as pastas e os arquivos continuam lá. Só deixaram de ser acompanhados pelo LAW.",
  lancamento_criado: "Lançamento criado com as parcelas.",
  pagamento_registrado: "Pagamento registrado.",
  pagamento_estornado: "Pagamento estornado. O saldo voltou.",
  parcela_cancelada_ok: "Parcela cancelada.",
  lancamento_cancelado: "Lançamento cancelado.",
  vencimento_alterado: "Vencimento alterado.",
  arquivo_enviado: "Arquivo enviado para o Drive.",
  calculo_salvo: "Cálculo salvo.",
  calculo_atualizado: "Cálculo recalculado e salvo.",
  calculo_duplicado: "Cópia criada. Ajuste o que precisar e salve.",
  calculo_excluido: "Cálculo excluído.",
  pdf_no_drive: "PDF salvo na pasta do processo no Google Drive.",
  regime_criado: "Regime criado.",
  regime_versionado: "Nova versão criada. Os cálculos que usaram a versão anterior continuam iguais.",
  regime_arquivado: "Regime arquivado. Os cálculos que o usaram continuam iguais.",
  indices_atualizados: "Índices atualizados com o Banco Central.",
  indices_parciais: "Algumas séries não responderam. Veja a coluna de erro abaixo.",
  google_desconectado: "Google Agenda desconectado. Os eventos já enviados continuam no seu calendário “LAW”, mas não serão mais atualizados.",
};

/** Mostra o resultado da última ação (código vindo da URL; texto sempre nosso). */
export function Aviso({ codigo }: { codigo?: string | string[] }) {
  const c = typeof codigo === "string" ? codigo : undefined;
  if (!c) return null;
  const ok = AVISOS_OK[c];
  const texto = ok ?? mensagemDeErro(c.replace(/^erro_/, ""));
  return (
    <p role={ok ? "status" : "alert"} className={cn("mt-4 rounded-xl px-4 py-3 text-sm font-medium", ok ? "bg-accent text-accent-foreground" : "bg-red-50 text-red-700")}>
      {texto}
    </p>
  );
}

export function Selo({ tipo }: { tipo: "provisorio" | "confirmado" | "descartado" | "segredo" | "mesclado" }) {
  const estilos = {
    provisorio: "bg-amber-100 text-amber-900 ring-amber-300",
    confirmado: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    descartado: "bg-neutral-100 text-neutral-600 ring-neutral-300",
    mesclado: "bg-neutral-100 text-neutral-600 ring-neutral-300",
    segredo: "bg-red-50 text-red-800 ring-red-200",
  } as const;
  const rotulos = {
    provisorio: "Provisório",
    confirmado: "Confirmado",
    descartado: "Descartado",
    mesclado: "Mesclado",
    segredo: "Segredo de justiça",
  } as const;
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1", estilos[tipo])}>
      {rotulos[tipo]}
    </span>
  );
}

/** "2026-11-09" ou ISO completo → "09/11/2026". */
export function formatarData(valor: string | null | undefined): string {
  if (!valor) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(valor);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : valor;
}

export const POLOS: Record<string, string> = { ativo: "Autor", passivo: "Réu", terceiro: "Terceiro", outro: "Parte" };

/** Data a partir da qual um descarte ainda pode ser restaurado (30 dias atrás). */
export function inicioLixeira(agora = new Date()): string {
  return new Date(agora.getTime() - 30 * 86_400_000).toISOString();
}

/** Dias que faltam para não dar mais para restaurar. */
export function diasParaExpirar(descartadoEm: string, agora = new Date()): number {
  const limite = new Date(descartadoEm).getTime() + 30 * 86_400_000;
  return Math.max(0, Math.ceil((limite - agora.getTime()) / 86_400_000));
}

export const botaoPequeno =
  "inline-flex h-8 items-center rounded-full px-3 text-xs font-semibold transition-colors disabled:opacity-50";
