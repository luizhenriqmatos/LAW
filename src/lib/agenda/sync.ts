import type { ChamarRpc } from "@/lib/captura/job";
import { ErroGoogle } from "@/lib/integrations/google/erro";
import type { GoogleAgendaApi } from "@/lib/integrations/google/agenda-api";
import { cifrar, decifrar } from "@/lib/integrations/google/cripto";
import { idEvento, montarEvento, type ItemSync, type Origem } from "./evento";

/**
 * Sincronização em MÃO ÚNICA (LAW -> Google). Nunca lê nada do Google.
 * Cada mudança em tarefa/prazo/compromisso entra numa fila (gatilho no banco); aqui a fila é esvaziada.
 * Falha de uma conexão (token revogado) PARA só aquela conexão; as outras e o resto do LAW seguem.
 */
export type Renovar = (refreshToken: string) => Promise<{ accessToken: string; expiraEm: Date }>;

export type DepsSync = {
  rpc: ChamarRpc;
  api: GoogleAgendaApi;
  renovar: Renovar;
  chave: Buffer;
  urlBase: string;
  agora?: () => Date;
  limite?: number;
};

export type ResumoSync = {
  itens: number; criados: number; atualizados: number; apagados: number; ignorados: number;
  falhas: number; conexoesParadas: number;
};

type Conexao = {
  id: string; usuario_id: string; calendario_id: string;
  refresh_token_cifrado: string; access_token_cifrado: string | null; access_expira_em: string | null;
};
type FilaItem = { id: number; escritorio_id: string; origem: Origem; origem_id: string; versao: number };
type Mapa = { google_event_id: string; hash: string } | null;

const mensagem = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 280);

