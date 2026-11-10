import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { comoUsuario, criarBanco, criarUsuario } from "./banco";
import { capturarEscritorio, capturarTodos, type ChamarRpc, type DepsCaptura } from "@/lib/captura/job";
import { FonteExemplo, PROC_CIVEL } from "@/lib/integrations/fontes/exemplos";
import { ErroFonte } from "@/lib/integrations/fontes/fila";
import type { FonteJuridica, ProcessoMetadados } from "@/lib/integrations/fontes/tipos";

const DONO = "00000000-0000-4000-8000-0000000000d1";
const MEMBRO_PRAZOS = "00000000-0000-4000-8000-0000000000d2";
const MEMBRO_AGENDA = "00000000-0000-4000-8000-0000000000d3";
const OUTRO_DONO = "00000000-0000-4000-8000-0000000000d4";

let db: PGlite;

/** RPC como o job faz em produção (papel service_role). */
function rpcDe(banco: PGlite): ChamarRpc {
  return async <T,>(funcao: string, args: Record<string, unknown>) => {
    const nomes = Object.keys(args);
    const valores = nomes.map((n) => {
      const v = args[n];
      const ehListaDeTexto = Array.isArray(v) && v.every((x) => typeof x === "string");
      return v !== null && typeof v === "object" && !ehListaDeTexto ? JSON.stringify(v) : v;
    });
    const sql = `select public.${funcao}(${nomes.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`;
    return banco.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      const res = await tx.query<{ r: T }>(sql, valores);
      return res.rows[0]?.r as T;
    });
  };
}

/** DataJud de mentira: conhece só o processo cível do exemplo. */
function dataJudFalso(modo: "ok" | "falha"): FonteJuridica & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    nome: "datajud",
    capacidades: { publicacoes: false, processo: true, movimentacoes: true },
    chamadas,
    async buscarPublicacoes() { return []; },
    async buscarMovimentacoes() { return []; },
    async buscarProcesso(numero: string): Promise<ProcessoMetadados | null> {
      chamadas.push(numero);
      if (modo === "falha") throw new ErroFonte("DataJud", "indisponivel", "DataJud está instável (HTTP 503).", 503);
      if (numero !== PROC_CIVEL.digitos) return null;
      return {
        numeroCnj: numero, tribunal: "TJBA", classe: { codigo: "7", nome: "Procedimento Comum Cível" },
        assuntos: [{ codigo: "10433", nome: "Indenização por Dano Moral" }], orgaoJulgador: "3ª Vara Cível",
        grau: "G1", dataAjuizamento: "2025-03-14T00:00:00", nivelSigilo: 0, partes: [], movimentos: [], bruto: {},
      };
    },
  };
}

const djenBloqueado: FonteJuridica = {
  nome: "djen",
  capacidades: { publicacoes: true, processo: false, movimentacoes: false },
  async buscarPublicacoes() { throw new ErroFonte("DJEN", "bloqueado", "DJEN recusou o acesso (HTTP 403).", 403); },
  async buscarProcesso() { return null; },
  async buscarMovimentacoes() { return []; },
};

const AGORA = new Date("2026-11-09T09:00:00Z"); // 06h em Brasília

async function novoEscritorio(dono: string, nome: string, oabs: { numero: string; uf: string }[]) {
  const id = await comoUsuario(db, dono, async (tx) => (await tx.query<{ id: string }>("select public.criar_escritorio($1, null, 'equipe') as id", [nome])).rows[0].id);
  await comoUsuario(db, dono, (tx) => tx.query("select public.salvar_monitoramento($1, 'oab', $2::jsonb)", [id, JSON.stringify(oabs)]));
  return id;
}

const contar = async (sql: string, p: unknown[] = []) => (await db.query<{ n: number }>(sql, p)).rows[0].n;

let escritorio: string;

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, email] of [[DONO, "dona@exemplo.com"], [MEMBRO_PRAZOS, "prazos@exemplo.com"], [MEMBRO_AGENDA, "agenda@exemplo.com"], [OUTRO_DONO, "outro@exemplo.com"]]) {
    await criarUsuario(db, id, email);
  }
  escritorio = await novoEscritorio(DONO, "Prado Advocacia", [{ numero: "54321", uf: "BA" }]);
});

