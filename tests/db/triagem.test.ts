import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { comoAnonimo, comoUsuario, criarBanco, criarUsuario, rpcComoServico } from "./banco";
import { capturarEscritorio, type DepsCaptura } from "@/lib/captura/job";
import { FonteExemplo, PROC_CITADO, PROC_CIVEL, PROC_TRABALHO } from "@/lib/integrations/fontes/exemplos";
import type { FonteJuridica, ProcessoMetadados } from "@/lib/integrations/fontes/tipos";
import { sugerirMesclagem } from "@/lib/triagem/similaridade";

const DONO = "00000000-0000-4000-8000-0000000000e1";
const MEMBRO_PROCESSOS = "00000000-0000-4000-8000-0000000000e2";
const MEMBRO_PRAZOS = "00000000-0000-4000-8000-0000000000e3";
const MEMBRO_AGENDA = "00000000-0000-4000-8000-0000000000e4";
const OUTRO_DONO = "00000000-0000-4000-8000-0000000000e5";

// CPF fictício montado pela regra dos dígitos (não pertence a ninguém conhecido).
function cpfFicticio(base9: string) {
  const dv = (s: string) => {
    let soma = 0;
    for (let i = 0; i < s.length; i++) soma += Number(s[i]) * (s.length + 1 - i);
    const r = (soma * 10) % 11;
    return String(r === 10 ? 0 : r);
  };
  const d1 = dv(base9);
  return base9 + d1 + dv(base9 + d1);
}
const CPF = cpfFicticio("100200300");

let db: PGlite;
let escritorio: string;

/** DataJud de mentira: classe do cível e processo trabalhista em segredo de justiça. */
const dataJud: FonteJuridica = {
  nome: "datajud",
  capacidades: { publicacoes: false, processo: true, movimentacoes: true },
  async buscarPublicacoes() { return []; },
  async buscarMovimentacoes() { return []; },
  async buscarProcesso(numero: string): Promise<ProcessoMetadados | null> {
    const base = { tribunal: "TJBA", assuntos: [], grau: "G1", partes: [], bruto: {} };
    if (numero === PROC_CIVEL.digitos) {
      return {
        ...base, numeroCnj: numero, classe: { codigo: "7", nome: "Procedimento Comum Cível" },
        assuntos: [{ codigo: "10433", nome: "Indenização por Dano Moral" }], orgaoJulgador: "3ª Vara Cível",
        dataAjuizamento: "2025-03-14T00:00:00", nivelSigilo: 0,
        movimentos: [{ dataHora: "2025-03-14T10:00:00", codigo: "26", nome: "Distribuído por sorteio", complementos: [] }],
      };
    }
    if (numero === PROC_TRABALHO.digitos) {
      return {
        ...base, numeroCnj: numero, tribunal: "TRT5", classe: { codigo: "985", nome: "Ação Trabalhista - Rito Ordinário" },
        orgaoJulgador: "12ª Vara do Trabalho", dataAjuizamento: null, nivelSigilo: 5, movimentos: [],
      };
    }
    return null;
  },
};

const capturarEm = (iso: string) => {
  const deps: DepsCaptura = { fontes: { publicacoes: [new FonteExemplo()], processos: dataJud }, rpc: rpcComoServico(db), agora: () => new Date(iso) };
  return capturarEscritorio(escritorio, "agendada", deps);
};

const linhas = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const um = async <T,>(sql: string, p: unknown[] = []) => (await linhas<T>(sql, p))[0];
const idProcesso = async (cnj: string) => (await um<{ id: string }>("select id from public.processo where numero_cnj = $1", [cnj])).id;
const idCliente = async (nome: string) => (await um<{ id: string }>("select id from public.cliente where nome = $1 and status = 'provisorio'", [nome])).id;
const fila = async () => linhas<{ id: string; tribunal: string }>(
  "select id, tribunal from public.publicacao where escritorio_id = $1 and status_triagem = 'sem_processo' order by data_disponibilizacao", [escritorio],
);

