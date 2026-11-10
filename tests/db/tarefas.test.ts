import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { comoUsuario, criarBanco, criarUsuario } from "./banco";

const DONO = "00000000-0000-4000-8000-0000000000a1";
const TAREFAS = "00000000-0000-4000-8000-0000000000a2"; // membro só com Tarefas
const AGENDA = "00000000-0000-4000-8000-0000000000a3"; // membro só com Agenda
const PRAZOS = "00000000-0000-4000-8000-0000000000a4"; // membro só com Prazos
const FORA = "00000000-0000-4000-8000-0000000000a5"; // dono de outro escritório

let db: PGlite;
let esc: string;
let escFora: string;
let m: Record<string, string>;
let proc: string;
let procProvisorio: string;
let cliente: string;
let colunas: { id: string; nome: string; concluida: boolean }[];

const chamar = (uid: string, sql: string, p: unknown[] = []) => comoUsuario(db, uid, (tx) => tx.query(sql, p));
const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const linhas = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const rpc = async <T,>(uid: string, sql: string, p: unknown[] = []) => ((await chamar(uid, sql, p)).rows[0] as { r: T }).r;

const novaTarefa = (titulo: string, coluna: string | null = null, extra: Partial<{ resp: string | null; data: string | null; proc: string | null; cli: string | null; etq: string[] }> = {}) =>
  rpc<string>(TAREFAS, "select public.tarefa_criar($1, $2, $3, '', $4, $5, $6, $7, $8) as r", [
    esc, coluna, titulo, extra.resp ?? null, extra.data ?? null, extra.proc ?? null, extra.cli ?? null, extra.etq ?? [],
  ]);
const ordem = async (coluna: string) =>
  (await linhas<{ titulo: string; posicao: number }>("select titulo, posicao from public.tarefa where coluna_id = $1 order by posicao", [coluna]));

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, email] of [[DONO, "dono@t.com"], [TAREFAS, "tar@t.com"], [AGENDA, "ag@t.com"], [PRAZOS, "pz@t.com"], [FORA, "fora@t.com"]]) await criarUsuario(db, id, email);
  esc = await rpc<string>(DONO, "select public.criar_escritorio('Prado Advocacia', null, 'equipe') as r");
  escFora = await rpc<string>(FORA, "select public.criar_escritorio('Outro Escritório', null, 'equipe') as r");
  for (const [uid, email, mod] of [[TAREFAS, "tar@t.com", "{tarefas}"], [AGENDA, "ag@t.com", "{agenda}"], [PRAZOS, "pz@t.com", "{prazos}"]] as const) {
    const token = await rpc<string>(DONO, "select public.criar_convite($1, $2, $3::text[]) as r", [esc, email, mod]);
    await chamar(uid, "select public.aceitar_convite($1)", [token]);
  }
  m = {};
  for (const [k, u] of [["dono", DONO], ["tarefas", TAREFAS], ["agenda", AGENDA], ["prazos", PRAZOS]]) {
    m[k] = (await um<{ id: string }>("select id from public.membro where usuario_id = $1 and escritorio_id = $2", [u, esc])).id;
  }
  // Processo confirmado, processo provisório e cliente confirmado (inseridos como o job faria).
  proc = (await um<{ id: string }>("insert into public.processo (escritorio_id, numero_cnj, status, confirmado_em) values ($1, '00000011220268050001', 'confirmado', now()) returning id", [esc])).id;
  procProvisorio = (await um<{ id: string }>("insert into public.processo (escritorio_id, numero_cnj) values ($1, '00000022320268050001') returning id", [esc])).id;
  cliente = (await um<{ id: string }>("insert into public.cliente (escritorio_id, nome, status, confirmado_em) values ($1, 'Cliente Exemplo', 'confirmado', now()) returning id", [esc])).id;
  colunas = await linhas("select id, nome, concluida from public.quadro_coluna where escritorio_id = $1 order by posicao", [esc]);
});

