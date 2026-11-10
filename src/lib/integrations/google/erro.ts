/**
 * Tipos de falha do Google que o LAW trata de forma diferente:
 *  - revogado: usuário revogou ou o token não vale mais -> PARA só essa conexão e avisa o usuário.
 *  - nao_autorizado: token de acesso recusado (401) -> tenta renovar uma vez.
 *  - calendario_removido: o calendário "LAW" foi apagado no Google -> para e pede reconexão.
 *  - limite / indisponivel: tenta de novo mais tarde (fila com espera crescente).
 *  - conflito (409): id de evento já existe -> o LAW atualiza em vez de criar de novo.
 *  - nao_encontrado: evento não existe mais no Google.
 */
export type CodigoErroGoogle =
  | "revogado" | "nao_autorizado" | "calendario_removido" | "limite" | "indisponivel" | "conflito" | "nao_encontrado" | "sem_refresh" | "outro";

export class ErroGoogle extends Error {
  constructor(readonly codigo: CodigoErroGoogle, mensagem: string) {
    super(mensagem);
    this.name = "ErroGoogle";
  }
}
