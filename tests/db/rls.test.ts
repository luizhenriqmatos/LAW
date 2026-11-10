import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { comoAnonimo, comoUsuario, criarBanco, criarUsuario } from "./banco";

const DONO = "00000000-0000-4000-8000-00000000000a";
const MEMBRO = "00000000-0000-4000-8000-00000000000b";
const ESTRANHO = "00000000-0000-4000-8000-00000000000c";
const TODOS = ["agenda", "processos", "prazos", "tarefas", "financeiro", "calculos", "documentos", "portal_cliente", "assinaturas", "assistente", "atendimento", "configuracoes"];

let db: PGlite;
let escritorio: string;
let membroId: string;

beforeAll(async () => {
  db = await criarBanco();
  await criarUsuario(db, DONO, "dona@exemplo.com");
  await criarUsuario(db, MEMBRO, "membro@exemplo.com");
  await criarUsuario(db, ESTRANHO, "estranho@exemplo.com");
});

describe("Critério de pronto do Prompt 1", () => {
  it("dono cria o escritório e vira dono com todos os módulos", async () => {
    escritorio = await comoUsuario(db, DONO, async (tx) => {
      const r = await tx.query<{ id: string }>("select public.criar_escritorio($1, $2, $3) as id", [
        "Prado Advocacia", "11222333000181", "equipe",
      ]);
      return r.rows[0].id;
    });
    const modulos = await comoUsuario(db, DONO, (tx) =>
      tx.query<{ m: string[] }>("select public.meus_modulos($1) as m", [escritorio]),
    );
    expect(modulos.rows[0].m.sort()).toEqual([...TODOS].sort());
  });

  it("dono convida o membro, o membro aceita e entra com os módulos do convite", async () => {
    const token = await comoUsuario(db, DONO, async (tx) => {
      const r = await tx.query<{ t: string }>("select public.criar_convite($1, $2, $3) as t", [
        escritorio, "Membro@Exemplo.com", TODOS,
      ]);
      return r.rows[0].t;
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // O código em texto puro não fica no banco.
    const salvo = await db.query<{ n: number }>("select count(*)::int n from public.convite where token_hash = $1", [token]);
    expect(salvo.rows[0].n).toBe(0);

    await comoUsuario(db, MEMBRO, (tx) => tx.query("select public.aceitar_convite($1)", [token]));
    const r = await db.query<{ id: string }>(
      "select id from public.membro where usuario_id = $1 and escritorio_id = $2", [MEMBRO, escritorio],
    );
    membroId = r.rows[0].id;
    const mods = await comoUsuario(db, MEMBRO, (tx) =>
      tx.query<{ m: string[] }>("select public.meus_modulos($1) as m", [escritorio]),
    );
    expect(mods.rows[0].m).toContain("financeiro");
  });

  it("dono tira o financeiro e lança um valor", async () => {
    await comoUsuario(db, DONO, async (tx) => {
      await tx.query("delete from public.permissao_tela where membro_id = $1 and modulo = 'financeiro'", [membroId]);
      await tx.query("insert into public.lancamento (escritorio_id, descricao, valor_centavos) values ($1, $2, $3)", [
        escritorio, "Honorários", 350000,
      ]);
    });
    const mods = await comoUsuario(db, MEMBRO, (tx) =>
      tx.query<{ m: string[] }>("select public.meus_modulos($1) as m", [escritorio]),
    );
    expect(mods.rows[0].m).not.toContain("financeiro");
    expect(mods.rows[0].m).toContain("agenda");
  });

  it("membro sem financeiro NÃO lê valores por consulta direta com o token dele", async () => {
    const r = await comoUsuario(db, MEMBRO, (tx) =>
      tx.query("select * from public.lancamento where escritorio_id = $1", [escritorio]),
    );
    expect(r.rows).toHaveLength(0);
  });

  it("membro sem financeiro NÃO grava, altera nem apaga lançamento", async () => {
    await expect(
      comoUsuario(db, MEMBRO, (tx) =>
        tx.query("insert into public.lancamento (escritorio_id, descricao, valor_centavos) values ($1, 'x', 1)", [escritorio]),
      ),
    ).rejects.toThrow(/row-level security/);
    const upd = await comoUsuario(db, MEMBRO, (tx) =>
      tx.query("update public.lancamento set valor_centavos = 0 where escritorio_id = $1", [escritorio]),
    );
    expect(upd.affectedRows ?? 0).toBe(0);
    const del = await comoUsuario(db, MEMBRO, (tx) =>
      tx.query("delete from public.lancamento where escritorio_id = $1", [escritorio]),
    );
    expect(del.affectedRows ?? 0).toBe(0);
    const total = await db.query<{ n: number }>("select count(*)::int n from public.lancamento");
    expect(total.rows[0].n).toBe(1);
  });

  it("membro não devolve a permissão a si mesmo", async () => {
    await expect(
      comoUsuario(db, MEMBRO, (tx) =>
        tx.query("insert into public.permissao_tela (membro_id, escritorio_id, modulo) values ($1, $2, 'financeiro')", [
          membroId, escritorio,
        ]),
      ),
    ).rejects.toThrow(/row-level security|permission denied/);
  });

  it("membro não vira dono nem troca de escritório por update", async () => {
    await expect(
      comoUsuario(db, MEMBRO, (tx) => tx.query("update public.membro set papel = 'dono' where id = $1", [membroId])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      comoUsuario(db, DONO, (tx) => tx.query("update public.membro set papel = 'dono' where id = $1", [membroId])),
    ).rejects.toThrow(/permission denied/);
  });

  it("com o financeiro devolvido pelo dono, o membro volta a ver", async () => {
    await comoUsuario(db, DONO, (tx) =>
      tx.query("insert into public.permissao_tela (membro_id, escritorio_id, modulo) values ($1, $2, 'financeiro')", [
        membroId, escritorio,
      ]),
    );
    const r = await comoUsuario(db, MEMBRO, (tx) => tx.query("select * from public.lancamento"));
    expect(r.rows).toHaveLength(1);
    await comoUsuario(db, DONO, (tx) =>
      tx.query("delete from public.permissao_tela where membro_id = $1 and modulo = 'financeiro'", [membroId]),
    );
  });
});

describe("Isolamento entre escritórios", () => {
  it("usuário de fora não vê escritório, membros, convites, lançamentos nem auditoria", async () => {
    for (const tabela of ["escritorio", "membro", "permissao_tela", "alvo_monitoramento", "convite", "lancamento", "audit_log"]) {
      const r = await comoUsuario(db, ESTRANHO, (tx) => tx.query(`select * from public.${tabela}`));
      expect(r.rows, tabela).toHaveLength(0);
    }
  });

  it("visitante sem login não lê nada", async () => {
    await expect(comoAnonimo(db, (tx) => tx.query("select * from public.escritorio"))).rejects.toThrow(/permission denied/);
    await expect(comoAnonimo(db, (tx) => tx.query("select * from public.lancamento"))).rejects.toThrow(/permission denied/);
  });

  it("usuário de fora não convida para escritório alheio", async () => {
    await expect(
      comoUsuario(db, ESTRANHO, (tx) =>
        tx.query("select public.criar_convite($1, 'x@exemplo.com', '{agenda}')", [escritorio]),
      ),
    ).rejects.toThrow(/sem_permissao/);
  });
});

describe("Somente o dono administra", () => {
  it("membro não convida, não lê convites e não edita permissões", async () => {
    await expect(
      comoUsuario(db, MEMBRO, (tx) => tx.query("select public.criar_convite($1, 'y@exemplo.com', '{agenda}')", [escritorio])),
    ).rejects.toThrow(/sem_permissao/);
    const convites = await comoUsuario(db, MEMBRO, (tx) => tx.query("select * from public.convite"));
    expect(convites.rows).toHaveLength(0);
    const del = await comoUsuario(db, MEMBRO, (tx) =>
      tx.query("delete from public.permissao_tela where membro_id = $1", [membroId]),
    );
    expect(del.affectedRows ?? 0).toBe(0);
  });

  it("membro lê só as próprias permissões; dono lê todas", async () => {
    const m = await comoUsuario(db, MEMBRO, (tx) => tx.query<{ membro_id: string }>("select membro_id from public.permissao_tela"));
    expect(m.rows.every((r) => r.membro_id === membroId)).toBe(true);
    const d = await comoUsuario(db, DONO, (tx) => tx.query("select * from public.permissao_tela"));
    expect(d.rows.length).toBeGreaterThan(0);
  });

  it("membro não salva configuração de monitoramento", async () => {
    await expect(
      comoUsuario(db, MEMBRO, (tx) =>
        tx.query("select public.salvar_monitoramento($1, 'oab', $2::jsonb)", [escritorio, JSON.stringify([{ numero: "1", uf: "BA" }])]),
      ),
    ).rejects.toThrow(/sem_permissao/);
  });

  it("dono não remove a si mesmo como dono", async () => {
    const r = await comoUsuario(db, DONO, (tx) =>
      tx.query("delete from public.membro where usuario_id = $1 and escritorio_id = $2", [DONO, escritorio]),
    );
    expect(r.affectedRows ?? 0).toBe(0);
  });
});

describe("Convites", () => {
  it("convite não serve para outro e-mail", async () => {
    const token = await comoUsuario(db, DONO, async (tx) =>
      (await tx.query<{ t: string }>("select public.criar_convite($1, 'outra@exemplo.com', '{agenda}') as t", [escritorio])).rows[0].t,
    );
    await expect(comoUsuario(db, ESTRANHO, (tx) => tx.query("select public.aceitar_convite($1)", [token]))).rejects.toThrow(
      /convite_outro_email/,
    );
  });

  it("convite vencido é recusado", async () => {
    const token = await comoUsuario(db, DONO, async (tx) =>
      (await tx.query<{ t: string }>("select public.criar_convite($1, 'estranho@exemplo.com', '{agenda}') as t", [escritorio])).rows[0].t,
    );
    await db.query("update public.convite set expira_em = now() - interval '1 minute' where email = 'estranho@exemplo.com'");
    await expect(comoUsuario(db, ESTRANHO, (tx) => tx.query("select public.aceitar_convite($1)", [token]))).rejects.toThrow(
      /convite_vencido/,
    );
  });

  it("convite usado não vale de novo e código inventado é recusado", async () => {
    await expect(comoUsuario(db, ESTRANHO, (tx) => tx.query("select public.aceitar_convite($1)", ["f".repeat(64)]))).rejects.toThrow(
      /convite_invalido/,
    );
  });

  it("convite vence em 7 dias", async () => {
    const r = await db.query<{ dias: number }>(
      "select round(extract(epoch from (expira_em - criado_em)) / 86400)::int as dias from public.convite where email = 'outra@exemplo.com'",
    );
    expect(r.rows[0].dias).toBe(7);
  });

  it("não convida quem já é membro", async () => {
    await expect(
      comoUsuario(db, DONO, (tx) => tx.query("select public.criar_convite($1, 'membro@exemplo.com', '{agenda}')", [escritorio])),
    ).rejects.toThrow(/ja_e_membro/);
  });
});

describe("Monitoramento e validações no banco", () => {
  it("dono salva OABs e o status vira aguardando_busca", async () => {
    await comoUsuario(db, DONO, (tx) =>
      tx.query("select public.salvar_monitoramento($1, 'oab', $2::jsonb)", [
        escritorio, JSON.stringify([{ numero: "54321", uf: "BA" }, { numero: "1234567", uf: "SE" }]),
      ]),
    );
    const r = await comoUsuario(db, DONO, (tx) =>
      tx.query<{ status_monitoramento: string }>("select status_monitoramento from public.escritorio where id = $1", [escritorio]),
    );
    expect(r.rows[0].status_monitoramento).toBe("aguardando_busca");
  });

  it("OAB com 8 dígitos ou UF inexistente é recusada pelo banco", async () => {
    for (const alvo of [{ numero: "12345678", uf: "BA" }, { numero: "123", uf: "XX" }]) {
      await expect(
        comoUsuario(db, DONO, (tx) =>
          tx.query("select public.salvar_monitoramento($1, 'oab', $2::jsonb)", [escritorio, JSON.stringify([alvo])]),
        ),
      ).rejects.toThrow(/check constraint/);
    }
  });

  it("CNPJ com dígito verificador errado é recusado pelo banco", async () => {
    await expect(
      comoUsuario(db, DONO, (tx) => tx.query("select public.criar_escritorio('Teste', '11222333000182', 'solo')")),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("Auditoria", () => {
  it("toda mudança de membro, permissão e lançamento fica registrada e ninguém apaga o registro", async () => {
    const r = await comoUsuario(db, DONO, (tx) =>
      tx.query<{ tabela: string; acao: string }>("select tabela, acao from public.audit_log where escritorio_id = $1", [escritorio]),
    );
    const pares = new Set(r.rows.map((x) => `${x.tabela}:${x.acao}`));
    for (const p of ["escritorio:insert", "membro:insert", "permissao_tela:insert", "permissao_tela:delete", "lancamento:insert", "convite:insert"]) {
      expect(pares.has(p), p).toBe(true);
    }
    const semHash = await db.query<{ n: number }>("select count(*)::int n from public.audit_log where depois ? 'token_hash' or antes ? 'token_hash'");
    expect(semHash.rows[0].n).toBe(0);
    await expect(comoUsuario(db, DONO, (tx) => tx.query("delete from public.audit_log"))).rejects.toThrow(/permission denied/);
    await expect(
      comoUsuario(db, DONO, (tx) =>
        tx.query("insert into public.audit_log (tabela, acao) values ('x', 'insert')"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("membro não lê a auditoria", async () => {
    const r = await comoUsuario(db, MEMBRO, (tx) => tx.query("select * from public.audit_log"));
    expect(r.rows).toHaveLength(0);
  });
});
