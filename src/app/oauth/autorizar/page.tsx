import { redirect } from "next/navigation";
import { Marca } from "@/components/marca";
import { NOME_ASSISTENTE } from "@/lib/assistente/nome";
import { ESCOPOS, recursoMcp, TODOS_ESCOPOS, urlBase, type Escopo } from "@/lib/oauth/config";
import { supabaseConfigurado } from "@/lib/supabase/config";
import { criarClienteServidor } from "@/lib/supabase/servidor";
import { aprovarAcesso, negarAcesso } from "./actions";

export const dynamic = "force-dynamic";

const ERROS: Record<string, string> = {
  pedido_invalido: "O pedido de conexão veio incompleto. Tente conectar de novo pelo assistente.",
  cliente_invalido: "Este aplicativo não está registrado no LAW ou o endereço de retorno não confere.",
  nao_configurado: "A conexão com assistentes externos ainda não foi ativada neste LAW.",
  sem_permissao: `Você não tem acesso à ${NOME_ASSISTENTE} (assistente de IA) neste escritório. Peça ao dono para liberar a tela "${NOME_ASSISTENTE}".`,
  conectores_desligados: "O dono do escritório desligou as conexões com assistentes externos (tela Conexões).",
  escopo_invalido: "Este aplicativo não pode receber nenhum dos acessos pedidos.",
  pkce_invalido: "O pedido não trouxe a proteção PKCE exigida.",
};

function Caixa({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid min-h-dvh max-w-lg content-center gap-6 p-6">
      <Marca href="/app" />
      <section className="rounded-[26px] bg-white p-6">{children}</section>
    </main>
  );
}

