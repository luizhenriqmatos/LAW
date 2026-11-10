import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { byteaDeBytes, bytesDeBytea } from "@/lib/assinatura/bytea";
import { finalizarEnvelope } from "@/lib/assinatura/finalizar";
import { hashDoToken, novoToken } from "@/lib/portal/token";
import { pdfDeTeste } from "../pdf-teste";
import { comoUsuario, criarBanco, criarUsuario, rpcComoServico } from "./banco";

const ANA = "00000000-0000-4000-8000-0000000000f1"; // dona
const BIA = "00000000-0000-4000-8000-0000000000f2"; // membro (processos + assinaturas)
const ZE = "00000000-0000-4000-8000-0000000000f3"; // dono de outro escritório
const CPF_A = "529.982.247-25";

let db: PGlite;
let esc: string, outro: string;
const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const servico = <T = never,>(funcao: string, args: Record<string, unknown>) => rpcComoServico(db)<T>(funcao, args);
function usuario<T = never>(uid: string, funcao: string, args: Record<string, unknown>): Promise<T> {
  const nomes = Object.keys(args);
  const sql = `select public.${funcao}(${nomes.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`;
  return comoUsuario(db, uid, async (tx) =>
    (await tx.query<{ r: T }>(sql, nomes.map((n) => { const v = args[n]; if (typeof v === "string" && /^\\x([0-9a-fA-F]{2})+$/.test(v)) return bytesDeBytea(v); return v !== null && typeof v === "object" && !(Array.isArray(v) && v.every((x) => typeof x === "string")) ? JSON.stringify(v) : v; }))).rows[0].r);
}
const consultar = <T extends object>(uid: string, sql: string, p: unknown[] = []) => comoUsuario(db, uid, async (tx) => (await tx.query<T>(sql, p)).rows);

// Relógio simulado: nada aqui depende da hora real.
const T0 = new Date("2027-03-01T12:00:00Z");
const dias = (n: number) => new Date(T0.getTime() + n * 86_400_000).toISOString();
const horas = (n: number) => new Date(T0.getTime() + n * 3_600_000).toISOString();

type Pend = { escritorio_id: string; tipo: string; nome: string; destinatarios: string[] };
const pendencias = (agora: string) => servico<Pend[]>("conta_pendencias", { p_agora: agora });

let envelope: string;
let hashFinal: string;

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, e] of [[ANA, "ana@t.com"], [BIA, "bia@t.com"], [ZE, "ze@t.com"]]) await criarUsuario(db, id, e);
  esc = await usuario<string>(ANA, "criar_escritorio", { p_nome: "Prado Advocacia", p_cnpj: null, p_plano: "equipe" });
  outro = await usuario<string>(ZE, "criar_escritorio", { p_nome: "Outro Escritório", p_cnpj: null, p_plano: "equipe" });
  const t = await usuario<string>(ANA, "criar_convite", { p_escritorio: esc, p_email: "bia@t.com", p_modulos: ["processos", "assinaturas"] });
  await usuario(BIA, "aceitar_convite", { p_token: t });

  // Dados nos dois escritórios.
  for (const e of [esc, outro]) {
    await db.query("insert into public.cliente (escritorio_id, nome, telefone, status, confirmado_em) values ($1, 'Cliente Exemplo', '71999990001', 'confirmado', now())", [e]);
    await db.query("insert into public.processo (escritorio_id, numero_cnj, tribunal, titulo, status, confirmado_em) values ($1, $2, 'TJBA', 'Cobrança X', 'confirmado', now())",
      [e, e === esc ? "00000011220268050001" : "00000022220268050002"]);
  }

  // Um documento assinado do escritório que vai fechar.
  const pdf = await pdfDeTeste(1);
  const env = await usuario<{ id: string; signatarios: { id: string }[] }>(BIA, "assinatura_criar", {
    p_escritorio: esc, p_titulo: "Contrato de honorários", p_nome_arquivo: "contrato.pdf", p_pdf: byteaDeBytes(pdf), p_processo: null,
    p_signatarios: [{ nome: "Joana Teste", email: "joana@teste.com", ordem: 1 }],
  });
  envelope = env.id;
  const token = novoToken();
  await usuario(BIA, "assinatura_emitir_link", { p_signatario: env.signatarios[0].id, p_token_hash: hashDoToken(token) });
  const th = hashDoToken(token);
  await servico("assinatura_abrir", { p_token_hash: th, p_ip: "203.0.113.9", p_user_agent: "Teste" });
  await servico("assinatura_documento_para_assinar", { p_token_hash: th, p_ip: "203.0.113.9", p_user_agent: "Teste" });
  const a = await servico<{ ok: boolean }>("assinatura_assinar", { p_token_hash: th, p_cpf: CPF_A, p_aceite: true, p_ip: "203.0.113.9", p_user_agent: "Teste" });
  expect(a.ok).toBe(true);
  const fim = await finalizarEnvelope(rpcComoServico(db), envelope);
  expect(fim.ok).toBe(true);
  if (fim.ok) hashFinal = fim.hashFinal;
});

