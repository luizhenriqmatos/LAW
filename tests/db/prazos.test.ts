import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { comoUsuario, criarBanco, criarUsuario, rpcComoServico } from "./banco";
import { capturarEscritorio } from "@/lib/captura/job";
import { FonteExemplo, PROC_CIVEL } from "@/lib/integrations/fontes/exemplos";
import { calcularPrazo, entradasDoTribunal, sugerirDiasDoTexto, type EntradaCalendario } from "@/lib/prazos/contagem";
import { executarAlertas } from "@/lib/prazos/executar-alertas";
import type { ResultadoEnvio } from "@/lib/integrations/email";

const DONO = "00000000-0000-4000-8000-0000000000f1";
const RESP = "00000000-0000-4000-8000-0000000000f2"; // membro com Prazos
const SO_PROCESSOS = "00000000-0000-4000-8000-0000000000f3";
const SO_AGENDA = "00000000-0000-4000-8000-0000000000f4";
const OUTRO = "00000000-0000-4000-8000-0000000000f5";

let db: PGlite;
let escritorio: string;
let processo: string;
let membroDono: string;
let membroResp: string;
let membroAgenda: string;

const chamar = (uid: string, sql: string, p: unknown[] = []) => comoUsuario(db, uid, (tx) => tx.query(sql, p));
const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const linhas = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;

async function carregarCalendario(uid = DONO): Promise<EntradaCalendario[]> {
  const r = await comoUsuario(db, uid, (tx) =>
    tx.query<{ data: string; data_fim: string | null; escopo: EntradaCalendario["escopo"]; tribunal: string | null; uf: string | null; tipo: EntradaCalendario["tipo"]; descricao: string }>(
      "select data::text, data_fim::text, escopo, tribunal, uf, tipo, descricao from public.calendario_forense where escritorio_id is null or escritorio_id = $1", [escritorio],
    ),
  );
  return r.rows.map((x) => ({ data: x.data, dataFim: x.data_fim, escopo: x.escopo, tribunal: x.tribunal, uf: x.uf, tipo: x.tipo, descricao: x.descricao }));
}

/** Cria um prazo como o app faz: data calculada pelo módulo de contagem, gravada pela função do banco. */
async function criarPrazo(uid: string, o: { dispon: string; dias: number; tipo?: "util" | "corrido"; resp?: string; proc?: string; desc?: string }) {
  const cal = entradasDoTribunal(await carregarCalendario(uid), "TJBA");
  const r = calcularPrazo({ disponibilizacao: o.dispon, dias: o.dias, tipo: o.tipo, calendario: cal });
  const res = await chamar(uid, "select public.criar_prazo($1, null, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) id", [
    o.proc ?? processo, o.desc ?? "Manifestar sobre a contestação", o.dias, r.tipo, o.resp ?? membroResp,
    r.disponibilizacao, r.publicacao, r.inicioContagem, r.dataFinal, JSON.stringify({ passos: r.passos, diasPulados: r.diasPulados, aviso: r.aviso }),
  ]);
  return { id: (res.rows[0] as { id: string }).id, resultado: r };
}

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, email] of [[DONO, "dona@exemplo.com"], [RESP, "resp@exemplo.com"], [SO_PROCESSOS, "proc@exemplo.com"], [SO_AGENDA, "agenda@exemplo.com"], [OUTRO, "outro@exemplo.com"]]) {
    await criarUsuario(db, id, email);
  }
  escritorio = await comoUsuario(db, DONO, async (tx) => (await tx.query<{ id: string }>("select public.criar_escritorio('Prado Advocacia', null, 'equipe') as id")).rows[0].id);
  await chamar(DONO, "select public.salvar_monitoramento($1, 'oab', $2::jsonb)", [escritorio, JSON.stringify([{ numero: "54321", uf: "BA" }])]);
  for (const [uid, email, modulos] of [[RESP, "resp@exemplo.com", "{prazos,processos}"], [SO_PROCESSOS, "proc@exemplo.com", "{processos}"], [SO_AGENDA, "agenda@exemplo.com", "{agenda}"]] as const) {
    const token = await comoUsuario(db, DONO, async (tx) => (await tx.query<{ t: string }>("select public.criar_convite($1, $2, $3::text[]) as t", [escritorio, email, modulos])).rows[0].t);
    await chamar(uid, "select public.aceitar_convite($1)", [token]);
  }
  membroDono = (await um<{ id: string }>("select id from public.membro where usuario_id = $1", [DONO])).id;
  membroResp = (await um<{ id: string }>("select id from public.membro where usuario_id = $1", [RESP])).id;
  membroAgenda = (await um<{ id: string }>("select id from public.membro where usuario_id = $1", [SO_AGENDA])).id;

  await capturarEscritorio(escritorio, "agendada", { fontes: { publicacoes: [new FonteExemplo()], processos: null }, rpc: rpcComoServico(db), agora: () => new Date("2026-11-09T09:00:00Z") });
  processo = (await um<{ id: string }>("select id from public.processo where numero_cnj = $1", [PROC_CIVEL.digitos])).id;
});