type Sp = Record<string, string | string[] | undefined>;
const um = (sp: Sp, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");

function voltarComErro(redirectUri: string, erro: string, descricao: string, state: string, base: string): never {
  const u = new URL(redirectUri);
  u.searchParams.set("error", erro);
  u.searchParams.set("error_description", descricao);
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", base);
  redirect(u.toString());
}

/** Tela de consentimento do OAuth 2.1: "Claude quer acessar sua conta do LAW". */
export default async function PaginaAutorizar({ searchParams }: PageProps<"/oauth/autorizar">) {
  const sp = await searchParams;
  const base = urlBase();
  if (!base || !supabaseConfigurado()) return <Caixa><p>{ERROS.nao_configurado}</p></Caixa>;
  const supabase = await criarClienteServidor();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    const volta = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
    redirect(`/entrar?proximo=${encodeURIComponent(`/oauth/autorizar?${volta.toString()}`)}`);
  }

  const clientId = um(sp, "client_id");
  const redirectUri = um(sp, "redirect_uri");
  const state = um(sp, "state");
  const { data: c } = clientId ? await supabase.rpc("oauth_cliente_publico", { p_cliente: clientId }) : { data: null };
  const cliente = c as { nome: string; perfil: string; perfil_nome: string; redirect_uris: string[]; escopos_permitidos: Escopo[] } | null;
  // Cliente ou endereço de retorno inválido: NUNCA redireciona (evita redirecionamento aberto).
  if (!cliente || !cliente.redirect_uris.includes(redirectUri)) return <Caixa><p className="text-red-700">{ERROS.cliente_invalido}</p></Caixa>;

  if (um(sp, "response_type") !== "code") voltarComErro(redirectUri, "unsupported_response_type", "Só response_type=code.", state, base);
  if (!/^[A-Za-z0-9_-]{43}$/.test(um(sp, "code_challenge")) || um(sp, "code_challenge_method") !== "S256") {
    voltarComErro(redirectUri, "invalid_request", "PKCE com S256 é obrigatório.", state, base);
  }
  const recurso = um(sp, "resource").replace(/\/+$/, "");
  if (recurso && recurso !== recursoMcp(base)) voltarComErro(redirectUri, "invalid_target", "Recurso desconhecido.", state, base);

  const pedidos = um(sp, "scope").split(/\s+/).filter(Boolean);
  const alvo = pedidos.length ? pedidos : cliente.escopos_permitidos;
  const concedidos = TODOS_ESCOPOS.filter((e) => alvo.includes(e) && cliente.escopos_permitidos.includes(e));
  const negados = alvo.filter((e) => (TODOS_ESCOPOS as string[]).includes(e) && !cliente.escopos_permitidos.includes(e as Escopo));

  const { data: vinculos } = await supabase.from("membro").select("escritorio_id, escritorio:escritorio_id (nome)").eq("usuario_id", user.id).order("criado_em");
  const escritorios = ((vinculos ?? []) as unknown as { escritorio_id: string; escritorio: { nome: string } | null }[]).map((v) => ({ id: v.escritorio_id, nome: v.escritorio?.nome ?? "" }));
  const erro = um(sp, "erro");
  const oculto = (nome: string, valor: string) => <input type="hidden" name={nome} value={valor} />;

  return (
    <Caixa>
      <h1 className="text-2xl font-medium tracking-tight"><strong>{cliente.nome}</strong> quer acessar sua conta do LAW</h1>
      <p className="mt-2 text-sm text-muted-foreground">Aplicativo: {cliente.perfil_nome}. Conectado como {user.email}.</p>
      {erro ? <p role="alert" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{ERROS[erro] ?? "Não foi possível autorizar. Tente de novo."}</p> : null}
      {concedidos.length === 0 ? <p className="mt-4 text-sm text-red-700">{ERROS.escopo_invalido}</p> : (
        <form action={aprovarAcesso} className="mt-5 grid gap-4 text-sm">
          {oculto("client_id", clientId)}{oculto("redirect_uri", redirectUri)}{oculto("state", state)}
          {oculto("code_challenge", um(sp, "code_challenge"))}{oculto("resource", recurso)}
          {oculto("response_type", "code")}{oculto("code_challenge_method", "S256")}{oculto("scope", alvo.join(" "))}
          <label className="grid gap-1">
            <span className="font-medium">Escritório</span>
            <select name="escritorio" className="h-10 rounded-xl border bg-white px-3">
              {escritorios.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
            </select>
          </label>
          <fieldset className="grid gap-2">
            <legend className="mb-1 font-medium">O que ele poderá fazer</legend>
            {concedidos.map((e) => (
              <label key={e} className="flex items-start gap-2 rounded-xl bg-muted/50 p-3">
                <input type="checkbox" name="escopo" value={e} defaultChecked disabled={e === "law.read"} className="mt-1" />
                {e === "law.read" ? <input type="hidden" name="escopo" value="law.read" /> : null}
                <span><strong>{e === "law.read" ? "Ler" : "Criar"}</strong> — {ESCOPOS[e]}</span>
              </label>
            ))}
            {negados.length ? <p className="text-xs text-muted-foreground">Não liberado para este aplicativo: {negados.map((n) => (n === "law.write" ? "criar/gravar" : n)).join(", ")}.</p> : null}
          </fieldset>
          <ul className="grid gap-1 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-950">
            <li>O aplicativo vê <strong>só o que você pode ver</strong> no LAW, com as suas permissões.</li>
            <li>Os dados consultados são enviados ao provedor do assistente ({cliente.perfil_nome}).</li>
            <li>Processos em segredo de justiça só aparecem se o dono do escritório permitir.</li>
            {concedidos.includes("law.write") ? <li>Para gravar, o assistente pede a sua aprovação a cada vez. Tudo fica no histórico de auditoria.</li> : null}
            <li>Você pode cortar o acesso quando quiser em <strong>Conexões</strong>.</li>
          </ul>
          <div className="flex gap-2">
            <button className="h-10 rounded-full bg-primary px-5 font-medium text-primary-foreground">Permitir</button>
            <button formAction={negarAcesso} className="h-10 rounded-full bg-muted px-5 font-medium">Cancelar</button>
          </div>
        </form>
      )}
    </Caixa>
  );
}