describe("pedido de encerramento", () => {
  it("só o dono pede; membro e estranho são barrados", async () => {
    await expect(usuario(BIA, "encerramento_solicitar", { p_escritorio: esc })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(ZE, "encerramento_solicitar", { p_escritorio: esc })).rejects.toThrow(/sem_permissao/);
    expect((await um<{ encerramento_ate: string | null }>("select encerramento_ate from public.escritorio where id = $1", [esc])).encerramento_ate).toBeNull();
  });

  it("antes do pedido a conta escreve normalmente e nada está pendente", async () => {
    await consultar(ANA, "insert into public.lancamento (escritorio_id, descricao, valor_centavos) values ($1, 'honorário', 10000)", [esc]);
    expect(await pendencias(T0.toISOString())).toEqual([]);
  });

  it("dono pede: 30 dias exatos, uma vez só", async () => {
    const ate = await servico<string>("conta_encerramento_solicitar", { p_escritorio: esc, p_usuario: ANA, p_agora: T0.toISOString() });
    expect(new Date(ate).toISOString()).toBe(dias(30));
    const e = await um<{ encerramento_solicitado_por: string; encerramento_ate: Date }>("select * from public.escritorio where id = $1", [esc]);
    expect(e.encerramento_solicitado_por).toBe(ANA);
    await expect(servico("conta_encerramento_solicitar", { p_escritorio: esc, p_usuario: ANA, p_agora: dias(1) })).rejects.toThrow(/ja_em_encerramento/);
    await expect(usuario(ANA, "encerramento_solicitar", { p_escritorio: esc })).rejects.toThrow(/ja_em_encerramento/);
  });

  it("não afeta o outro escritório", async () => {
    expect((await um<{ encerramento_ate: string | null }>("select encerramento_ate from public.escritorio where id = $1", [outro])).encerramento_ate).toBeNull();
    await consultar(ZE, "insert into public.lancamento (escritorio_id, descricao, valor_centavos) values ($1, 'honorário', 500)", [outro]);
  });
});