describe("Colunas", () => {
  it("todo escritório nasce com A fazer, Fazendo, Revisão e Feito (só Feito conclui)", () => {
    expect(colunas.map((c) => c.nome)).toEqual(["A fazer", "Fazendo", "Revisão", "Feito"]);
    expect(colunas.map((c) => c.concluida)).toEqual([false, false, false, true]);
  });

  it("só o dono cria, renomeia, reordena e remove", async () => {
    const id = await rpc<string>(DONO, "select public.coluna_criar($1, '  Aguardando cliente ') as r", [esc]);
    expect((await um<{ nome: string; posicao: number }>("select nome, posicao from public.quadro_coluna where id = $1", [id]))).toEqual({ nome: "Aguardando cliente", posicao: 5 });
    await chamar(DONO, "select public.coluna_renomear($1, 'Aguardando')", [id]);
    await chamar(DONO, "select public.coluna_mover($1, -1)", [id]); // sobe uma casa
    expect((await linhas<{ nome: string }>("select nome from public.quadro_coluna where escritorio_id = $1 order by posicao", [esc])).map((c) => c.nome))
      .toEqual(["A fazer", "Fazendo", "Revisão", "Aguardando", "Feito"]);
    await expect(chamar(TAREFAS, "select public.coluna_criar($1, 'X')", [esc])).rejects.toThrow(/sem_permissao/);
    await expect(chamar(TAREFAS, "select public.coluna_renomear($1, 'X')", [id])).rejects.toThrow(/sem_permissao/);
    await expect(chamar(TAREFAS, "select public.coluna_remover($1)", [id])).rejects.toThrow(/sem_permissao/);
    await chamar(DONO, "select public.coluna_remover($1)", [id]);
    expect((await linhas("select 1 from public.quadro_coluna where escritorio_id = $1", [esc])).length).toBe(4);
    expect((await linhas<{ posicao: number }>("select posicao from public.quadro_coluna where escritorio_id = $1 order by posicao", [esc])).map((c) => c.posicao)).toEqual([1, 2, 3, 4]);
  });

  it("não remove coluna com tarefa, nem a última, e limita em 12", async () => {
    const t = await novaTarefa("Prende a coluna", colunas[1].id);
    await expect(chamar(DONO, "select public.coluna_remover($1)", [colunas[1].id])).rejects.toThrow(/coluna_com_tarefas/);
    await rpc(TAREFAS, "select public.apagar_tarefa($1) as r", [t]);
    // escritório com uma coluna só
    const solo = await rpc<string>(FORA, "select public.criar_escritorio('Solo', null, 'solo') as r");
    const cs = await linhas<{ id: string }>("select id from public.quadro_coluna where escritorio_id = $1 order by posicao", [solo]);
    for (const c of cs.slice(1)) await chamar(FORA, "select public.coluna_remover($1)", [c.id]);
    await expect(chamar(FORA, "select public.coluna_remover($1)", [cs[0].id])).rejects.toThrow(/ultima_coluna/);
    for (let i = 0; i < 8; i++) await chamar(DONO, "select public.coluna_criar($1, $2)", [esc, `Extra ${i}`]);
    await expect(chamar(DONO, "select public.coluna_criar($1, 'Demais')", [esc])).rejects.toThrow(/limite_colunas/);
    for (const c of await linhas<{ id: string }>("select id from public.quadro_coluna where escritorio_id = $1 and nome like 'Extra %'", [esc])) {
      await chamar(DONO, "select public.coluna_remover($1)", [c.id]);
    }
  });
});

