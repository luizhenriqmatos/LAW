import { exigirDono } from "@/lib/contexto";
import { MODULOS } from "@/lib/modulos";
import { cancelarConvite, removerMembro } from "./actions";
import { FormularioConvite, FormularioPermissoes } from "./formularios";

type Membro = { id: string; papel: "dono" | "membro"; email: string; nome: string };
type Permissao = { membro_id: string; modulo: string };
type Convite = { id: string; email: string; modulos: string[]; expira_em: string };

export default async function Equipe() {
  const { supabase, vinculo } = await exigirDono();
  const [membros, permissoes, convites] = await Promise.all([
    supabase.from("membro").select("id, papel, email, nome").eq("escritorio_id", vinculo.escritorioId).order("criado_em"),
    supabase.from("permissao_tela").select("membro_id, modulo").eq("escritorio_id", vinculo.escritorioId),
    supabase
      .from("convite")
      .select("id, email, modulos, expira_em")
      .eq("escritorio_id", vinculo.escritorioId)
      .is("aceito_em", null)
      .is("cancelado_em", null)
      .gt("expira_em", new Date().toISOString())
      .order("criado_em", { ascending: false }),
  ]);

  const porMembro = new Map<string, string[]>();
  for (const p of (permissoes.data ?? []) as Permissao[]) porMembro.set(p.membro_id, [...(porMembro.get(p.membro_id) ?? []), p.modulo]);
  const rotulo = (id: string) => MODULOS.find((m) => m.id === id)?.rotulo ?? id;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-5xl font-medium tracking-tight">Equipe e permissões</h1>
      <p className="mt-2 text-muted-foreground">Cada pessoa só vê as telas marcadas. O bloqueio vale no menu, no endereço da página e no banco de dados.</p>

      <section className="mt-8 grid gap-3">
        {((membros.data ?? []) as Membro[]).map((m) => (
          <article key={m.id} className="rounded-[26px] bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold">{m.nome || m.email}</p>
                <p className="text-xs text-muted-foreground">{m.email}</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${m.papel === "dono" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                {m.papel === "dono" ? "Dono · vê tudo" : `${porMembro.get(m.id)?.length ?? 0} de ${MODULOS.length} telas`}
              </span>
            </div>
            {m.papel === "membro" ? (
              <>
                <FormularioPermissoes membroId={m.id} marcados={porMembro.get(m.id) ?? []} />
                <form action={removerMembro} className="mt-2">
                  <input type="hidden" name="membro" value={m.id} />
                  <button className="text-xs font-semibold text-red-700 underline">Remover da equipe</button>
                </form>
              </>
            ) : null}
          </article>
        ))}
      </section>

      <section className="mt-10 grid gap-3 rounded-[26px] bg-muted p-5">
        <h2 className="text-xl font-semibold">Convidar pessoa</h2>
        <FormularioConvite />
      </section>

      {(convites.data ?? []).length ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Convites pendentes</h2>
          <ul className="mt-3 grid gap-2">
            {((convites.data ?? []) as Convite[]).map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-white px-4 py-3 text-sm">
                <span className="font-medium">{c.email}</span>
                <span className="text-muted-foreground">{c.modulos.map(rotulo).join(", ") || "nenhuma tela"}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  vence {new Date(c.expira_em).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}
                </span>
                <form action={cancelarConvite}>
                  <input type="hidden" name="id" value={c.id} />
                  <button className="text-xs font-semibold underline">Cancelar</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
