import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import type { ChamarRpc } from "@/lib/captura/job";
import { concluirConexao } from "@/lib/agenda/conectar";
import { processarFila, type DepsSync } from "@/lib/agenda/sync";
import { decifrar } from "@/lib/integrations/google/cripto";
import { comoUsuario, criarBanco, criarUsuario, rpcComoServico } from "./banco";
import { GoogleFalso } from "../fake-google";

const ANA = "00000000-0000-4000-8000-0000000000b1"; // dona
const BIA = "00000000-0000-4000-8000-0000000000b2"; // membro (tarefas, agenda, prazos)
const URL_BASE = "https://law.exemplo.com.br";

let db: PGlite;
let esc: string;
let membro: Record<string, string>;
let proc: string;
let procSigilo: string;
let colunas: string[];
const google = new GoogleFalso();
const chave = randomBytes(32);

const chamar = (uid: string, sql: string, p: unknown[] = []) => comoUsuario(db, uid, (tx) => tx.query(sql, p));
const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const rpcUser = async <T,>(uid: string, sql: string, p: unknown[] = []) => ((await chamar(uid, sql, p)).rows[0] as { r: T }).r;

/** Como o Supabase: função que devolve tabela vira lista JSON. */
const rpcServ: ChamarRpc = async (funcao, args) => {
  if (funcao === "sync_pegar_fila") {
    return db.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      return (await tx.query<{ r: unknown }>("select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) r from public.sync_pegar_fila(p_limite => $1) t", [args.p_limite])).rows[0].r as never;
    });
  }
  return rpcComoServico(db)(funcao, args);
};

const deps = (): DepsSync => ({ rpc: rpcServ, api: google, renovar: google.renovar, chave, urlBase: URL_BASE });
const rodar = () => processarFila(deps());

async function conectar(usuario: string, refresh: string, nomeCalendario = "LAW") {
  await concluirConexao({
    rpc: rpcServ, api: google, chave, escritorioId: esc, usuarioId: usuario, nomeCalendario,
    tokens: { accessToken: `acc-${refresh}-0`, refreshToken: refresh, expiraEm: new Date(Date.now() + 3600_000), escopo: "calendar.app.created" },
  });
}
const novaTarefa = (uid: string, titulo: string, o: { resp?: string | null; data?: string | null; proc?: string | null } = {}) =>
  rpcUser<string>(uid, "select public.tarefa_criar($1, null, $2, 'Detalhe interno', $3, $4, $5, null, '{}') as r", [esc, titulo, o.resp ?? null, o.data ?? null, o.proc ?? null]);
const eventosDe = (dono: string) => google.eventosDe(dono);
const resumos = (e: { summary: string }[]) => e.map((x) => x.summary).sort();

beforeAll(async () => {
  db = await criarBanco();
  await criarUsuario(db, ANA, "ana@t.com");
  await criarUsuario(db, BIA, "bia@t.com");
  esc = await rpcUser<string>(ANA, "select public.criar_escritorio('Prado Advocacia', null, 'equipe') as r");
  const token = await rpcUser<string>(ANA, "select public.criar_convite($1, 'bia@t.com', '{tarefas,agenda,prazos}'::text[]) as r", [esc]);
  await chamar(BIA, "select public.aceitar_convite($1)", [token]);
  membro = {
    ana: (await um<{ id: string }>("select id from public.membro where usuario_id = $1", [ANA])).id,
    bia: (await um<{ id: string }>("select id from public.membro where usuario_id = $1", [BIA])).id,
  };
  proc = (await um<{ id: string }>("insert into public.processo (escritorio_id, numero_cnj, status, confirmado_em) values ($1, '00000011220268050001', 'confirmado', now()) returning id", [esc])).id;
  procSigilo = (await um<{ id: string }>("insert into public.processo (escritorio_id, numero_cnj, status, confirmado_em, segredo_justica) values ($1, '00000022320268050001', 'confirmado', now(), true) returning id", [esc])).id;
  colunas = (await db.query<{ id: string }>("select id from public.quadro_coluna where escritorio_id = $1 order by posicao", [esc])).rows.map((c) => c.id);
});