describe("Calendário forense", () => {
  it("vem com feriados nacionais, móveis (pela Páscoa), 2 de Julho da Bahia e Carnaval/Corpus Christi do TJBA", async () => {
    const tem = async (data: string, escopo: string, descricao: string) =>
      (await um<{ n: number }>("select count(*)::int n from public.calendario_forense where escritorio_id is null and data = $1 and escopo = $2 and descricao = $3", [data, escopo, descricao])).n;
    expect(await tem("2026-04-03", "nacional", "Sexta-feira Santa")).toBe(1);
    expect(await tem("2027-03-26", "nacional", "Sexta-feira Santa")).toBe(1);
    expect(await tem("2026-11-20", "nacional", "Dia Nacional de Zumbi e da Consciência Negra")).toBe(1);
    expect(await tem("2026-07-02", "estadual", "Independência da Bahia")).toBe(1);
    expect(await tem("2027-02-08", "tribunal", "Carnaval (segunda-feira)")).toBe(1);
    expect(await tem("2027-02-09", "tribunal", "Carnaval (terça-feira)")).toBe(1);
    expect(await tem("2026-06-04", "tribunal", "Corpus Christi")).toBe(1);
  });

  it("dono acrescenta feriado municipal e suspensão; o motor de contagem passa a usar", async () => {
    const antes = calcularPrazo({ disponibilizacao: "2026-12-04", dias: 3, calendario: entradasDoTribunal(await carregarCalendario(), "TJBA") });
    await chamar(DONO, "select public.calendario_adicionar($1, '2026-12-08', null, 'municipal', 'TJBA', null, 'feriado', 'Nossa Senhora da Conceição (Salvador)')", [escritorio]);
    const depois = calcularPrazo({ disponibilizacao: "2026-12-04", dias: 3, calendario: entradasDoTribunal(await carregarCalendario(), "TJBA") });
    // 04/12 sexta → publ. 07/12 → início 08/12. Antes: 8,9,10 → 10/12. Com o feriado: 9,10,11 → 11/12.
    expect(antes.dataFinal).toBe("2026-12-10");
    expect(depois.dataFinal).toBe("2026-12-11");
    expect(depois.diasPulados.some((p) => p.data === "2026-12-08" && p.motivo === "feriado")).toBe(true);
  });

  it("só o dono edita; linhas globais e de outro escritório não se alteram; nacional não se cria por aqui", async () => {
    await expect(chamar(RESP, "select public.calendario_adicionar($1, '2026-12-09', null, 'tribunal', 'TJBA', null, 'feriado', 'Teste')", [escritorio])).rejects.toThrow(/sem_permissao/);
    await expect(chamar(DONO, "select public.calendario_adicionar($1, '2026-12-09', null, 'nacional', null, null, 'feriado', 'Teste')", [escritorio])).rejects.toThrow(/escopo_invalido/);
    await expect(chamar(DONO, "select public.calendario_adicionar($1, '2026-12-09', null, 'estadual', null, null, 'feriado', 'Sem UF')", [escritorio])).rejects.toThrow(/check constraint/);
    const global = await um<{ id: string }>("select id from public.calendario_forense where escritorio_id is null limit 1");
    await expect(chamar(DONO, "select public.calendario_remover($1)", [global.id])).rejects.toThrow(/nao_encontrado/);
    await expect(chamar(DONO, "delete from public.calendario_forense")).rejects.toThrow(/permission denied/);
    const dele = await um<{ id: string }>("select id from public.calendario_forense where escritorio_id = $1", [escritorio]);
    await expect(chamar(OUTRO, "select public.calendario_remover($1)", [dele.id])).rejects.toThrow(/sem_permissao/);
    // O outro escritório (OUTRO nem tem escritório) não enxerga o calendário do Prado, só o global.
    await comoUsuario(db, OUTRO, (tx) => tx.query("select public.criar_escritorio('Outro', null, 'solo')"));
    const vistas = await comoUsuario(db, OUTRO, async (tx) => (await tx.query("select 1 from public.calendario_forense where escritorio_id is not null")).rows.length);
    expect(vistas).toBe(0);
  });
});