describe("Cartões", () => {
  it("cria com título, descrição, responsável, data, processo, cliente e etiquetas (normalizadas)", async () => {
    const id = await rpc<string>(TAREFAS, "select public.tarefa_criar($1, null, '  Protocolar petição ', 'Ver minuta', $2, '2026-11-20', $3, $4, $5) as r",
      [esc, m.tarefas, proc, cliente, ["Urgente", " urgente ", "Cível", ""]]);
    const t = await um<Record<string, unknown>>("select *, data::text as data_txt from public.tarefa where id = $1", [id]);
    expect(t).toMatchObject({ titulo: "Protocolar petição", descricao: "Ver minuta", responsavel_id: m.tarefas, processo_id: proc, cliente_id: cliente, coluna_id: colunas[0].id, posicao: 1 });
    expect(t.data_txt).toBe("2026-11-20");
    expect(t.etiquetas).toEqual(["Urgente", "Cível"]);
    expect(t.concluida_em).toBeNull();
  });

  it("recusa processo provisório, cliente fora do escritório e responsável de outro escritório", async () => {
    await expect(novaTarefa("A", null, { proc: procProvisorio })).rejects.toThrow(/processo_nao_confirmado/);
    const outroCli = (await um<{ id: string }>("insert into public.cliente (escritorio_id, nome, status, confirmado_em) values ($1, 'Cliente de Fora', 'confirmado', now()) returning id", [escFora])).id;
    await expect(novaTarefa("B", null, { cli: outroCli })).rejects.toThrow(/cliente_nao_confirmado/);
    const membroFora = (await um<{ id: string }>("select id from public.membro where usuario_id = $1 and escritorio_id = $2", [FORA, escFora])).id;
    await expect(novaTarefa("C", null, { resp: membroFora })).rejects.toThrow(/responsavel_invalido/);
    await expect(rpc(TAREFAS, "select public.tarefa_criar($1, $2, 'D', '', null, null, null, null, '{}') as r", [escFora, colunas[0].id])).rejects.toThrow(/sem_permissao/);
  });

  it("valida etiquetas, checklist e título", async () => {
    const id = await novaTarefa("Valida");
    await expect(novaTarefa("   ")).rejects.toThrow();
    await expect(chamar(TAREFAS, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ checklist: [{ id: "1", texto: "", feito: false }] })])).rejects.toThrow();
    await expect(chamar(TAREFAS, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ checklist: "x" })])).rejects.toThrow();
    await expect(chamar(TAREFAS, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ etiquetas: Array.from({ length: 16 }, (_, i) => `e${i}`) })])).rejects.toThrow();
    const ok = [{ id: "a", texto: "Revisar", feito: true }, { id: "b", texto: "Protocolar", feito: false }];
    await chamar(TAREFAS, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ checklist: ok })]);
    expect((await um<{ checklist: unknown }>("select checklist from public.tarefa where id = $1", [id])).checklist).toEqual(ok);
  });

  it("atualiza só as chaves enviadas", async () => {
    const id = await novaTarefa("Parcial", null, { resp: m.tarefas, data: "2026-12-01" });
    await chamar(TAREFAS, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ titulo: "Parcial 2" })]);
    let t = await um<{ titulo: string; responsavel_id: string; data: string }>("select titulo, responsavel_id, data::text from public.tarefa where id = $1", [id]);
    expect(t).toMatchObject({ titulo: "Parcial 2", responsavel_id: m.tarefas, data: "2026-12-01" });
    await chamar(TAREFAS, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ data: null, responsavel_id: null })]);
    t = await um("select titulo, responsavel_id, data::text from public.tarefa where id = $1", [id]);
    expect(t).toMatchObject({ titulo: "Parcial 2", responsavel_id: null, data: null });
  });

  it("comentários ficam com o autor; checklist e comentário exigem a tela Tarefas", async () => {
    const id = await novaTarefa("Com comentário");
    await chamar(TAREFAS, "select public.comentar_tarefa($1, '  Falei com o cliente  ')", [id]);
    expect(await um("select texto, autor_id from public.tarefa_comentario where tarefa_id = $1", [id])).toEqual({ texto: "Falei com o cliente", autor_id: m.tarefas });
    await expect(chamar(AGENDA, "select public.comentar_tarefa($1, 'oi')", [id])).rejects.toThrow(/sem_permissao/);
    await expect(chamar(TAREFAS, "select public.comentar_tarefa($1, '   ')", [id])).rejects.toThrow();
  });
});