describe("Conexão com o Google", () => {
  it("cria o calendário “LAW” no Google do usuário e guarda os tokens CIFRADOS", async () => {
    await conectar(ANA, "ana");
    await conectar(BIA, "bia");
    expect([...google.calendarios.values()].map((c) => [c.dono, c.nome])).toEqual([["ana", "LAW"], ["bia", "LAW"]]);
    const c = await um<{ refresh_token_cifrado: string; access_token_cifrado: string; status: string; calendario_nome: string }>(
      "select refresh_token_cifrado, access_token_cifrado, status, calendario_nome from public.google_conexao where usuario_id = $1", [ANA]);
    expect(c.status).toBe("ativa");
    expect(c.calendario_nome).toBe("LAW");
    expect(c.refresh_token_cifrado).not.toContain("ana");
    expect(c.refresh_token_cifrado.startsWith("v1:")).toBe(true);
    expect(decifrar(c.refresh_token_cifrado, chave)).toBe("ana");
    const st = await rpcUser<Record<string, unknown>>(ANA, "select public.google_status($1) as r", [esc]);
    expect(st).toMatchObject({ conectado: true, status: "ativa", calendario: "LAW" });
    expect(JSON.stringify(st)).not.toContain("v1:");
  });

  it("reconectar reaproveita o mesmo calendário (não cria outro “LAW”)", async () => {
    const antes = google.calendarios.size;
    await conectar(ANA, "ana");
    expect(google.calendarios.size).toBe(antes);
    expect((await um<{ n: number }>("select count(*)::int n from public.google_conexao where usuario_id = $1", [ANA])).n).toBe(1);
  });
});