describe("Critério de pronto: captura sem duplicar", () => {
  it("primeira captura grava as publicações, extrai o nº CNJ e enriquece pelo DataJud", async () => {
    const dataJud = dataJudFalso("ok");
    const deps: DepsCaptura = { fontes: { publicacoes: [new FonteExemplo()], processos: dataJud }, rpc: rpcDe(db), agora: () => AGORA };
    const r = await capturarEscritorio(escritorio, "onboarding", deps);

    expect(r).toMatchObject({ status: "sucesso", desde: "2026-10-10", ate: "2026-11-09", encontradas: 4, novas: 4, duplicadas: 0, enriquecidos: 1 });
    expect(await contar("select count(*)::int n from public.publicacao where escritorio_id = $1", [escritorio])).toBe(4);

    const civel = await db.query<{ numero_cnj: string; texto: string; data_publicacao: string; status_triagem: string; advogados: unknown }>(
      "select numero_cnj, texto, data_publicacao::text, status_triagem, advogados from public.publicacao where id_externo = '910001'",
    );
    // Já passou pela triagem automática (Prompt 3): ligada ao processo provisório.
    expect(civel.rows[0]).toMatchObject({ numero_cnj: PROC_CIVEL.digitos, data_publicacao: "2026-11-10", status_triagem: "aguardando" });
    expect(civel.rows[0].texto).not.toMatch(/script|alert/);
    expect(civel.rows[0].advogados).toEqual([{ nome: "ADVOGADA EXEMPLO", oab: "54321", uf: "BA" }]);

    // Sem nº identificável fica nulo (vai para "Publicações sem processo" no Prompt 3).
    expect(await contar("select count(*)::int n from public.publicacao where escritorio_id = $1 and numero_cnj is null", [escritorio])).toBe(1);
    // O JSON original fica guardado.
    expect(await contar("select count(*)::int n from public.publicacao where bruto ? 'destinatarioadvogados'")).toBe(4);

    const meta = await db.query<{ dados: { classe: { nome: string } } }>("select dados from public.processo_metadados where numero_cnj = $1", [PROC_CIVEL.digitos]);
    expect(meta.rows[0].dados.classe.nome).toBe("Procedimento Comum Cível");

    const esc = await db.query<{ status_monitoramento: string; ultima_captura_ate: string }>(
      "select status_monitoramento, ultima_captura_ate::text from public.escritorio where id = $1", [escritorio],
    );
    expect(esc.rows[0]).toEqual({ status_monitoramento: "concluido", ultima_captura_ate: "2026-11-09" });
  });

  it("rodar de novo não duplica nada e busca só desde a última captura menos 2 dias", async () => {
    const dataJud = dataJudFalso("ok");
    const deps: DepsCaptura = { fontes: { publicacoes: [new FonteExemplo()], processos: dataJud }, rpc: rpcDe(db), agora: () => AGORA };
    const r = await capturarEscritorio(escritorio, "agendada", deps);
    expect(r).toMatchObject({ status: "sucesso", desde: "2026-11-07", encontradas: 4, novas: 0, duplicadas: 4 });
    expect(await contar("select count(*)::int n from public.publicacao where escritorio_id = $1", [escritorio])).toBe(4);
    // Processo já enriquecido nas últimas 24 h não é consultado de novo.
    expect(dataJud.chamadas).not.toContain(PROC_CIVEL.digitos);
  });

  it("cada execução fica registrada com início, fim, contagens e erros", async () => {
    const r = await db.query<{ origem: string; status: string; novas: number; duplicadas: number; terminada: boolean }>(
      "select origem, status, novas, duplicadas, terminada_em is not null as terminada from public.captura_execucao where escritorio_id = $1 order by iniciada_em",
      [escritorio],
    );
    expect(r.rows).toEqual([
      { origem: "onboarding", status: "sucesso", novas: 4, duplicadas: 0, terminada: true },
      { origem: "agendada", status: "sucesso", novas: 0, duplicadas: 4, terminada: true },
    ]);
  });
});

describe("Critério de pronto: falha no DataJud não impede a gravação", () => {
  it("publicações gravadas, execução parcial, erro registrado e escritório em dia", async () => {
    const id = await novoEscritorio(OUTRO_DONO, "Outro Escritório", [{ numero: "777", uf: "SE" }]);
    const dataJud = dataJudFalso("falha");
    const r = await capturarEscritorio(id, "agendada", { fontes: { publicacoes: [new FonteExemplo()], processos: dataJud }, rpc: rpcDe(db), agora: () => AGORA });

    expect(r).toMatchObject({ status: "parcial", novas: 4, enriquecidos: 0 });
    expect(r!.erros.every((e) => e.fonte === "datajud" && e.codigo === "indisponivel")).toBe(true);
    expect(await contar("select count(*)::int n from public.publicacao where escritorio_id = $1", [id])).toBe(4);
    expect(await contar("select count(*)::int n from public.processo_metadados where escritorio_id = $1 and erro = 'indisponivel'", [id])).toBe(dataJud.chamadas.length);
    const esc = await db.query<{ status_monitoramento: string; ok: boolean }>(
      "select status_monitoramento, ultima_captura_ok_em is not null as ok from public.escritorio where id = $1", [id],
    );
    expect(esc.rows[0]).toEqual({ status_monitoramento: "concluido", ok: true });
  });
});