describe("Ordem (arrastar e soltar persistido)", () => {
  it("mover dentro da coluna e entre colunas renumera 1..n e persiste", async () => {
    const [a, b, c] = colunas;
    const t1 = await novaTarefa("O1", b.id), t2 = await novaTarefa("O2", b.id), t3 = await novaTarefa("O3", b.id), t4 = await novaTarefa("O4", b.id);
    expect((await ordem(b.id)).map((t) => t.titulo)).toEqual(["O1", "O2", "O3", "O4"]);
    await chamar(TAREFAS, "select public.mover_tarefa($1, $2, 0)", [t4, b.id]); // último vai ao topo
    expect((await ordem(b.id)).map((t) => t.titulo)).toEqual(["O4", "O1", "O2", "O3"]);
    await chamar(TAREFAS, "select public.mover_tarefa($1, $2, 2)", [t4, b.id]); // meio
    expect((await ordem(b.id)).map((t) => t.titulo)).toEqual(["O1", "O2", "O4", "O3"]);
    await chamar(TAREFAS, "select public.mover_tarefa($1, $2, 99)", [t1, b.id]); // índice enorme = fim
    expect((await ordem(b.id)).map((t) => t.titulo)).toEqual(["O2", "O4", "O3", "O1"]);
    // entre colunas
    await chamar(TAREFAS, "select public.mover_tarefa($1, $2, 0)", [t3, c.id]);
    await chamar(TAREFAS, "select public.mover_tarefa($1, $2, 0)", [t2, c.id]);
    expect((await ordem(c.id)).map((t) => `${t.posicao}:${t.titulo}`)).toEqual(["1:O2", "2:O3"]);
    expect((await ordem(b.id)).map((t) => `${t.posicao}:${t.titulo}`)).toEqual(["1:O4", "2:O1"]); // origem fechou o buraco
    void a; void t1;
  });

  it("ao entrar na coluna que conclui, marca a conclusão; ao sair, limpa", async () => {
    const feito = colunas[3];
    const id = await novaTarefa("Concluir", colunas[0].id);
    await chamar(TAREFAS, "select public.mover_tarefa($1, $2, 0)", [id, feito.id]);
    expect((await um<{ ok: boolean }>("select concluida_em is not null ok from public.tarefa where id = $1", [id])).ok).toBe(true);
    await chamar(TAREFAS, "select public.mover_tarefa($1, $2, 0)", [id, colunas[1].id]);
    expect((await um<{ ok: boolean }>("select concluida_em is null ok from public.tarefa where id = $1", [id])).ok).toBe(true);
  });

  it("não move para coluna de outro escritório nem sem permissão", async () => {
    const id = await novaTarefa("Isolada");
    const colFora = (await um<{ id: string }>("select id from public.quadro_coluna where escritorio_id = $1 limit 1", [escFora])).id;
    await expect(chamar(TAREFAS, "select public.mover_tarefa($1, $2, 0)", [id, colFora])).rejects.toThrow(/coluna_invalida/);
    await expect(chamar(AGENDA, "select public.mover_tarefa($1, $2, 0)", [id, colunas[1].id])).rejects.toThrow(/sem_permissao/);
  });
});

describe("Permissões e isolamento (RLS)", () => {
  it("cada tela vê só o seu: Tarefas vê cartões, Agenda vê compromissos, Prazos não vê nenhum dos dois", async () => {
    await rpc(AGENDA, "select public.compromisso_criar($1, 'Reunião interna', 'reuniao', '2026-11-12T13:00:00Z', '2026-11-12T14:00:00Z', '', '', null, null) as r", [esc]);
    const cont = async (uid: string, tabela: string) => (await chamar(uid, `select count(*)::int n from public.${tabela}`)).rows[0] as { n: number };
    expect((await cont(TAREFAS, "tarefa")).n).toBeGreaterThan(0);
    expect((await cont(AGENDA, "tarefa")).n).toBe(0);
    expect((await cont(PRAZOS, "tarefa")).n).toBe(0);
    expect((await cont(AGENDA, "compromisso")).n).toBe(1);
    expect((await cont(TAREFAS, "compromisso")).n).toBe(0);
    expect((await cont(FORA, "tarefa")).n).toBe(0);
    expect((await cont(FORA, "quadro_coluna")).n).toBeGreaterThan(0); // só as do escritório dele
    expect((await chamar(FORA, "select count(*)::int n from public.quadro_coluna where escritorio_id = $1", [esc])).rows[0]).toEqual({ n: 0 });
  });

  it("escrita direta nas tabelas é negada; só pelas funções", async () => {
    await expect(chamar(TAREFAS, "insert into public.tarefa (escritorio_id, coluna_id, titulo) values ($1, $2, 'x')", [esc, colunas[0].id])).rejects.toThrow();
    await expect(chamar(DONO, "update public.quadro_coluna set nome = 'x'")).rejects.toThrow();
    await expect(chamar(DONO, "delete from public.compromisso")).rejects.toThrow();
  });

  it("tokens do Google nunca chegam ao usuário logado", async () => {
    await expect(chamar(DONO, "select * from public.google_conexao")).rejects.toThrow();
    await expect(chamar(DONO, "select * from public.google_evento")).rejects.toThrow();
    await expect(chamar(DONO, "select * from public.agenda_sync_fila")).rejects.toThrow();
    await expect(chamar(DONO, "select public.google_conexao_obter($1, $2)", [DONO, esc])).rejects.toThrow();
    const st = await rpc<Record<string, unknown>>(DONO, "select public.google_status($1) as r", [esc]);
    expect(st).toEqual({ conectado: false });
  });
});