describe("Sincronização LAW -> Google", () => {
  it("tarefa com data aparece no calendário LAW de quem é responsável, só dele", async () => {
    await novaTarefa(ANA, "Protocolar recurso", { resp: membro.ana, data: "2026-11-20", proc });
    const r = await rodar();
    expect(r.criados).toBe(1);
    const evs = eventosDe("ana");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ summary: "Protocolar recurso", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } });
    expect(evs[0].description).toContain("Detalhe interno");
    expect(evs[0].description).toContain("0000001-12.2026.8.05.0001"); // CNJ formatado
    expect(evs[0].description).toContain(`${URL_BASE}/app/tarefas/`);
    expect(eventosDe("bia")).toHaveLength(0);
  });

  it("rodar de novo não duplica nem chama o Google à toa", async () => {
    const antes = google.chamadas.length;
    const r = await rodar();
    expect(r.itens).toBe(0);
    expect(google.chamadas.length).toBe(antes);
    expect(google.total()).toBe(1);
  });

  it("editar atualiza o MESMO evento; mudar a data move; mover para Feito põe ✔", async () => {
    const id = (await um<{ id: string }>("select id from public.tarefa where titulo = 'Protocolar recurso'")).id;
    await chamar(ANA, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ titulo: "Protocolar recurso especial" })]);
    const r = await rodar();
    expect(r).toMatchObject({ atualizados: 1, criados: 0 });
    expect(resumos(eventosDe("ana"))).toEqual(["Protocolar recurso especial"]);

    await chamar(ANA, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ data: "2026-11-23" })]);
    await rodar();
    expect(eventosDe("ana")[0].start).toEqual({ date: "2026-11-23" });

    await chamar(ANA, "select public.mover_tarefa($1, $2, 0)", [id, colunas[3]]);
    await rodar();
    expect(resumos(eventosDe("ana"))).toEqual(["✔ Protocolar recurso especial"]);
    expect(google.total()).toBe(1);
  });

  it("trocar o responsável tira do calendário de um e põe no do outro", async () => {
    const id = (await um<{ id: string }>("select id from public.tarefa where titulo = 'Protocolar recurso especial'")).id;
    await chamar(ANA, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ responsavel_id: membro.bia })]);
    await rodar();
    expect(eventosDe("ana")).toHaveLength(0);
    expect(eventosDe("bia")).toHaveLength(1);
  });

  it("apagar a tarefa (ou tirar a data) apaga o evento e o vínculo", async () => {
    const id = (await um<{ id: string }>("select id from public.tarefa where titulo = 'Protocolar recurso especial'")).id;
    await chamar(ANA, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ data: null })]);
    await rodar();
    expect(google.total()).toBe(0);
    expect((await um<{ n: number }>("select count(*)::int n from public.google_evento where origem_id = $1", [id])).n).toBe(0);
    await chamar(ANA, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ data: "2026-11-24" })]);
    await rodar();
    expect(google.total()).toBe(1); // volta a existir, sem duplicar
    await rpcUser(ANA, "select public.apagar_tarefa($1) as r", [id]);
    await rodar();
    expect(google.total()).toBe(0);
    expect((await um<{ n: number }>("select count(*)::int n from public.google_evento")).n).toBe(0);
  });

  it("tarefa sem responsável vai para quem criou", async () => {
    const id = await novaTarefa(ANA, "Sem dono definido", { data: "2026-11-25" });
    await rodar();
    expect(resumos(eventosDe("ana"))).toEqual(["Sem dono definido"]);
    await rpcUser(ANA, "select public.apagar_tarefa($1) as r", [id]);
    await rodar();
  });

  it("prazo aberto vira evento de dia inteiro com o aviso de sugestão; cumprido sai do Google", async () => {
    const pz = (await um<{ id: string }>(
      `insert into public.prazo (escritorio_id, processo_id, descricao, dias, tipo_contagem, responsavel_id, data_disponibilizacao, data_publicacao, inicio_contagem, data_final, raciocinio)
       values ($1, $2, 'Contestar', 15, 'util', $3, '2026-10-20', '2026-10-21', '2026-10-22', '2026-11-13', '{}') returning id`, [esc, proc, membro.bia])).id;
    await rodar();
    const ev = eventosDe("bia")[0];
    expect(ev.summary).toBe("Prazo: Contestar");
    expect(ev.start).toEqual({ date: "2026-11-13" });
    expect(ev.description).toContain("Prazo sugerido. Confira no sistema oficial do tribunal.");
    await chamar(BIA, "select public.alterar_status_prazo($1, 'cumprido')", [pz]);
    await rodar();
    expect(eventosDe("bia")).toHaveLength(0);
  });

  it("compromisso vai com hora e fuso de Brasília; apagar tira do Google", async () => {
    const id = await rpcUser<string>(BIA, "select public.compromisso_criar($1, 'Instrução', 'audiencia', '2026-11-30T17:00:00Z', '2026-11-30T18:30:00Z', 'Fórum de Salvador', '', $2, $3) as r", [esc, proc, membro.bia]);
    await rodar();
    const ev = eventosDe("bia")[0];
    expect(ev).toMatchObject({ summary: "Audiência: Instrução", location: "Fórum de Salvador", start: { dateTime: "2026-11-30T17:00:00.000Z", timeZone: "America/Sao_Paulo" } });
    await chamar(BIA, "select public.compromisso_apagar($1)", [id]);
    await rodar();
    expect(eventosDe("bia")).toHaveLength(0);
  });

  it("segredo de justiça: nada do conteúdo real sai do LAW", async () => {
    await novaTarefa(ANA, "Estratégia do caso sigiloso", { resp: membro.ana, data: "2026-12-02", proc: procSigilo });
    await rodar();
    const ev = eventosDe("ana")[0];
    expect(ev.summary).toBe("LAW: item restrito");
    expect(JSON.stringify(ev)).not.toContain("sigiloso");
    expect(JSON.stringify(ev)).not.toContain("Detalhe interno");
    expect(JSON.stringify(ev)).not.toContain("0000002-23");
    // se o processo deixa de ser sigiloso, o evento é refeito com o conteúdo normal
    await db.query("update public.processo set segredo_justica = false where id = $1", [procSigilo]);
    await rodar();
    expect(eventosDe("ana")[0].summary).toBe("Estratégia do caso sigiloso");
    await db.query("update public.processo set segredo_justica = true where id = $1", [procSigilo]);
    await rodar();
    expect(eventosDe("ana")[0].summary).toBe("LAW: item restrito");
    await db.query("delete from public.tarefa where titulo = 'Estratégia do caso sigiloso'");
    await rodar();
  });
});

