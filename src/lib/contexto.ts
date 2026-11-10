import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { criarClienteServidor } from "./supabase/servidor";
import { supabaseConfigurado } from "./supabase/config";
import { ehModulo, MODULOS, podeAcessar, type ModuloId } from "./modulos";

export const COOKIE_ESCRITORIO = "escritorio_atual";

export type Vinculo = {
  membroId: string;
  papel: "dono" | "membro";
  escritorioId: string;
  escritorioNome: string;
  modoMonitoramento: "oab" | "sociedade" | null;
  statusMonitoramento: string;
  ultimaCapturaOk: string | null;
  /** Fim dos 30 dias de encerramento (a conta está somente leitura até lá); null = conta normal. */
  encerramentoAte: string | null;
};

type LinhaMembro = {
  id: string;
  papel: "dono" | "membro";
  escritorio_id: string;
  escritorio: { nome: string; modo_monitoramento: "oab" | "sociedade" | null; status_monitoramento: string; ultima_captura_ok_em: string | null; encerramento_ate: string | null } | null;
};

/** Sessão + vínculos do usuário. Cacheado por requisição (layout e página não repetem consulta). */
export const obterContexto = cache(async () => {
  await connection(); // sempre por requisição: depende da sessão
  if (!supabaseConfigurado()) redirect("/configuracao-pendente");
  const supabase = await criarClienteServidor();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/entrar");

  const { data, error } = await supabase
    .from("membro")
    .select("id, papel, escritorio_id, escritorio:escritorio_id (nome, modo_monitoramento, status_monitoramento, ultima_captura_ok_em, encerramento_ate)")
    .eq("usuario_id", user.id)
    .order("criado_em");
  if (error) throw new Error("Não foi possível carregar seus escritórios.");

  const vinculos: Vinculo[] = ((data ?? []) as unknown as LinhaMembro[]).map((m) => ({
    membroId: m.id,
    papel: m.papel,
    escritorioId: m.escritorio_id,
    escritorioNome: m.escritorio?.nome ?? "",
    modoMonitoramento: m.escritorio?.modo_monitoramento ?? null,
    statusMonitoramento: m.escritorio?.status_monitoramento ?? "nao_configurado",
    ultimaCapturaOk: m.escritorio?.ultima_captura_ok_em ?? null,
    encerramentoAte: m.escritorio?.encerramento_ate ?? null,
  }));

  const escolhido = (await cookies()).get(COOKIE_ESCRITORIO)?.value;
  const vinculo = vinculos.find((v) => v.escritorioId === escolhido) ?? vinculos[0] ?? null;

  let modulos: ModuloId[] = [];
  if (vinculo) {
    const { data: mods, error: erroMods } = await supabase.rpc("meus_modulos", { p_escritorio: vinculo.escritorioId });
    if (erroMods) throw new Error("Não foi possível carregar suas permissões.");
    modulos = ((mods ?? []) as string[]).filter(ehModulo);
  }

  return { supabase, usuario: user, vinculos, vinculo, modulos };
});

/** Exige escritório; sem escritório, vai para o cadastro inicial. */
export async function exigirEscritorio() {
  const ctx = await obterContexto();
  if (!ctx.vinculo) redirect("/onboarding");
  return { ...ctx, vinculo: ctx.vinculo };
}

/** Camada 2 (rota): bloqueia a página se o módulo não estiver liberado. Mesma regra do menu. */
export async function exigirModulo(modulo: ModuloId) {
  const ctx = await exigirEscritorio();
  const rota = MODULOS.find((m) => m.id === modulo)!.rota;
  if (!podeAcessar(rota, ctx.modulos)) redirect(`/app/sem-acesso?modulo=${modulo}`);
  return ctx;
}

export async function exigirDono() {
  const ctx = await exigirEscritorio();
  if (ctx.vinculo.papel !== "dono") redirect("/app/sem-acesso?modulo=equipe");
  return ctx;
}