export async function processarFila(deps: DepsSync): Promise<ResumoSync> {
  const { rpc, api, renovar, chave } = deps;
  const agora = deps.agora ?? (() => new Date());
  const resumo: ResumoSync = { itens: 0, criados: 0, atualizados: 0, apagados: 0, ignorados: 0, falhas: 0, conexoesParadas: 0 };
  const paradas = new Set<string>();
  const tokens = new Map<string, string>(); // access token válido por conexão, nesta execução

  const fila = (await rpc<FilaItem[]>("sync_pegar_fila", { p_limite: deps.limite ?? 50 })) ?? [];

  async function tokenDe(c: Conexao, forcar = false): Promise<string> {
    if (!forcar) {
      const emCache = tokens.get(c.id);
      if (emCache) return emCache;
      if (c.access_token_cifrado && c.access_expira_em && new Date(c.access_expira_em).getTime() - agora().getTime() > 60_000) {
        const t = decifrar(c.access_token_cifrado, chave);
        tokens.set(c.id, t);
        return t;
      }
    }
    const novo = await renovar(decifrar(c.refresh_token_cifrado, chave));
    tokens.set(c.id, novo.accessToken);
    c.access_token_cifrado = cifrar(novo.accessToken, chave);
    c.access_expira_em = novo.expiraEm.toISOString();
    await rpc("sync_conexao_tokens", { p_conexao: c.id, p_access_cifrado: c.access_token_cifrado, p_expira: c.access_expira_em });
    return novo.accessToken;
  }

  /** Executa uma chamada ao Google; se o token de acesso for recusado (401), renova uma vez e repete. */
  async function comToken<T>(c: Conexao, fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await tokenDe(c));
    } catch (e) {
      if (e instanceof ErroGoogle && e.codigo === "nao_autorizado") return fn(await tokenDe(c, true));
      throw e;
    }
  }

  async function inserir(c: Conexao, origem: Origem, origemId: string, evento: ReturnType<typeof montarEvento>["evento"]): Promise<string> {
    // Gerações: se o id já existe e o evento apagado não pode ser reaproveitado, tenta o próximo id.
    for (let geracao = 0; geracao < 3; geracao++) {
      const id = idEvento(c.id, origem, origemId, geracao);
      try {
        await comToken(c, (t) => api.inserirEvento(t, c.calendario_id, id, evento));
        resumo.criados++;
        return id;
      } catch (e) {
        if (!(e instanceof ErroGoogle) || e.codigo !== "conflito") throw e;
        try {
          await comToken(c, (t) => api.atualizarEvento(t, c.calendario_id, id, evento)); // já existia (não duplica)
          resumo.atualizados++;
          return id;
        } catch (e2) {
          if (!(e2 instanceof ErroGoogle) || e2.codigo !== "nao_encontrado") throw e2;
        }
      }
    }
    throw new ErroGoogle("outro", "Não foi possível criar o evento no Google.");
  }

  async function sincronizarConexao(c: Conexao, item: ItemSync | null, origem: Origem, origemId: string) {
    const mapa = await rpc<Mapa>("sync_evento_obter", { p_conexao: c.id, p_origem: origem, p_origem_id: origemId });
    const deveExistir = !!item && item.ativo && item.usuarios.includes(c.usuario_id);

    if (!deveExistir) {
      if (mapa) {
        await comToken(c, (t) => api.apagarEvento(t, c.calendario_id, mapa.google_event_id));
        await rpc("sync_evento_remover", { p_conexao: c.id, p_origem: origem, p_origem_id: origemId });
        resumo.apagados++;
      }
      return;
    }

    const { evento, hash } = montarEvento(item, origemId, deps.urlBase);
    if (mapa && mapa.hash === hash) {
      resumo.ignorados++;
      return;
    }
    let eventId: string;
    if (mapa) {
      try {
        await comToken(c, (t) => api.atualizarEvento(t, c.calendario_id, mapa.google_event_id, evento));
        resumo.atualizados++;
        eventId = mapa.google_event_id;
      } catch (e) {
        if (!(e instanceof ErroGoogle) || e.codigo !== "nao_encontrado") throw e;
        eventId = await inserir(c, origem, origemId, evento); // alguém apagou no Google: recria, sem duplicar
      }
    } else {
      eventId = await inserir(c, origem, origemId, evento);
    }
    await rpc("sync_evento_salvar", { p_conexao: c.id, p_origem: origem, p_origem_id: origemId, p_event_id: eventId, p_hash: hash });
  }

  for (const f of fila) {
    resumo.itens++;
    let erro: string | null = null;
    try {
      const item = await rpc<ItemSync | null>("sync_item", { p_origem: f.origem, p_origem_id: f.origem_id });
      const conexoes = (await rpc<Conexao[]>("sync_conexoes", { p_escritorio: f.escritorio_id })) ?? [];
      for (const c of conexoes) {
        if (paradas.has(c.id)) continue;
        try {
          await sincronizarConexao(c, item, f.origem, f.origem_id);
          await rpc("sync_conexao_ok", { p_conexao: c.id });
        } catch (e) {
          if (e instanceof ErroGoogle && (e.codigo === "revogado" || e.codigo === "nao_autorizado")) {
            paradas.add(c.id);
            resumo.conexoesParadas++;
            await rpc("sync_conexao_falhou", { p_conexao: c.id, p_status: "revogada", p_erro: mensagem(e) });
          } else if (e instanceof ErroGoogle && e.codigo === "calendario_removido") {
            paradas.add(c.id);
            resumo.conexoesParadas++;
            await rpc("sync_conexao_falhou", { p_conexao: c.id, p_status: "erro", p_erro: "O calendário LAW foi apagado no Google." });
          } else {
            erro = mensagem(e); // temporário (limite, indisponível): a fila tenta de novo mais tarde
          }
        }
      }
    } catch (e) {
      erro = mensagem(e);
    }
    if (erro) resumo.falhas++;
    await rpc("sync_concluir", { p_fila: f.id, p_versao: f.versao, p_erro: erro });
  }
  return resumo;
}