describe("Robustez", () => {
  it("queda entre “criar no Google” e “anotar o id” não duplica (id determinístico)", async () => {
    const id = await novaTarefa(ANA, "Idempotente", { resp: membro.ana, data: "2026-12-03" });
    await rodar();
    expect(eventosDe("ana")).toHaveLength(1);
    await db.query("delete from public.google_evento"); // perdeu o vínculo, mas o evento está no Google
    await chamar(ANA, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ descricao: "mudou" })]);
    await rodar();
    expect(eventosDe("ana")).toHaveLength(1);
    expect((await um<{ n: number }>("select count(*)::int n from public.google_evento where origem_id = $1", [id])).n).toBe(1);
  });

  it("evento apagado à mão no Google é recriado na próxima mudança", async () => {
    const cal = [...google.calendarios.values()].find((c) => c.dono === "ana")!;
    cal.eventos.clear();
    const id = (await um<{ id: string }>("select id from public.tarefa where titulo = 'Idempotente'")).id;
    await chamar(ANA, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ titulo: "Idempotente 2" })]);
    await rodar();
    expect(resumos(eventosDe("ana"))).toEqual(["Idempotente 2"]);
  });

  it("falha temporária (limite do Google) volta para a fila com espera e a conexão segue ativa", async () => {
    const id = await novaTarefa(ANA, "Tenta depois", { resp: membro.ana, data: "2026-12-04" });
    google.falhaTemporaria = "limite";
    const r = await rodar();
    google.falhaTemporaria = null;
    expect(r.falhas).toBe(1);
    const f = await um<{ tentativas: number; erro: string; espera: boolean; processado: boolean }>(
      "select tentativas, erro, proxima_tentativa > now() espera, processado_em is not null processado from public.agenda_sync_fila where origem_id = $1", [id]);
    expect(f).toMatchObject({ tentativas: 1, espera: true, processado: false });
    expect((await um<{ status: string }>("select status from public.google_conexao where usuario_id = $1", [ANA])).status).toBe("ativa");
    expect((await rodar()).itens).toBe(0); // ainda está esperando
    await db.query("update public.agenda_sync_fila set proxima_tentativa = now() where origem_id = $1", [id]);
    await rodar();
    expect(resumos(eventosDe("ana"))).toContain("Tenta depois");
  });

  it("mudança durante o processamento não se perde (versão da fila)", async () => {
    const id = await novaTarefa(ANA, "Corrida", { resp: membro.ana, data: "2026-12-05" });
    const pegos = await rpcServ<{ id: number; versao: number }[]>("sync_pegar_fila", { p_limite: 50 });
    const meu = pegos.find((p) => p.versao === 1)!;
    await chamar(ANA, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ titulo: "Corrida 2" })]); // chega no meio
    await rpcServ("sync_concluir", { p_fila: meu.id, p_versao: meu.versao, p_erro: null });
    expect((await um<{ processado: boolean }>("select processado_em is not null processado from public.agenda_sync_fila where id = $1", [meu.id])).processado).toBe(false);
    await db.query("update public.agenda_sync_fila set reservado_ate = null where processado_em is null");
    await rodar();
    expect(resumos(eventosDe("ana"))).toContain("Corrida 2");
  });
});