/** Chama uma função do app como o usuário (RLS e permissões valem). */
const chamar = (uid: string, sql: string, p: unknown[] = []) => comoUsuario(db, uid, (tx) => tx.query(sql, p));

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, email] of [
    [DONO, "dona@exemplo.com"], [MEMBRO_PROCESSOS, "proc@exemplo.com"], [MEMBRO_PRAZOS, "prazos@exemplo.com"],
    [MEMBRO_AGENDA, "agenda@exemplo.com"], [OUTRO_DONO, "outro@exemplo.com"],
  ]) await criarUsuario(db, id, email);

  escritorio = await comoUsuario(db, DONO, async (tx) => (await tx.query<{ id: string }>("select public.criar_escritorio('Prado Advocacia', null, 'equipe') as id")).rows[0].id);
  await chamar(DONO, "select public.salvar_monitoramento($1, 'oab', $2::jsonb)", [escritorio, JSON.stringify([{ numero: "54321", uf: "BA" }])]);
  for (const [uid, email, modulos] of [
    [MEMBRO_PROCESSOS, "proc@exemplo.com", "{processos}"], [MEMBRO_PRAZOS, "prazos@exemplo.com", "{prazos}"], [MEMBRO_AGENDA, "agenda@exemplo.com", "{agenda}"],
  ] as const) {
    const token = await comoUsuario(db, DONO, async (tx) => (await tx.query<{ t: string }>("select public.criar_convite($1, $2, $3::text[]) as t", [escritorio, email, modulos])).rows[0].t);
    await chamar(uid, "select public.aceitar_convite($1)", [token]);
  }
  await comoUsuario(db, OUTRO_DONO, (tx) => tx.query("select public.criar_escritorio('Outro', null, 'solo')"));
});

