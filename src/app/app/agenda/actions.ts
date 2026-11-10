"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { agendarSincronizacao } from "@/lib/agenda/ambiente";
import { localParaIso, diaValido } from "@/lib/agenda/calendario";
import { exigirModulo } from "@/lib/contexto";
import { caminhoSeguro, codigoDeErro } from "@/lib/erros";
import { chaveDoAmbiente, decifrar } from "@/lib/integrations/google/cripto";
import { revogarToken } from "@/lib/integrations/google/oauth";
import { rpcServico, servicoConfigurado } from "@/lib/supabase/servico";

const uuid = z.uuid();
const AGENDA = "/app/agenda";
const opcional = (s: z.ZodType<string>) => z.union([s, z.literal("")]).transform((v) => v || null);

function voltar(destino: string, aviso: string): never {
  revalidatePath("/app/agenda", "layout");
  revalidatePath("/app/tarefas", "layout");
  const seguro = caminhoSeguro(destino, AGENDA).replace(/([?&])aviso=[^&]*&?/g, "$1").replace(/[?&]$/, "");
  redirect(`${seguro}${seguro.includes("?") ? "&" : "?"}aviso=${encodeURIComponent(aviso)}`);
}

/** Muda (ou tira) a data da tarefa pela Agenda. É a MESMA data do cartão: aparece nos dois lugares. */
export async function mudarDataTarefa(id: string, dados: FormData) {
  const destino = String(dados.get("voltar") ?? AGENDA);
  const data = String(dados.get("data") ?? "");
  if (!uuid.safeParse(id).success || (data && !diaValido(data))) voltar(destino, "erro_dados_invalidos");
  const { supabase } = await exigirModulo("agenda");
  const { error } = await supabase.rpc("tarefa_atualizar", { p_tarefa: id, p_dados: { data: data || null } });
  if (!error) agendarSincronizacao();
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "tarefa_salva");
}

const esquemaCompromisso = z.object({
  titulo: z.string().trim().min(1).max(160),
  tipo: z.enum(["audiencia", "reuniao", "outro"]),
  inicio: z.string(),
  fim: z.string(),
  local: z.string().trim().max(200).default(""),
  descricao: z.string().max(4000).default(""),
  responsavel: opcional(uuid),
  processo: opcional(uuid),
});

export async function salvarCompromisso(id: string | null, dados: FormData) {
  const destino = String(dados.get("voltar") ?? AGENDA);
  const r = esquemaCompromisso.safeParse(Object.fromEntries(dados.entries()));
  const inicio = r.success ? localParaIso(r.data.inicio) : null;
  const fim = r.success ? localParaIso(r.data.fim) : null;
  if (!r.success || !inicio || !fim || fim < inicio || (id && !uuid.safeParse(id).success)) voltar(destino, "erro_dados_invalidos");
  const { supabase, vinculo } = await exigirModulo("agenda");
  const c = r.data;
  const { error } = id
    ? await supabase.rpc("compromisso_atualizar", {
        p_compromisso: id,
        p_dados: { titulo: c.titulo, tipo: c.tipo, inicio, fim, local: c.local, descricao: c.descricao, responsavel_id: c.responsavel, processo_id: c.processo },
      })
    : await supabase.rpc("compromisso_criar", {
        p_escritorio: vinculo.escritorioId, p_titulo: c.titulo, p_tipo: c.tipo, p_inicio: inicio, p_fim: fim, p_local: c.local,
        p_descricao: c.descricao, p_processo: c.processo, p_responsavel: c.responsavel,
      });
  if (!error) agendarSincronizacao();
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "compromisso_salvo");
}

export async function apagarCompromisso(id: string, dados: FormData) {
  const destino = String(dados.get("voltar") ?? AGENDA);
  if (!uuid.safeParse(id).success) voltar(destino, "erro_compromisso_invalido");
  const { supabase } = await exigirModulo("agenda");
  const { error } = await supabase.rpc("compromisso_apagar", { p_compromisso: id });
  if (!error) agendarSincronizacao();
  voltar(destino, error ? `erro_${codigoDeErro(error)}` : "compromisso_apagado");
}

/** Desconecta SÓ o Google do usuário. Pede ao Google para invalidar o token (melhor esforço) e apaga o que o LAW guardou. */
export async function desconectarGoogle() {
  const { usuario, vinculo } = await exigirModulo("agenda");
  if (servicoConfigurado()) {
    const rpc = rpcServico();
    const c = await rpc<{ refresh_token_cifrado: string } | null>("google_conexao_obter", { p_usuario: usuario.id, p_escritorio: vinculo.escritorioId });
    if (c) {
      try {
        await revogarToken(decifrar(c.refresh_token_cifrado, chaveDoAmbiente()));
      } catch {
        // sem chave ou token ilegível: segue e apaga a conexão mesmo assim
      }
      await rpc("google_conexao_remover", { p_usuario: usuario.id, p_escritorio: vinculo.escritorioId });
    }
  }
  voltar(AGENDA, "google_desconectado");
}