describe("Critério de pronto: fluxo da publicação ao prazo", () => {
  it("a publicação ligada a processo confirmado sugere dias a partir do texto; só depois de confirmar o prazo existe", async () => {
    // Processo ainda provisório: o banco recusa prazo.
    await expect(criarPrazo(DONO, { dispon: "2026-11-09", dias: 15 })).rejects.toThrow(/processo_nao_confirmado/);
    await chamar(DONO, "select public.confirmar_processo($1)", [processo]);

    const pub = await um<{ texto: string; data_disponibilizacao: string }>("select texto, data_disponibilizacao::text from public.publicacao where id_externo = '910001'");
    expect(sugerirDiasDoTexto(pub.texto)).toMatchObject({ dias: 15 });
    expect((await um<{ n: number }>("select count(*)::int n from public.prazo")).n).toBe(0);

    const { id, resultado } = await criarPrazo(RESP, { dispon: pub.data_disponibilizacao, dias: 15 });
    // 09/11 segunda → publ. 10/11 → início 11/11 (dia 1) → 15 úteis pulando 20/11 (feriado) → 02/12
    expect(resultado).toMatchObject({ publicacao: "2026-11-10", inicioContagem: "2026-11-11", dataFinal: "2026-12-02" });
    const salvo = await um<{ data_final: string; status: string; raciocinio: { aviso: string; passos: unknown[] }; criado_por: string }>(
      "select data_final::text, status, raciocinio, criado_por from public.prazo where id = $1", [id],
    );
    expect(salvo).toMatchObject({ data_final: "2026-12-02", status: "aberto", criado_por: RESP });
    expect(salvo.raciocinio.aviso).toBe("Prazo sugerido. Confira no sistema oficial do tribunal.");
    expect(salvo.raciocinio.passos.length).toBeGreaterThanOrEqual(5);
  });

  it("responsável precisa poder ver prazos; quem só tem Agenda não cria nem vê", async () => {
    await expect(criarPrazo(DONO, { dispon: "2026-11-09", dias: 5, resp: membroAgenda })).rejects.toThrow(/responsavel_invalido/);
    await expect(criarPrazo(SO_AGENDA, { dispon: "2026-11-09", dias: 5 })).rejects.toThrow(/sem_permissao/);
    await expect(criarPrazo(SO_PROCESSOS, { dispon: "2026-11-09", dias: 5 })).rejects.toThrow(/sem_permissao/);
    const ver = (uid: string) => comoUsuario(db, uid, async (tx) => (await tx.query("select id from public.prazo")).rows.length);
    expect(await ver(DONO)).toBe(1);
    expect(await ver(RESP)).toBe(1);
    expect(await ver(SO_PROCESSOS)).toBe(0);
    expect(await ver(SO_AGENDA)).toBe(0);
    expect(await ver(OUTRO)).toBe(0);
    const lista = await comoUsuario(db, DONO, async (tx) => (await tx.query<{ id: string }>("select id from public.responsaveis_prazo($1)", [escritorio])).rows.map((r) => r.id));
    expect(lista.sort()).toEqual([membroDono, membroResp].sort());
  });

  it("app não grava prazo direto, nem chama funções do job; tudo fica na auditoria", async () => {
    await expect(chamar(DONO, "update public.prazo set data_final = '2030-01-01'")).rejects.toThrow(/permission denied/);
    await expect(chamar(DONO, "insert into public.prazo_alerta (escritorio_id, prazo_id, tipo, data_ref) values ($1, gen_random_uuid(), 'dia', '2026-11-20')", [escritorio])).rejects.toThrow(/permission denied/);
    await expect(chamar(DONO, "select public.alertas_candidatos('2030-01-01')")).rejects.toThrow(/permission denied/);
    await expect(chamar(DONO, "select public.alerta_reservar(gen_random_uuid(), 'dia', '2026-11-20', 'x', 'y', null)")).rejects.toThrow(/permission denied/);
    expect((await um<{ n: number }>("select count(*)::int n from public.audit_log where tabela = 'prazo' and acao = 'insert' and usuario_id = $1", [RESP])).n).toBe(1);
  });

  it("publicação sem prazo pode ser dispensada (não apaga)", async () => {
    const pub = await um<{ id: string }>("select id from public.publicacao where id_externo = '910001'");
    await chamar(RESP, "select public.dispensar_prazo_publicacao($1)", [pub.id]);
    expect((await um<{ ok: boolean }>("select sem_prazo_em is not null ok from public.publicacao where id = $1", [pub.id])).ok).toBe(true);
    await expect(chamar(SO_AGENDA, "select public.dispensar_prazo_publicacao($1)", [pub.id])).rejects.toThrow(/sem_permissao/);
  });
});