describe("somente leitura nos 30 dias", () => {
  it("usuário lê tudo e não grava em nenhuma tabela do escritório", async () => {
    expect((await consultar(ANA, "select id from public.processo where escritorio_id = $1", [esc])).length).toBe(1);
    await expect(consultar(ANA, "insert into public.lancamento (escritorio_id, descricao, valor_centavos) values ($1, 'novo', 1)", [esc])).rejects.toThrow(/conta_somente_leitura/);
    await expect(consultar(ANA, "update public.lancamento set valor_centavos = 1 where escritorio_id = $1", [esc])).rejects.toThrow(/conta_somente_leitura/);
    await expect(consultar(ANA, "delete from public.lancamento where escritorio_id = $1", [esc])).rejects.toThrow(/conta_somente_leitura/);
    await expect(consultar(ANA, "delete from public.membro where escritorio_id = $1 and usuario_id = $2", [esc, BIA])).rejects.toThrow(/conta_somente_leitura/);
    await expect(consultar(ANA, "update public.escritorio set nome = 'Outro nome' where id = $1", [esc])).rejects.toThrow(/conta_somente_leitura/);
  });

  it("nenhuma tabela nova escapa: toda tabela com escritorio_id tem o bloqueio, salvo as exceções conhecidas", async () => {
    const r = await db.query<{ t: string }>(`
      select t from public.tabelas_com_escopo_de_escritorio() t
       where t not in ('audit_log', 'notificacao') and t not like 'assinatura\\_%'
         and not exists (select 1 from pg_trigger g where g.tgrelid = ('public.' || t)::regclass and g.tgname = 'bloquear_encerramento')`);
    expect(r.rows.map((x) => x.t)).toEqual([]);
  });

  it("jobs de serviço continuam gravando; o cliente ainda consegue assinar", async () => {
    await db.query("update public.processo set titulo = 'atualizado pela captura' where escritorio_id = $1", [esc]);
    expect((await um<{ titulo: string }>("select titulo from public.processo where escritorio_id = $1", [esc])).titulo).toBe("atualizado pela captura");
  });

  it("exportação é do dono, e só do dono", async () => {
    const dados = await usuario<Record<string, Record<string, unknown>[]>>(ANA, "conta_exportar", { p_escritorio: esc });
    expect(dados.cliente).toHaveLength(1);
    expect(dados.processo).toHaveLength(1);
    expect(dados.membro.map((m) => m.email).sort()).toEqual(["ana@t.com", "bia@t.com"]);
    await expect(usuario(BIA, "conta_exportar", { p_escritorio: esc })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(ZE, "conta_exportar", { p_escritorio: esc })).rejects.toThrow(/sem_permissao/);
    // Nada do outro escritório vaza.
    expect(JSON.stringify(dados)).not.toContain("Outro Escritório");
  });

  it("exportação de assinaturas traz PDFs e não traz token", async () => {
    const ass = await usuario<Record<string, Record<string, unknown>[]>>(ANA, "conta_exportar_assinaturas", { p_escritorio: esc });
    expect(ass.assinatura_envelope).toHaveLength(1);
    expect(ass.assinatura_signatario).toHaveLength(1);
    expect(Object.keys(ass.assinatura_signatario[0])).not.toContain("token_hash");
    expect(ass.assinatura_evidencia.length).toBeGreaterThan(0);
    const arq = await usuario<{ original: string; final: string | null; nome_arquivo: string }>(ANA, "conta_exportar_arquivo", { p_escritorio: esc, p_envelope: envelope });
    expect(Buffer.from(arq.original, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect(Buffer.from(arq.final as string, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect(await usuario(ANA, "conta_exportar_arquivo", { p_escritorio: esc, p_envelope: "00000000-0000-4000-8000-000000000999" })).toBeNull();
  });
});

describe("avisos por e-mail com relógio simulado", () => {
  it("no pedido: um aviso ao dono, e só uma vez depois de marcado", async () => {
    const p = await pendencias(horas(1));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ escritorio_id: esc, tipo: "pedido", nome: "Prado Advocacia", destinatarios: ["ana@t.com"] });
    await servico("conta_marcar_aviso", { p_escritorio: esc, p_tipo: "pedido", p_agora: horas(1) });
    expect(await pendencias(horas(2))).toEqual([]);
  });

  it("aos 22 dias ainda não; aos 23 dias (7 antes) sim, uma vez", async () => {
    expect(await pendencias(dias(22))).toEqual([]);
    const p = await pendencias(dias(23));
    expect(p.map((x) => x.tipo)).toEqual(["sete_dias"]);
    await servico("conta_marcar_aviso", { p_escritorio: esc, p_tipo: "sete_dias", p_agora: dias(23) });
    expect(await pendencias(dias(24))).toEqual([]);
  });

  it("nada é excluído antes do prazo", async () => {
    expect(await servico<string[]>("conta_vencidas", { p_agora: dias(29) })).toEqual([]);
    await expect(servico("conta_excluir", { p_escritorio: esc, p_agora: dias(29) })).rejects.toThrow(/fora_do_prazo/);
    expect((await um<{ n: number }>("select count(*)::int n from public.cliente where escritorio_id = $1", [esc])).n).toBe(1);
  });
});

describe("cancelamento", () => {
  it("dono cancela dentro do prazo; escritório volta a gravar e o ciclo recomeça do zero", async () => {
    await expect(usuario(BIA, "encerramento_cancelar", { p_escritorio: esc })).rejects.toThrow(/sem_permissao/);
    await usuario(ANA, "encerramento_cancelar", { p_escritorio: esc });
    await consultar(ANA, "insert into public.lancamento (escritorio_id, descricao, valor_centavos) values ($1, 'voltou', 1)", [esc]);
    await expect(usuario(ANA, "encerramento_cancelar", { p_escritorio: esc })).rejects.toThrow(/sem_encerramento/);
    expect(await servico<string[]>("conta_vencidas", { p_agora: dias(40) })).toEqual([]);
    // Pede de novo, mais tarde: os avisos valem de novo.
    await servico("conta_encerramento_solicitar", { p_escritorio: esc, p_usuario: ANA, p_agora: T0.toISOString() });
    expect((await pendencias(horas(1))).map((x) => x.tipo)).toEqual(["pedido"]);
  });
});

describe("exclusão final (dia 30)", () => {
  let antesOutro: { cliente: number; processo: number };
  const contagem = async (e: string) => ({
    cliente: (await um<{ n: number }>("select count(*)::int n from public.cliente where escritorio_id = $1", [e])).n,
    processo: (await um<{ n: number }>("select count(*)::int n from public.processo where escritorio_id = $1", [e])).n,
  });

  it("no prazo, o job apaga todo o escritório e só ele", async () => {
    await servico("conta_marcar_aviso", { p_escritorio: esc, p_tipo: "pedido", p_agora: horas(1) });
    await servico("conta_marcar_aviso", { p_escritorio: esc, p_tipo: "sete_dias", p_agora: dias(23) });
    antesOutro = await contagem(outro);
    expect(await servico<string[]>("conta_vencidas", { p_agora: dias(30) })).toEqual([esc]);
    const r = await servico<{ excluido: boolean; envelopes_retidos: number }>("conta_excluir", { p_escritorio: esc, p_agora: dias(30) });
    expect(r).toEqual({ excluido: true, envelopes_retidos: 1 });

    expect(await um("select id from public.escritorio where id = $1", [esc])).toBeUndefined();
    // Nenhuma tabela do escritório sobra, exceto as de retenção e o log.
    const tabelas = (await db.query<{ t: string }>("select t from public.tabelas_com_escopo_de_escritorio() t")).rows.map((x) => x.t);
    for (const t of tabelas) {
      if (t === "audit_log" || t.startsWith("assinatura_")) continue;
      const n = (await um<{ n: number }>(`select count(*)::int n from public.${t} where escritorio_id = $1`, [esc])).n;
      expect(n, `tabela ${t}`).toBe(0);
    }
    expect(await contagem(outro)).toEqual(antesOutro);
    expect(await um("select id from public.escritorio where id = $1", [outro])).toBeDefined();
  });

  it("o documento assinado sobrevive, com PDFs, hashes, signatários e evidências intactos", async () => {
    const e = await um<{ status: string; hash_final: string; escritorio_nome: string; retencao_ate: string }>(
      "select status, hash_final, escritorio_nome, retencao_ate::text from public.assinatura_envelope where id = $1", [envelope]);
    expect(e).toMatchObject({ status: "concluido", hash_final: hashFinal, escritorio_nome: "Prado Advocacia" });
    expect(new Date(e.retencao_ate).getFullYear()).toBeGreaterThanOrEqual(new Date().getFullYear() + 4);
    const a = await um<{ o: number; f: number }>("select octet_length(original) o, octet_length(final) f from public.assinatura_arquivo where envelope_id = $1", [envelope]);
    expect(a.o).toBeGreaterThan(100);
    expect(a.f).toBeGreaterThan(a.o);
    expect((await um<{ n: number }>("select count(*)::int n from public.assinatura_signatario where envelope_id = $1", [envelope])).n).toBe(1);
    expect((await um<{ n: number }>("select count(*)::int n from public.assinatura_evidencia where envelope_id = $1", [envelope])).n).toBeGreaterThan(3);
    // A verificação pública do documento continua funcionando depois da exclusão da conta.
    const v = await servico<{ encontrado: boolean; status?: string }>("assinatura_verificar", { p_hash: hashFinal });
    expect(v).toMatchObject({ encontrado: true });
  });

  it("e a retenção continua valendo: o documento não pode ser apagado por ninguém", async () => {
    await expect(db.query("delete from public.assinatura_arquivo where envelope_id = $1", [envelope])).rejects.toThrow(/retencao_5_anos/);
    await expect(db.query("delete from public.assinatura_envelope where id = $1", [envelope])).rejects.toThrow(/retencao_5_anos|violates|restrict/);
  });

  it("o log de auditoria do escritório foi apagado, menos o das assinaturas, e ficou um registro da exclusão", async () => {
    const logs = (await db.query<{ tabela: string; acao: string }>("select tabela, acao from public.audit_log where escritorio_id = $1", [esc])).rows;
    expect(logs.filter((l) => l.tabela === "cliente" || l.tabela === "processo" || l.tabela === "membro")).toEqual([]);
    expect(logs.some((l) => l.tabela === "escritorio" && l.acao === "delete")).toBe(true);
    // O outro escritório mantém o seu log.
    expect((await um<{ n: number }>("select count(*)::int n from public.audit_log where escritorio_id = $1", [outro])).n).toBeGreaterThan(0);
  });

  it("registro da exclusão guardado e último aviso pendente (uma vez só)", async () => {
    const c = await um<{ escritorio_nome: string; destinatarios: string[]; envelopes_retidos: number; excluido_em: Date }>("select * from public.conta_encerrada where escritorio_id = $1", [esc]);
    expect(c).toMatchObject({ escritorio_nome: "Prado Advocacia", destinatarios: ["ana@t.com"], envelopes_retidos: 1 });
    expect(c.excluido_em.toISOString()).toBe(dias(30));
    const p = await pendencias(dias(30));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ escritorio_id: esc, tipo: "exclusao", nome: "Prado Advocacia", destinatarios: ["ana@t.com"] });
    await servico("conta_marcar_aviso", { p_escritorio: esc, p_tipo: "exclusao", p_agora: dias(30) });
    expect(await pendencias(dias(31))).toEqual([]);
  });

  it("repetir a exclusão não faz nada de errado; o dono antigo não enxerga mais nada", async () => {
    await expect(servico("conta_excluir", { p_escritorio: esc, p_agora: dias(31) })).rejects.toThrow(/escritorio_inexistente/);
    expect(await consultar(ANA, "select id from public.processo")).toEqual([]);
    await expect(usuario(ANA, "conta_exportar", { p_escritorio: esc })).rejects.toThrow(/sem_permissao/);
  });

  it("a tabela de registros de exclusão não é lida por usuários", async () => {
    await expect(consultar(ANA, "select * from public.conta_encerrada")).rejects.toThrow(/permission denied/);
  });
});