describe("Agenda interna", () => {
  const itens = (uid: string, de = "2026-11-01", ate = "2026-11-30") =>
    chamar(uid, "select tipo, titulo, dia::text, status from public.agenda_itens($1, $2, $3) order by dia, tipo, titulo", [esc, de, ate]).then((r) => r.rows as { tipo: string; titulo: string; dia: string; status: string }[]);

  it("tarefa com data entra sozinha; mudar a data muda na agenda; tirar a data tira da agenda", async () => {
    const id = await novaTarefa("Audiência: preparar documentos", colunas[0].id, { data: "2026-11-18" });
    expect(await itens(TAREFAS)).toContainEqual({ tipo: "tarefa", titulo: "Audiência: preparar documentos", dia: "2026-11-18", status: "aberta" });
    await chamar(TAREFAS, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ data: "2026-11-19" })]);
    let lista = await itens(TAREFAS);
    expect(lista.find((i) => i.titulo.startsWith("Audiência: preparar"))?.dia).toBe("2026-11-19");
    expect(lista.filter((i) => i.titulo.startsWith("Audiência: preparar")).length).toBe(1);
    await chamar(TAREFAS, "select public.mover_tarefa($1, $2, 0)", [id, colunas[3].id]);
    expect((await itens(TAREFAS)).find((i) => i.titulo.startsWith("Audiência: preparar"))?.status).toBe("feita");
    await chamar(TAREFAS, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ data: null })]);
    lista = await itens(TAREFAS);
    expect(lista.some((i) => i.titulo.startsWith("Audiência: preparar"))).toBe(false);
  });

  it("mostra prazos abertos e cumpridos (não os cancelados) e compromissos no dia de Brasília", async () => {
    await db.query(
      `insert into public.prazo (escritorio_id, processo_id, descricao, dias, tipo_contagem, responsavel_id, data_disponibilizacao, data_publicacao, inicio_contagem, data_final, raciocinio, status)
       values ($1, $2, 'Contestar', 15, 'util', $3, '2026-10-20', '2026-10-21', '2026-10-22', '2026-11-13', '{}', 'aberto'),
              ($1, $2, 'Prazo cancelado', 5, 'util', $3, '2026-10-20', '2026-10-21', '2026-10-22', '2026-11-14', '{}', 'cancelado')`, [esc, proc, m.prazos]);
    // 01:30 UTC de 10/11 = 22:30 de 09/11 em Brasília
    await rpc(AGENDA, "select public.compromisso_criar($1, 'Audiência de instrução', 'audiencia', '2026-11-10T01:30:00Z', '2026-11-10T02:30:00Z', 'Fórum', '', $2, null) as r", [esc, proc]);
    const doPrazos = await itens(PRAZOS);
    expect(doPrazos.map((i) => i.tipo)).toEqual(["prazo"]); // só o bloco da tela dele
    expect(doPrazos[0]).toMatchObject({ titulo: "Contestar", dia: "2026-11-13" });
    const daAgenda = await itens(AGENDA);
    expect(daAgenda.every((i) => i.tipo === "compromisso")).toBe(true);
    expect(daAgenda).toContainEqual({ tipo: "compromisso", titulo: "Audiência de instrução", dia: "2026-11-09", status: "audiencia" });
    const dono = await itens(DONO);
    expect(new Set(dono.map((i) => i.tipo))).toEqual(new Set(["tarefa", "prazo", "compromisso"]));
    expect(dono.some((i) => i.titulo === "Prazo cancelado")).toBe(false);
  });

  it("período inválido ou escritório alheio é recusado", async () => {
    await expect(itens(DONO, "2026-11-30", "2026-11-01")).rejects.toThrow(/periodo_invalido/);
    await expect(itens(DONO, "2026-01-01", "2026-12-31")).rejects.toThrow(/periodo_invalido/);
    await expect(chamar(FORA, "select * from public.agenda_itens($1, '2026-11-01', '2026-11-30')", [esc])).rejects.toThrow(/sem_permissao/);
  });

  it("compromisso: criar, editar, apagar (e fim antes do início é recusado)", async () => {
    const id = await rpc<string>(AGENDA, "select public.compromisso_criar($1, 'Reunião com cliente', 'reuniao', '2026-11-16T17:00:00Z', '2026-11-16T18:00:00Z', 'Sala 2', 'Levar contrato', null, $2) as r", [esc, m.agenda]);
    await chamar(AGENDA, "select public.compromisso_atualizar($1, $2::jsonb)", [id, JSON.stringify({ titulo: "Reunião remarcada", inicio: "2026-11-17T17:00:00Z", fim: "2026-11-17T18:00:00Z" })]);
    expect(await um("select titulo, local from public.compromisso where id = $1", [id])).toEqual({ titulo: "Reunião remarcada", local: "Sala 2" });
    await expect(chamar(AGENDA, "select public.compromisso_atualizar($1, $2::jsonb)", [id, JSON.stringify({ fim: "2026-11-01T00:00:00Z" })])).rejects.toThrow();
    await expect(chamar(TAREFAS, "select public.compromisso_apagar($1)", [id])).rejects.toThrow(/sem_permissao/);
    await chamar(AGENDA, "select public.compromisso_apagar($1)", [id]);
    expect((await linhas("select 1 from public.compromisso where id = $1", [id])).length).toBe(0);
  });

  it("compromisso com mudança vira linha na auditoria", async () => {
    const n = await um<{ n: number }>("select count(*)::int n from public.audit_log where tabela = 'compromisso'");
    expect(n.n).toBeGreaterThan(0);
  });
});

