import { ErroGoogle } from "@/lib/integrations/google/erro";
import { marcaDaPasta, nomePastaCliente, nomePastaProcesso } from "./nomes";
import { abrirSessao, obterConexao, type ConexaoDrive, type DepsDrive } from "./token";

/**
 * Sincronização LAW -> Drive das PASTAS (cliente e processo). Nunca apaga nada no Drive:
 * quando o cliente/processo deixa de valer (descartado, mesclado, desconectado), a pasta só é DESVINCULADA no banco
 * e continua intacta no Drive do escritório.
 */
export type ResumoDrive = {
  itens: number; criadas: number; renomeadas: number; movidas: number; desvinculadas: number; ignoradas: number;
  falhas: number; conexoesParadas: number;
};

type FilaItem = { id: number; escritorio_id: string; tipo: "cliente" | "processo"; ref_id: string; versao: number };
type ItemCliente = { escritorio_id: string; existe: boolean; nome: string };
type ItemProcesso = { escritorio_id: string; existe: boolean; numero_cnj: string | null; classe: string | null; cliente_principal: string | null };
type Pasta = { id: string; drive_id: string; nome: string; pai_drive_id: string };
type Pastas = { ativa: Pasta | null; antiga: Pasta | null };

const mensagem = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 280);

export async function processarFilaDrive(deps: DepsDrive & { limite?: number }): Promise<ResumoDrive> {
  const { rpc, api } = deps;
  const resumo: ResumoDrive = { itens: 0, criadas: 0, renomeadas: 0, movidas: 0, desvinculadas: 0, ignoradas: 0, falhas: 0, conexoesParadas: 0 };
  const paradas = new Set<string>();
  const sessoes = new Map<string, { c: ConexaoDrive; s: ReturnType<typeof abrirSessao> } | null>();

  async function sessaoDe(escritorioId: string) {
    if (!sessoes.has(escritorioId)) {
      const c = await obterConexao(rpc, escritorioId);
      sessoes.set(escritorioId, c && c.status === "ativa" ? { c, s: abrirSessao(deps, c) } : null);
    }
    return sessoes.get(escritorioId) ?? null;
  }

  const pastas = (tipo: string, ref: string) => rpc<Pastas>("drive_pasta_obter", { p_tipo: tipo, p_ref: ref });
  const desvincular = async (tipo: string, ref: string) => {
    await rpc("drive_pasta_desvincular", { p_tipo: tipo, p_ref: ref });
    resumo.desvinculadas++;
  };

  /** Garante a pasta no Drive com o nome e o pai certos. Cria, renomeia, move ou reaproveita; nunca apaga. */
  async function garantir(
    sessao: { c: ConexaoDrive; s: ReturnType<typeof abrirSessao> },
    tipo: "cliente" | "processo", ref: string, nome: string, paiId: string,
  ) {
    const { c, s } = sessao;
    const { ativa } = await pastas(tipo, ref);
    if (ativa) {
      try {
        if (ativa.pai_drive_id !== paiId) {
          await s.comToken((t) => api.mover(t, ativa.drive_id, paiId, ativa.pai_drive_id));
          resumo.movidas++;
        }
        if (ativa.nome !== nome) {
          await s.comToken((t) => api.renomear(t, ativa.drive_id, nome));
          resumo.renomeadas++;
        }
        if (ativa.pai_drive_id === paiId && ativa.nome === nome) resumo.ignoradas++;
        else await rpc("drive_pasta_salvar", { p_escritorio: c.escritorio_id, p_tipo: tipo, p_ref: ref, p_drive_id: ativa.drive_id, p_nome: nome, p_pai: paiId });
        return ativa.drive_id;
      } catch (e) {
        if (!(e instanceof ErroGoogle) || e.codigo !== "nao_encontrado") throw e;
        // Alguém apagou/moveu a pasta no Drive: o LAW só desvincula a antiga e cria de novo (sem duplicar).
        await desvincular(tipo, ref);
      }
    }
    const marca = marcaDaPasta(c.escritorio_id, tipo, ref);
    const existente = await s.comToken((t) => api.buscarPorMarca(t, marca)); // o LAW pode ter caído depois de criar e antes de gravar
    let id: string;
    if (existente) {
      id = existente.id;
      if (existente.name !== nome) await s.comToken((t) => api.renomear(t, id, nome));
      if (!existente.parents.includes(paiId)) {
        const antigo = existente.parents[0];
        if (antigo) await s.comToken((t) => api.mover(t, id, paiId, antigo));
      }
    } else {
      id = (await s.comToken((t) => api.criarPasta(t, nome, paiId, marca))).id;
      resumo.criadas++;
    }
    await rpc("drive_pasta_salvar", { p_escritorio: c.escritorio_id, p_tipo: tipo, p_ref: ref, p_drive_id: id, p_nome: nome, p_pai: paiId });
    return id;
  }

  async function cliente(sessao: NonNullable<Awaited<ReturnType<typeof sessaoDe>>>, ref: string) {
    const item = await rpc<ItemCliente | null>("drive_item", { p_tipo: "cliente", p_ref: ref });
    if (!item?.existe) return desvincular("cliente", ref).then(() => null);
    return garantir(sessao, "cliente", ref, nomePastaCliente(item.nome), sessao.c.clientes_id);
  }

  async function processo(sessao: NonNullable<Awaited<ReturnType<typeof sessaoDe>>>, ref: string) {
    const item = await rpc<ItemProcesso | null>("drive_item", { p_tipo: "processo", p_ref: ref });
    if (!item?.existe || !item.cliente_principal) return desvincular("processo", ref).then(() => null);
    // A pasta do processo mora dentro da do cliente principal; se ela ainda não existe, cria agora.
    const pai = await cliente(sessao, item.cliente_principal);
    if (!pai) return desvincular("processo", ref).then(() => null);
    return garantir(sessao, "processo", ref, nomePastaProcesso(item.numero_cnj, item.classe), pai);
  }

  const fila = (await rpc<FilaItem[]>("drive_pegar_fila", { p_limite: deps.limite ?? 50 })) ?? [];
  for (const f of fila) {
    resumo.itens++;
    let erro: string | null = null;
    try {
      const sessao = paradas.has(f.escritorio_id) ? null : await sessaoDe(f.escritorio_id);
      if (paradas.has(f.escritorio_id)) {
        erro = "Conexão com o Google Drive parada."; // volta quando o dono reconectar (a reconexão reenfileira tudo)
      } else if (sessao) {
        if (f.tipo === "cliente") await cliente(sessao, f.ref_id);
        else await processo(sessao, f.ref_id);
      } // sem conexão ativa: nada a fazer (reconectar reenfileira tudo)
    } catch (e) {
      if (e instanceof ErroGoogle && e.codigo === "revogado") {
        paradas.add(f.escritorio_id);
        resumo.conexoesParadas++;
        await rpc("drive_conexao_falhou", { p_escritorio: f.escritorio_id, p_status: "revogada", p_erro: mensagem(e) });
        erro = mensagem(e);
      } else {
        resumo.falhas++;
        erro = mensagem(e);
      }
    }
    await rpc("drive_concluir", { p_fila: f.id, p_versao: f.versao, p_erro: erro });
  }
  return resumo;
}