describe("Critério de pronto: publicação nova → provisório → confirmação → próxima publicação ligada sozinha", () => {
  it("1) primeira captura cria processos e clientes provisórios a partir das publicações", async () => {
    const r = await capturarEm("2026-11-09T09:00:00Z");
    expect(r).toMatchObject({ status: "sucesso", novas: 4 });
    expect(r!.triagem).toEqual({ processos_novos: 3, processos_reabertos: 0, clientes_novos: 2, ligadas: 0, aguardando: 3, sem_processo: 1 });

    const procs = await linhas<{ numero_cnj: string; status: string; classe: string | null; orgao_julgador: string | null; segredo_justica: boolean; assuntos: string[] }>(
      "select numero_cnj, status, classe, orgao_julgador, segredo_justica, assuntos from public.processo where escritorio_id = $1 order by numero_cnj", [escritorio],
    );
    expect(procs.map((p) => p.numero_cnj).sort()).toEqual([PROC_CIVEL.digitos, PROC_TRABALHO.digitos, PROC_CITADO.digitos].sort());
    expect(procs.every((p) => p.status === "provisorio")).toBe(true);
    const civel = procs.find((p) => p.numero_cnj === PROC_CIVEL.digitos)!;
    // Dados do DataJud têm prioridade sobre os da publicação.
    expect(civel).toMatchObject({ classe: "Procedimento Comum Cível", orgao_julgador: "3ª Vara Cível", segredo_justica: false, assuntos: ["Indenização por Dano Moral"] });
    // Segredo de justiça vem marcado do DataJud.
    expect(procs.find((p) => p.numero_cnj === PROC_TRABALHO.digitos)!.segredo_justica).toBe(true);
    // Sem DataJud, usa o que veio na publicação.
    expect(procs.find((p) => p.numero_cnj === PROC_CITADO.digitos)!.classe).toBe("MANDADO DE SEGURANÇA CÍVEL");

    const clientes = await linhas<{ nome: string; status: string }>("select nome, status from public.cliente where escritorio_id = $1 order by nome", [escritorio]);
    expect(clientes).toEqual([{ nome: "PARTE AUTORA EXEMPLO", status: "provisorio" }, { nome: "RECLAMANTE EXEMPLO", status: "provisorio" }]);
    const parte = await um<{ polo: string; cliente: string }>(
      "select pp.polo, c.nome cliente from public.processo_parte pp join public.cliente c on c.id = pp.cliente_id where pp.processo_id = $1", [await idProcesso(PROC_CIVEL.digitos)],
    );
    expect(parte).toEqual({ polo: "ativo", cliente: "PARTE AUTORA EXEMPLO" });

    const pubs = await linhas<{ id_externo: string; status_triagem: string; ligada: boolean }>(
      "select id_externo, status_triagem, processo_id is not null ligada from public.publicacao where escritorio_id = $1 order by id_externo", [escritorio],
    );
    expect(pubs).toEqual([
      { id_externo: "910001", status_triagem: "aguardando", ligada: true },
      { id_externo: "910002", status_triagem: "aguardando", ligada: true },
      { id_externo: "910003", status_triagem: "aguardando", ligada: true },
      { id_externo: "910004", status_triagem: "sem_processo", ligada: false },
    ]);
  });

  it("2) provisório não entra em relatório nem financeiro", async () => {
    const vistos = await comoUsuario(db, DONO, async (tx) => ({
      processos: (await tx.query("select id from public.processo_confirmado")).rows.length,
      clientes: (await tx.query("select id from public.cliente_confirmado")).rows.length,
      todos: (await tx.query("select id from public.processo")).rows.length,
    }));
    expect(vistos).toEqual({ processos: 0, clientes: 0, todos: 3 });
    const civel = await idProcesso(PROC_CIVEL.digitos);
    await expect(
      chamar(DONO, "insert into public.lancamento (escritorio_id, descricao, valor_centavos, processo_id) values ($1, 'Honorários', 150000, $2)", [escritorio, civel]),
    ).rejects.toThrow(/vinculo_provisorio/);
    await expect(
      chamar(DONO, "insert into public.lancamento (escritorio_id, descricao, valor_centavos, cliente_id) values ($1, 'Honorários', 150000, $2)", [escritorio, await idCliente("PARTE AUTORA EXEMPLO")]),
    ).rejects.toThrow(/vinculo_provisorio/);
  });

  it("3) editar e confirmar o processo liga as publicações dele", async () => {
    const civel = await idProcesso(PROC_CIVEL.digitos);
    await chamar(DONO, "select public.confirmar_processo($1, $2::jsonb)", [civel, JSON.stringify({ titulo: "Indenização — Parte Autora", area: "Cível" })]);
    expect(await um("select status, titulo, area, confirmado_por from public.processo where id = $1", [civel])).toEqual({
      status: "confirmado", titulo: "Indenização — Parte Autora", area: "Cível", confirmado_por: DONO,
    });
    expect(await um("select status_triagem from public.publicacao where processo_id = $1", [civel])).toEqual({ status_triagem: "vinculada" });
    // Agora entra no financeiro e nas views de confirmados.
    await chamar(DONO, "insert into public.lancamento (escritorio_id, descricao, valor_centavos, processo_id) values ($1, 'Custas', 5000, $2)", [escritorio, civel]);
    expect((await comoUsuario(db, DONO, (tx) => tx.query("select id from public.processo_confirmado"))).rows).toHaveLength(1);
    // Confirmar de novo não é permitido.
    await expect(chamar(DONO, "select public.confirmar_processo($1)", [civel])).rejects.toThrow(/nao_provisorio/);
  });

  it("4) publicação seguinte do mesmo processo é ligada sozinha e aparece na linha do tempo", async () => {
    const r = await capturarEm("2026-11-12T09:00:00Z");
    expect(r).toMatchObject({ status: "sucesso", novas: 4 });
    expect(r!.triagem).toEqual({ processos_novos: 0, processos_reabertos: 0, clientes_novos: 0, ligadas: 1, aguardando: 2, sem_processo: 1 });

    const civel = await idProcesso(PROC_CIVEL.digitos);
    const linhaDoTempo = await linhas<{ data: string; status_triagem: string }>(
      "select data_disponibilizacao::text data, status_triagem from public.publicacao where processo_id = $1 order by data_disponibilizacao desc", [civel],
    );
    expect(linhaDoTempo).toEqual([
      { data: "2026-11-12", status_triagem: "vinculada" },
      { data: "2026-11-09", status_triagem: "vinculada" },
    ]);
    // Não duplicou processo nem cliente provisório.
    expect((await um<{ n: number }>("select count(*)::int n from public.processo where escritorio_id = $1", [escritorio])).n).toBe(3);
    expect((await um<{ n: number }>("select count(*)::int n from public.cliente where escritorio_id = $1", [escritorio])).n).toBe(2);
  });
});