describe("Fila de sincronização (caixa de saída)", () => {
  it("sem conexão ativa nada entra na fila; com conexão, só mudanças que importam entram, sem repetir", async () => {
    expect((await um<{ n: number }>("select count(*)::int n from public.agenda_sync_fila")).n).toBe(0);
    await db.query(
      `insert into public.google_conexao (escritorio_id, usuario_id, calendario_id, calendario_nome, refresh_token_cifrado) values ($1, $2, 'cal-dono', 'LAW', 'v1:x:y:z')`, [esc, TAREFAS]);
    const id = await novaTarefa("Na fila", colunas[0].id, { data: "2026-11-25", resp: m.tarefas });
    const fila = () => linhas<{ versao: number; origem: string }>("select versao, origem from public.agenda_sync_fila where origem_id = $1 and processado_em is null", [id]);
    expect(await fila()).toEqual([{ versao: 1, origem: "tarefa" }]);
    await db.query("update public.agenda_sync_fila set processado_em = now() where origem_id = $1", [id]);
    await chamar(TAREFAS, "select public.mover_tarefa($1, $2, 0)", [id, colunas[1].id]); // só mudou de coluna aberta: não é evento
    await chamar(TAREFAS, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ checklist: [{ id: "a", texto: "x", feito: false }], etiquetas: ["a"] })]);
    expect(await fila()).toEqual([]);
    await chamar(TAREFAS, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ data: "2026-11-26" })]);
    await chamar(TAREFAS, "select public.tarefa_atualizar($1, $2::jsonb)", [id, JSON.stringify({ titulo: "Na fila 2" })]);
    expect(await fila()).toEqual([{ versao: 2, origem: "tarefa" }]); // uma linha só, com versão nova
    await chamar(TAREFAS, "select public.mover_tarefa($1, $2, 0)", [id, colunas[3].id]); // concluir é evento (✔)
    expect((await fila())[0].versao).toBe(3);
  });

  it("apagar o item também entra na fila (para tirar do Google)", async () => {
    const id = await novaTarefa("Vai sumir", null, { data: "2026-11-27", resp: m.tarefas });
    await db.query("update public.agenda_sync_fila set processado_em = now() where origem_id = $1", [id]);
    await rpc(TAREFAS, "select public.apagar_tarefa($1) as r", [id]);
    expect((await linhas("select 1 from public.agenda_sync_fila where origem_id = $1 and processado_em is null", [id])).length).toBe(1);
  });

  it("processo virar segredo de justiça reenfileira os itens ligados a ele", async () => {
    const id = await novaTarefa("Do processo", null, { data: "2026-11-28", resp: m.tarefas, proc });
    await db.query("update public.agenda_sync_fila set processado_em = now() where origem_id = $1", [id]);
    await db.query("update public.processo set segredo_justica = true where id = $1", [proc]);
    expect((await linhas("select 1 from public.agenda_sync_fila where origem_id = $1 and processado_em is null", [id])).length).toBe(1);
    await db.query("update public.processo set segredo_justica = false where id = $1", [proc]);
  });
});

describe("Saída da equipe", () => {
  it("quem sai do escritório perde a conexão com o Google (tokens apagados)", async () => {
    await db.query(`insert into public.google_conexao (escritorio_id, usuario_id, calendario_id, calendario_nome, refresh_token_cifrado) values ($1, $2, 'cal-prazos', 'LAW', 'v1:x:y:z')`, [esc, AGENDA]);
    await db.query("delete from public.membro where id = $1", [m.agenda]);
    expect((await um<{ n: number }>("select count(*)::int n from public.google_conexao where usuario_id = $1", [AGENDA])).n).toBe(0);
  });
});