describe("Falha de publicação vira alerta, nunca 'nenhuma publicação'", () => {
  it("DJEN bloqueado: execução com erro, escritório em erro e período não avança", async () => {
    const antes = await db.query<{ ate: string }>("select ultima_captura_ate::text ate from public.escritorio where id = $1", [escritorio]);
    const r = await capturarEscritorio(escritorio, "agendada", {
      fontes: { publicacoes: [djenBloqueado], processos: dataJudFalso("ok") }, rpc: rpcDe(db), agora: () => new Date("2026-11-12T09:00:00Z"),
    });
    expect(r).toMatchObject({ status: "erro", encontradas: 0 });
    expect(r!.erros[0]).toMatchObject({ fonte: "djen", codigo: "bloqueado", alvo: "OAB 54321/BA" });
    const depois = await db.query<{ status_monitoramento: string; ate: string }>(
      "select status_monitoramento, ultima_captura_ate::text ate from public.escritorio where id = $1", [escritorio],
    );
    expect(depois.rows[0]).toEqual({ status_monitoramento: "erro", ate: antes.rows[0].ate });
  });

  it("capturarTodos segue para o próximo escritório quando um falha", async () => {
    const umaFonte: FonteJuridica = {
      ...new FonteExemplo(),
      nome: "exemplo",
      capacidades: { publicacoes: true, processo: false, movimentacoes: false },
      async buscarPublicacoes(f) {
        if (f.oab?.numero === "54321") throw new ErroFonte("DJEN", "indisponivel", "instável", 500);
        return new FonteExemplo().buscarPublicacoes(f);
      },
      async buscarProcesso() { return null; },
      async buscarMovimentacoes() { return []; },
    };
    const resumos = await capturarTodos("agendada", { fontes: { publicacoes: [umaFonte], processos: null }, rpc: rpcDe(db), agora: () => AGORA });
    expect(resumos).toHaveLength(2);
    expect(resumos.map((r) => r.status).sort()).toEqual(["erro", "sucesso"]);
  });
});

describe("Quem vê as publicações (RLS)", () => {
  beforeAll(async () => {
    for (const [uid, email, modulos] of [[MEMBRO_PRAZOS, "prazos@exemplo.com", "{prazos}"], [MEMBRO_AGENDA, "agenda@exemplo.com", "{agenda}"]] as const) {
      const token = await comoUsuario(db, DONO, async (tx) =>
        (await tx.query<{ t: string }>("select public.criar_convite($1, $2, $3::text[]) as t", [escritorio, email, modulos])).rows[0].t,
      );
      await comoUsuario(db, uid, (tx) => tx.query("select public.aceitar_convite($1)", [token]));
    }
  });

  it("dono e membro com Prazos veem; membro só com Agenda e gente de fora não veem", async () => {
    const ver = (uid: string) => comoUsuario(db, uid, async (tx) => (await tx.query("select id from public.publicacao where escritorio_id = $1", [escritorio])).rows.length);
    expect(await ver(DONO)).toBe(4);
    expect(await ver(MEMBRO_PRAZOS)).toBe(4);
    expect(await ver(MEMBRO_AGENDA)).toBe(0);
    expect(await ver(OUTRO_DONO)).toBe(0);
  });

  it("app não grava publicação nem chama as funções do job; triagem só pelas funções de triagem", async () => {
    await expect(
      comoUsuario(db, DONO, (tx) => tx.query("select public.captura_salvar_publicacoes($1, null, '[]'::jsonb)", [escritorio])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      comoUsuario(db, DONO, (tx) => tx.query("delete from public.publicacao where escritorio_id = $1", [escritorio])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      comoUsuario(db, DONO, (tx) => tx.query("update public.publicacao set texto = 'x' where escritorio_id = $1", [escritorio])),
    ).rejects.toThrow(/permission denied/);
    // Desde o Prompt 3 nem o status muda direto: só por descartar/ligar (que conferem a permissão Processos).
    await expect(
      comoUsuario(db, MEMBRO_PRAZOS, (tx) => tx.query("update public.publicacao set status_triagem = 'descartada' where escritorio_id = $1", [escritorio])),
    ).rejects.toThrow(/permission denied/);
    const semProcesso = await db.query<{ id: string }>("select id from public.publicacao where escritorio_id = $1 and numero_cnj is null", [escritorio]);
    await expect(
      comoUsuario(db, MEMBRO_PRAZOS, (tx) => tx.query("select public.descartar_publicacao($1)", [semProcesso.rows[0].id])),
    ).rejects.toThrow(/sem_permissao/);
    await comoUsuario(db, DONO, (tx) => tx.query("select public.descartar_publicacao($1)", [semProcesso.rows[0].id]));
    expect(await contar("select count(*)::int n from public.audit_log where tabela = 'publicacao' and acao = 'update' and usuario_id = $1", [DONO])).toBe(1);
  });

  it("todo membro vê o histórico de capturas (para o aviso de atraso chegar a todos)", async () => {
    const n = await comoUsuario(db, MEMBRO_AGENDA, async (tx) => (await tx.query("select id from public.captura_execucao")).rows.length);
    expect(n).toBeGreaterThan(0);
  });
});