describe("Critério de pronto: publicação sem número cai na fila e pode ser ligada manualmente", () => {
  it("busca processo por número, parte ou título e liga a publicação", async () => {
    const pendentes = await fila();
    expect(pendentes).toHaveLength(2);

    const buscar = (termo: string) => comoUsuario(db, DONO, async (tx) =>
      (await tx.query<{ numero_cnj: string }>("select numero_cnj from public.buscar_processos($1, $2)", [escritorio, termo])).rows.map((r) => r.numero_cnj));
    expect(await buscar("0801234")).toEqual([PROC_CIVEL.digitos]);
    expect(await buscar(PROC_CIVEL.mascara)).toEqual([PROC_CIVEL.digitos]);
    expect(await buscar("reclamante")).toEqual([PROC_TRABALHO.digitos]);
    expect(await buscar("indenizacao")).toEqual([PROC_CIVEL.digitos]);
    expect(await buscar("ab")).toEqual([]); // termo curto demais não lista tudo

    await chamar(DONO, "select public.vincular_publicacao($1, $2)", [pendentes[0].id, await idProcesso(PROC_CIVEL.digitos)]);
    expect(await um("select status_triagem from public.publicacao where id = $1", [pendentes[0].id])).toEqual({ status_triagem: "vinculada" });
    expect(await fila()).toHaveLength(1);
    await expect(chamar(DONO, "select public.vincular_publicacao($1, $2)", [pendentes[0].id, await idProcesso(PROC_TRABALHO.digitos)])).rejects.toThrow(/publicacao_ja_tratada/);

    // Ligada a processo provisório: fica aguardando a confirmação dele.
    await chamar(MEMBRO_PROCESSOS, "select public.vincular_publicacao($1, $2)", [pendentes[1].id, await idProcesso(PROC_CITADO.digitos)]);
    expect(await um("select status_triagem from public.publicacao where id = $1", [pendentes[1].id])).toEqual({ status_triagem: "aguardando" });
  });
});

describe("Descartar não apaga e é recuperável por 30 dias", () => {
  it("publicação: some da fila, volta ao restaurar, e não volta depois de 30 dias", async () => {
    await capturarEm("2026-11-15T09:00:00Z"); // traz mais um edital sem número
    const [pub] = await fila();
    await chamar(DONO, "select public.descartar_publicacao($1)", [pub.id]);
    expect(await fila()).toHaveLength(0);
    expect((await um<{ n: number }>("select count(*)::int n from public.publicacao where id = $1", [pub.id])).n).toBe(1); // não apagou

    await chamar(DONO, "select public.restaurar_publicacao($1)", [pub.id]);
    expect(await fila()).toHaveLength(1);

    await chamar(DONO, "select public.descartar_publicacao($1)", [pub.id]);
    await db.query("update public.publicacao set descartada_em = now() - interval '31 days' where id = $1", [pub.id]);
    await expect(chamar(DONO, "select public.restaurar_publicacao($1)", [pub.id])).rejects.toThrow(/prazo_restauracao_vencido/);
  });

  it("processo: leva junto as publicações e o cliente que só existia por ele; restaurar devolve tudo", async () => {
    const trab = await idProcesso(PROC_TRABALHO.digitos);
    await chamar(DONO, "select public.descartar_processo($1)", [trab]);
    expect(await um("select status from public.processo where id = $1", [trab])).toEqual({ status: "descartado" });
    expect((await um<{ n: number }>("select count(*)::int n from public.publicacao where processo_id = $1 and status_triagem <> 'descartada'", [trab])).n).toBe(0);
    expect(await um("select status from public.cliente where nome = 'RECLAMANTE EXEMPLO'")).toEqual({ status: "descartado" });

    await chamar(DONO, "select public.restaurar_processo($1)", [trab]);
    expect(await um("select status from public.processo where id = $1", [trab])).toEqual({ status: "provisorio" });
    expect(await um("select status from public.cliente where nome = 'RECLAMANTE EXEMPLO'")).toEqual({ status: "provisorio" });
    expect((await um<{ n: number }>("select count(*)::int n from public.publicacao where processo_id = $1 and status_triagem = 'aguardando'", [trab])).n).toBe(3);

    // Processo confirmado não se descarta pela triagem.
    await expect(chamar(DONO, "select public.descartar_processo($1)", [await idProcesso(PROC_CIVEL.digitos)])).rejects.toThrow(/nao_provisorio/);
  });

  it("publicação nova de processo descartado reabre o processo (publicação nova nunca fica escondida)", async () => {
    const trab = await idProcesso(PROC_TRABALHO.digitos);
    await chamar(DONO, "select public.descartar_processo($1)", [trab]);
    const r = await capturarEm("2026-11-18T09:00:00Z");
    expect(r!.triagem).toMatchObject({ processos_reabertos: 1 });
    expect(await um("select status from public.processo where id = $1", [trab])).toEqual({ status: "provisorio" });
    // O cliente que tinha saído junto com o processo volta para a fila.
    expect(await um("select status from public.cliente where nome = 'RECLAMANTE EXEMPLO'")).toEqual({ status: "provisorio" });
  });

  it("ligar publicação a processo descartado é recusado", async () => {
    const cit = await idProcesso(PROC_CITADO.digitos);
    await chamar(DONO, "select public.descartar_processo($1)", [cit]);
    const [pub] = await fila();
    await expect(chamar(DONO, "select public.vincular_publicacao($1, $2)", [pub.id, cit])).rejects.toThrow(/processo_descartado/);
    await chamar(DONO, "select public.restaurar_processo($1)", [cit]);
  });
});