describe("Token expirado ou revogado", () => {
  it("para SÓ a conexão afetada, avisa o usuário uma vez e o resto continua funcionando", async () => {
    // Ana revoga o acesso no Google: o access token dá 401 e o refresh token não vale mais.
    const accAna = decifrar((await um<{ a: string }>("select access_token_cifrado a from public.google_conexao where usuario_id = $1", [ANA])).a, chave);
    google.tokensRecusados.add(accAna);
    google.refreshRevogados.add("ana");

    const tAna = await novaTarefa(ANA, "Depois da revogação", { resp: membro.ana, data: "2026-12-10" });
    const tBia = await novaTarefa(BIA, "Para a Bia", { resp: membro.bia, data: "2026-12-10" });
    const antesAna = eventosDe("ana").length;
    const r = await rodar();

    expect(r.conexoesParadas).toBe(1);
    expect(eventosDe("ana")).toHaveLength(antesAna); // nada novo para ela
    expect(resumos(eventosDe("bia"))).toContain("Para a Bia"); // a Bia segue normal
    expect((await um<{ status: string; erro: string }>("select status, erro from public.google_conexao where usuario_id = $1", [ANA])).status).toBe("revogada");
    expect((await um<{ status: string }>("select status from public.google_conexao where usuario_id = $1", [BIA])).status).toBe("ativa");

    // Aviso dentro do app, uma vez só
    const avisos = (await chamar(ANA, "select tipo, titulo, link from public.notificacao where tipo = 'google'")).rows;
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ titulo: "Google Agenda desconectado", link: "/app/agenda" });
    expect((await chamar(BIA, "select 1 from public.notificacao where tipo = 'google'")).rows).toHaveLength(0);
    expect(await rpcUser(ANA, "select public.google_status($1) as r", [esc])).toMatchObject({ conectado: true, status: "revogada" });

    // O resto do LAW não quebra: criar, mover e apagar tarefa continua funcionando
    await chamar(ANA, "select public.mover_tarefa($1, $2, 0)", [tAna, colunas[1]]);
    await chamar(ANA, "select public.tarefa_atualizar($1, $2::jsonb)", [tAna, JSON.stringify({ titulo: "Segue funcionando" })]);

    // Parada: não chama mais o Google por ela, e não avisa de novo
    const chamadasAna = () => google.chamadas.filter((c) => c.startsWith("renovar:ana")).length;
    const antes = chamadasAna();
    await rodar();
    await novaTarefa(ANA, "Outra", { resp: membro.ana, data: "2026-12-11" });
    await rodar();
    expect(chamadasAna()).toBe(antes);
    expect((await chamar(ANA, "select 1 from public.notificacao where tipo = 'google'")).rows).toHaveLength(1);
    expect((await um<{ n: number }>("select count(*)::int n from public.agenda_sync_fila where processado_em is null and tentativas > 0")).n).toBe(0);
    void tBia;
  });

  it("reconectar volta a sincronizar tudo que ficou parado", async () => {
    google.refreshRevogados.delete("ana");
    google.tokensRecusados.clear();
    await conectar(ANA, "ana");
    expect(await rpcUser(ANA, "select public.google_status($1) as r", [esc])).toMatchObject({ status: "ativa" });
    await rodar();
    expect(resumos(eventosDe("ana"))).toEqual(expect.arrayContaining(["Segue funcionando", "Outra"]));
  });

  it("desconectar apaga a conexão e para o envio; a Bia continua", async () => {
    await rpcServ("google_conexao_remover", { p_usuario: ANA, p_escritorio: esc });
    expect((await um<{ n: number }>("select count(*)::int n from public.google_conexao where usuario_id = $1", [ANA])).n).toBe(0);
    expect((await um<{ n: number }>("select count(*)::int n from public.google_evento")).n).toBeGreaterThan(0); // da Bia
    const antes = eventosDe("ana").length;
    await novaTarefa(ANA, "Pós-desconexão", { resp: membro.ana, data: "2026-12-12" });
    await novaTarefa(BIA, "Bia ainda recebe", { resp: membro.bia, data: "2026-12-12" });
    await rodar();
    expect(eventosDe("ana")).toHaveLength(antes);
    expect(resumos(eventosDe("bia"))).toContain("Bia ainda recebe");
  });
});