describe("Status do prazo", () => {
  it("cumprir, cancelar e reabrir; cumprido registra a hora; status inválido é recusado", async () => {
    const { id } = await criarPrazo(DONO, { dispon: "2026-11-09", dias: 5, desc: "Prazo de teste de status" });
    await chamar(RESP, "select public.alterar_status_prazo($1, 'cumprido')", [id]);
    expect(await um("select status, cumprido_em is not null feito from public.prazo where id = $1", [id])).toEqual({ status: "cumprido", feito: true });
    await chamar(RESP, "select public.alterar_status_prazo($1, 'aberto')", [id]);
    expect(await um("select status, cumprido_em is null vazio from public.prazo where id = $1", [id])).toEqual({ status: "aberto", vazio: true });
    await chamar(RESP, "select public.alterar_status_prazo($1, 'cancelado')", [id]);
    await expect(chamar(RESP, "select public.alterar_status_prazo($1, 'vencido')", [id])).rejects.toThrow(/status_invalido/);
    await expect(chamar(SO_PROCESSOS, "select public.alterar_status_prazo($1, 'aberto')", [id])).rejects.toThrow(/sem_permissao/);
    await chamar(DONO, "select public.alterar_responsavel_prazo($1, $2)", [id, membroDono]);
    await expect(chamar(DONO, "select public.alterar_responsavel_prazo($1, $2)", [id, membroAgenda])).rejects.toThrow(/responsavel_invalido/);
  });
});

