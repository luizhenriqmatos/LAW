/**
 * Executa os alertas de prazo: descobre o que é devido (alertas.ts), reserva cada alerta no banco
 * (impede repetir), cria o aviso no app e manda o e-mail. Falha de e-mail nunca desfaz o aviso no app.
 */
import { dataBrasilia, somarDias } from "@/lib/integrations/fontes/datas";
import type { ChamarRpc } from "@/lib/captura/job";
import type { ServicoEmail } from "@/lib/integrations/email";
import { alertasDevidos, DIAS_ANTECEDENCIA, ROTULO_ALERTA, type AlertaEnviado, type TipoAlerta } from "./alertas";
import { AVISO_PRAZO } from "./contagem";

type Candidato = {
  prazo_id: string; escritorio_id: string; data_final: string; status: string; descricao: string; numero_cnj: string;
  usuario_id: string; responsavel_nome: string; responsavel_email: string | null;
  enviados: { tipo: TipoAlerta; data_ref: string }[];
};

export type ResumoAlertas = { analisados: number; enviados: number; emailsFalharam: number; semEmail: number };

export type DepsAlertas = {
  rpc: ChamarRpc;
  email: Pick<ServicoEmail, "enviarAviso">;
  agora?: () => Date;
  /** Endereço do app, para o link no e-mail. */
  urlBase?: string;
};

const br = (iso: string) => iso.split("-").reverse().join("/");

export async function executarAlertas(deps: DepsAlertas): Promise<ResumoAlertas> {
  const agora = deps.agora?.() ?? new Date();
  const hoje = dataBrasilia(agora);
  const resumo: ResumoAlertas = { analisados: 0, enviados: 0, emailsFalharam: 0, semEmail: 0 };

  const candidatos = await deps.rpc<Candidato[]>("alertas_candidatos", { p_ate: somarDias(hoje, DIAS_ANTECEDENCIA) });
  resumo.analisados = candidatos.length;
  const porId = new Map(candidatos.map((c) => [c.prazo_id, c]));
  const enviados: AlertaEnviado[] = candidatos.flatMap((c) => c.enviados.map((e) => ({ prazoId: c.prazo_id, tipo: e.tipo, dataRef: e.data_ref })));
  const devidos = alertasDevidos(candidatos.map((c) => ({ id: c.prazo_id, dataFinal: c.data_final, status: c.status })), enviados, agora);

  for (const d of devidos) {
    const c = porId.get(d.prazoId)!;
    const rotulo = ROTULO_ALERTA[d.tipo];
    const titulo = `Prazo ${rotulo}: ${c.descricao}`;
    const corpo = `Processo ${c.numero_cnj} · data final ${br(c.data_final)}. ${AVISO_PRAZO}`;
    const link = `/app/prazos?prazo=${c.prazo_id}`;
    const novo = await deps.rpc<boolean>("alerta_reservar", {
      p_prazo: d.prazoId, p_tipo: d.tipo, p_data_ref: d.dataRef, p_titulo: titulo, p_corpo: corpo, p_link: link,
    });
    if (!novo) continue; // outra execução já cuidou deste alerta
    resumo.enviados++;

    let status: "enviado" | "falhou" | "sem_email" = "sem_email";
    let erro: string | null = null;
    if (c.responsavel_email) {
      const texto = [
        `Olá, ${c.responsavel_nome || "tudo bem"}.`,
        "",
        titulo,
        corpo,
        "",
        deps.urlBase ? `Abrir no LAW: ${deps.urlBase.replace(/\/$/, "")}${link}` : "Abra o LAW para ver o prazo.",
      ].join("\n");
      try {
        const r = await deps.email.enviarAviso({ para: c.responsavel_email, assunto: `[LAW] ${titulo}`.slice(0, 150), texto });
        status = r.enviado ? "enviado" : "falhou";
        erro = r.enviado ? null : r.motivo;
      } catch (e) {
        status = "falhou";
        erro = e instanceof Error ? e.message : "erro ao enviar";
      }
    }
    if (status === "falhou") resumo.emailsFalharam++;
    if (status === "sem_email") resumo.semEmail++;
    await deps.rpc("alerta_marcar_email", { p_prazo: d.prazoId, p_tipo: d.tipo, p_data_ref: d.dataRef, p_status: status, p_erro: erro });
  }
  return resumo;
}