describe("Clientes: confirmar, editar e confirmar, mesclar, descartar", () => {
  it("CPF inválido é recusado; válido confirma e define pessoa física", async () => {
    const autora = await idCliente("PARTE AUTORA EXEMPLO");
    await expect(chamar(DONO, "select public.confirmar_cliente($1, $2::jsonb)", [autora, JSON.stringify({ documento: "123.456.789-00" })])).rejects.toThrow(/documento_invalido/);
    await chamar(DONO, "select public.confirmar_cliente($1, $2::jsonb)", [autora, JSON.stringify({ nome: "Parte Autora Exemplo", documento: CPF, email: "Autora@Exemplo.com", telefone: "(71) 99999-0000" })]);
    expect(await um("select status, nome, documento, tipo_pessoa, email, telefone from public.cliente where id = $1", [autora])).toEqual({
      status: "confirmado", nome: "Parte Autora Exemplo", documento: CPF, tipo_pessoa: "fisica", email: "autora@exemplo.com", telefone: "71999990000",
    });
  });

  it("sugere mesclagem por CPF igual ou nome parecido; confirmar com CPF repetido é recusado; mesclar move as partes", async () => {
    const [confirmado] = await linhas<{ id: string; nome: string; documento: string | null }>("select id, nome, documento from public.cliente where status = 'confirmado'");
    const novo = (await um<{ id: string }>("insert into public.cliente (escritorio_id, nome) values ($1, 'PARTE AUTORA EXEMPLO') returning id", [escritorio])).id;
    const trab = await idProcesso(PROC_TRABALHO.digitos);
    await db.query("insert into public.processo_parte (escritorio_id, processo_id, nome, polo, cliente_id) values ($1, $2, 'PARTE AUTORA EXEMPLO', 'passivo', $3)", [escritorio, trab, novo]);

    expect(sugerirMesclagem({ nome: "PARTE AUTORA EXEMPLO", documento: null }, [confirmado])).toMatchObject([{ motivo: "nome" }]);
    expect(sugerirMesclagem({ nome: "Outra Pessoa", documento: CPF }, [confirmado])).toMatchObject([{ motivo: "documento" }]);

    await expect(chamar(DONO, "select public.confirmar_cliente($1, $2::jsonb)", [novo, JSON.stringify({ documento: CPF })])).rejects.toThrow(/documento_duplicado/);
    // Mesclar com cliente que não está confirmado é recusado.
    await expect(chamar(DONO, "select public.mesclar_cliente($1, $2)", [novo, await idCliente("RECLAMANTE EXEMPLO")])).rejects.toThrow(/destino_invalido/);

    await chamar(MEMBRO_PROCESSOS, "select public.mesclar_cliente($1, $2)", [novo, confirmado.id]);
    expect(await um("select status, mesclado_em from public.cliente where id = $1", [novo])).toEqual({ status: "mesclado", mesclado_em: confirmado.id });
    expect(await um("select cliente_id from public.processo_parte where processo_id = $1 and polo = 'passivo'", [trab])).toEqual({ cliente_id: confirmado.id });

    // Busca por nome do cliente encontra os processos dele.
    const achados = await comoUsuario(db, DONO, async (tx) => (await tx.query<{ numero_cnj: string }>("select numero_cnj from public.buscar_processos($1, 'parte autora')", [escritorio])).rows.map((r) => r.numero_cnj));
    expect(achados.sort()).toEqual([PROC_CIVEL.digitos, PROC_TRABALHO.digitos].sort());
  });

  it("descartar e restaurar cliente; confirmar em lote", async () => {
    const reclamante = await idCliente("RECLAMANTE EXEMPLO");
    await chamar(DONO, "select public.descartar_cliente($1)", [reclamante]);
    expect(await um("select status from public.cliente where id = $1", [reclamante])).toEqual({ status: "descartado" });
    await chamar(DONO, "select public.restaurar_cliente($1)", [reclamante]);
    const n = await comoUsuario(db, DONO, async (tx) => (await tx.query<{ n: number }>("select public.confirmar_clientes($1::uuid[]) n", [[reclamante]])).rows[0].n);
    expect(n).toBe(1);
    expect(await um("select status from public.cliente where id = $1", [reclamante])).toEqual({ status: "confirmado" });
  });
});