describe("Critério de pronto: alertas nos três momentos, com relógio simulado", () => {
  // 7h em Brasília = 10h UTC.
  const as7 = (dia: string) => new Date(`${dia}T10:00:00Z`);
  const enviados: { para: string; assunto: string }[] = [];
  let falhar = false;
  const email = {
    async enviarAviso(p: { para: string; assunto: string; texto: string }): Promise<ResultadoEnvio> {
      if (falhar) return { enviado: false, motivo: "provedor fora do ar" };
      enviados.push({ para: p.para, assunto: p.assunto });
      return { enviado: true };
    },
  };
  const rodar = (agora: Date) => executarAlertas({ rpc: rpcComoServico(db), email, agora: () => agora, urlBase: "https://law.exemplo.com.br" });
  const avisos = async (uid = RESP) => comoUsuario(db, uid, async (tx) => (await tx.query<{ tipo: string; titulo: string; corpo: string; lida_em: string | null }>("select tipo, titulo, corpo, lida_em::text from public.notificacao order by criado_em, id")).rows);
  let prazoId: string;

  beforeAll(async () => {
    // Desfaz os prazos dos testes anteriores para isolar este cenário.
    await db.query("update public.prazo set status = 'cancelado'");
    // 17 dias úteis a partir de 09/11 (pulando o feriado de 20/11) vencem na sexta 04/12/2026.
    const criado = await criarPrazo(DONO, { dispon: "2026-11-09", dias: 17, desc: "Contestação — alerta" });
    expect(criado.resultado.dataFinal).toBe("2026-12-04");
    prazoId = criado.id;
  });

  it("antes das 7h não avisa ninguém", async () => {
    expect(await rodar(new Date("2026-12-01T09:59:00Z"))).toMatchObject({ enviados: 0 });
    expect(enviados).toHaveLength(0);
  });

  it("4 dias antes: nada. 3 dias antes às 7h: aviso no app e e-mail ao responsável, uma vez só", async () => {
    expect(await rodar(as7("2026-11-30"))).toMatchObject({ enviados: 0 });
    expect(await rodar(as7("2026-12-01"))).toMatchObject({ analisados: 1, enviados: 1, emailsFalharam: 0 });
    expect(await rodar(as7("2026-12-01"))).toMatchObject({ enviados: 0 }); // rodar de novo não repete
    expect(enviados).toEqual([{ para: "resp@exemplo.com", assunto: expect.stringContaining("vence em 3 dias") }]);
    const a = await avisos();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ tipo: "prazo_antes_3", lida_em: null });
    expect(a[0].corpo).toContain("04/12/2026");
    expect(a[0].corpo).toContain("Prazo sugerido. Confira no sistema oficial do tribunal.");
    expect(await avisos(DONO)).toHaveLength(0); // só o responsável recebe
  });

  it("no dia do vencimento, às 7h", async () => {
    expect(await rodar(as7("2026-12-02"))).toMatchObject({ enviados: 0 });
    expect(await rodar(as7("2026-12-03"))).toMatchObject({ enviados: 0 });
    expect(await rodar(as7("2026-12-04"))).toMatchObject({ enviados: 1 });
    expect((await avisos()).map((x) => x.tipo)).toEqual(["prazo_antes_3", "prazo_dia"]);
    expect(enviados.at(-1)!.assunto).toContain("vence HOJE");
  });

  it("depois de vencido, todo dia às 7h — mesmo com e-mail fora do ar o aviso no app sai", async () => {
    expect(await rodar(as7("2026-12-05"))).toMatchObject({ enviados: 1 });
    falhar = true;
    expect(await rodar(as7("2026-12-06"))).toMatchObject({ enviados: 1, emailsFalharam: 1 });
    falhar = false;
    expect(await rodar(as7("2026-12-06"))).toMatchObject({ enviados: 0 });
    expect(await rodar(as7("2026-12-07"))).toMatchObject({ enviados: 1 });
    expect((await avisos()).map((x) => x.tipo)).toEqual(["prazo_antes_3", "prazo_dia", "prazo_vencido", "prazo_vencido", "prazo_vencido"]);
    expect(await linhas("select tipo, data_ref::text, email_status from public.prazo_alerta where prazo_id = $1 order by data_ref, tipo", [prazoId])).toEqual([
      { tipo: "antes_3", data_ref: "2026-12-04", email_status: "enviado" },
      { tipo: "dia", data_ref: "2026-12-04", email_status: "enviado" },
      { tipo: "vencido", data_ref: "2026-12-05", email_status: "enviado" },
      { tipo: "vencido", data_ref: "2026-12-06", email_status: "falhou" },
      { tipo: "vencido", data_ref: "2026-12-07", email_status: "enviado" },
    ]);
  });

  it("marcado como cumprido, para de avisar; o responsável marca os avisos como lidos", async () => {
    await chamar(RESP, "select public.alterar_status_prazo($1, 'cumprido')", [prazoId]);
    const antes = (await avisos()).length;
    expect(await rodar(as7("2026-12-08"))).toMatchObject({ analisados: 0, enviados: 0 });
    expect(await rodar(as7("2027-01-05"))).toMatchObject({ enviados: 0 });
    expect(await avisos()).toHaveLength(antes);

    const n = await comoUsuario(db, RESP, async (tx) => (await tx.query<{ n: number }>("select public.marcar_notificacoes_lidas(null) n")).rows[0].n);
    expect(n).toBe(antes);
    expect((await avisos()).every((x) => x.lida_em !== null)).toBe(true);
    // Quem não é o dono do aviso não consegue marcar nem ler.
    expect(await comoUsuario(db, DONO, async (tx) => (await tx.query<{ n: number }>("select public.marcar_notificacoes_lidas(null) n")).rows[0].n)).toBe(0);
  });
});