describe("Ação em lote e permissões", () => {
  it("quem não tem Processos não confirma nada; o lote é tudo ou nada", async () => {
    const ids = [await idProcesso(PROC_TRABALHO.digitos), await idProcesso(PROC_CITADO.digitos)];
    for (const uid of [MEMBRO_PRAZOS, MEMBRO_AGENDA, OUTRO_DONO]) {
      await expect(chamar(uid, "select public.confirmar_processos($1::uuid[])", [ids])).rejects.toThrow(/sem_permissao/);
    }
    expect((await um<{ n: number }>("select count(*)::int n from public.processo where id = any($1::uuid[]) and status = 'provisorio'", [ids])).n).toBe(2);

    const n = await comoUsuario(db, MEMBRO_PROCESSOS, async (tx) => (await tx.query<{ n: number }>("select public.confirmar_processos($1::uuid[]) n", [ids])).rows[0].n);
    expect(n).toBe(2);
    expect((await um<{ n: number }>("select count(*)::int n from public.publicacao where processo_id = any($1::uuid[]) and status_triagem = 'aguardando'", [ids])).n).toBe(0);
  });

  it("quem vê o quê (RLS)", async () => {
    const ver = (uid: string, tabela: string) => comoUsuario(db, uid, async (tx) => (await tx.query(`select 1 from public.${tabela}`)).rows.length);
    expect(await ver(DONO, "processo")).toBe(3);
    expect(await ver(MEMBRO_PRAZOS, "processo")).toBe(3); // prazos depende do processo
    expect(await ver(MEMBRO_PRAZOS, "cliente")).toBe(0); // mas não vê cadastro de cliente
    expect(await ver(MEMBRO_AGENDA, "processo")).toBe(0);
    expect(await ver(MEMBRO_AGENDA, "processo_parte")).toBe(0);
    expect(await ver(OUTRO_DONO, "processo")).toBe(0);
    expect(await ver(OUTRO_DONO, "cliente")).toBe(0);
    await expect(comoAnonimo(db, (tx) => tx.query("select 1 from public.processo"))).rejects.toThrow(/permission denied/);
  });

  it("app não grava direto nem chama a triagem do job", async () => {
    await expect(chamar(DONO, "insert into public.processo (escritorio_id, numero_cnj) values ($1, $2)", [escritorio, "0".repeat(20)])).rejects.toThrow(/permission denied/);
    await expect(chamar(DONO, "update public.cliente set status = 'confirmado'")).rejects.toThrow(/permission denied/);
    await expect(chamar(DONO, "update public.publicacao set status_triagem = 'descartada'")).rejects.toThrow(/permission denied/);
    await expect(chamar(DONO, "select public.triar_publicacoes($1)", [escritorio])).rejects.toThrow(/permission denied/);
    await expect(chamar(DONO, "select public._registrar_partes($1, $1, '[]'::jsonb, true)", [escritorio])).rejects.toThrow(/permission denied/);
  });

  it("toda confirmação e descarte fica na auditoria com o usuário", async () => {
    const r = await linhas<{ usuario_id: string; status: string }>(
      "select usuario_id, depois->>'status' status from public.audit_log where tabela = 'processo' and acao = 'update' and usuario_id is not null order by id",
    );
    expect(r.some((x) => x.usuario_id === DONO && x.status === "confirmado")).toBe(true);
    expect(r.some((x) => x.usuario_id === DONO && x.status === "descartado")).toBe(true);
    expect(r.some((x) => x.usuario_id === MEMBRO_PROCESSOS && x.status === "confirmado")).toBe(true);
  });
});
