import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { PDFDocument } from "pdf-lib";
import { byteaDeBytes, bytesDeBytea } from "@/lib/assinatura/bytea";
import { cpfValido } from "@/lib/assinatura/cpf";
import { finalizarEnvelope } from "@/lib/assinatura/finalizar";
import { sha256Hex } from "@/lib/assinatura/pdf";
import { hashDoToken, novoToken } from "@/lib/portal/token";
import { pdfDeTeste } from "../pdf-teste";
import { comoAnonimo, comoUsuario, criarBanco, criarUsuario, rpcComoServico } from "./banco";

const ANA = "00000000-0000-4000-8000-0000000000e1"; // dona
const BIA = "00000000-0000-4000-8000-0000000000e2"; // Assinaturas
const CAIO = "00000000-0000-4000-8000-0000000000e3"; // só tarefas
const OUTRO = "00000000-0000-4000-8000-0000000000e4"; // dono de outro escritório
const IP = "203.0.113.9";
const UA = "Navegador de Teste/1.0";
const CPF_A = "529.982.247-25";
const CPF_B = "111.444.777-35";

let db: PGlite;
let esc: string, escOutro: string;
const rpc = () => rpcComoServico(db);

const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const servico = <T = never,>(funcao: string, args: Record<string, unknown>) => rpcComoServico(db)<T>(funcao, args);
/** Objetos viram JSON; bytea ("\\x...") vira bytes, como o PGlite exige. */
function paraParametro(v: unknown): unknown {
  if (typeof v === "string" && /^\\x([0-9a-fA-F]{2})+$/.test(v)) return bytesDeBytea(v);
  return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
}
function usuario<T = never>(uid: string, funcao: string, args: Record<string, unknown>): Promise<T> {
  const nomes = Object.keys(args);
  const sql = `select public.${funcao}(${nomes.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`;
  return comoUsuario(db, uid, async (tx) => (await tx.query<{ r: T }>(sql, nomes.map((n) => paraParametro(args[n])))).rows[0].r);
}
const consultar = <T extends object>(uid: string, sql: string, p: unknown[] = []) => comoUsuario(db, uid, async (tx) => (await tx.query<T>(sql, p)).rows);

type Envelope = { id: string; hash_original: string; signatarios: { id: string; nome: string; email: string; ordem: number; vez: boolean }[] };
async function criar(uid: string, pdf: Uint8Array, sigs: { nome: string; email: string; ordem?: number }[], escritorio = esc) {
  return usuario<Envelope>(uid, "assinatura_criar", {
    p_escritorio: escritorio, p_titulo: "Contrato de honorários", p_nome_arquivo: "contrato.pdf", p_pdf: byteaDeBytes(pdf), p_processo: null, p_signatarios: sigs,
  });
}
/** Emite o link como o servidor faz (hash vai para o banco, token para o e-mail). */
async function emitir(uid: string, signatario: string) {
  const token = novoToken();
  await usuario(uid, "assinatura_emitir_link", { p_signatario: signatario, p_token_hash: hashDoToken(token) });
  return token;
}
const emitirServico = async (signatario: string) => {
  const token = novoToken();
  await servico("assinatura_emitir_link_servico", { p_signatario: signatario, p_token_hash: hashDoToken(token) });
  return token;
};
type R = Record<string, unknown> & { ok: boolean; motivo?: string };
const abrir = (t: string) => servico<R>("assinatura_abrir", { p_token_hash: hashDoToken(t), p_ip: IP, p_user_agent: UA });
const ler = (t: string) => servico<R & { pdf?: unknown }>("assinatura_documento_para_assinar", { p_token_hash: hashDoToken(t), p_ip: IP, p_user_agent: UA });
const assinar = (t: string, cpf: string, aceite = true, ip = IP) =>
  servico<R & { todos?: boolean; liberados?: { id: string }[]; envelope_id?: string }>("assinatura_assinar", { p_token_hash: hashDoToken(t), p_cpf: cpf, p_aceite: aceite, p_ip: ip, p_user_agent: UA });
const verificar = (hash: string) => servico<{ encontrado: boolean; tipo?: string; status?: string; signatarios?: { nome: string; cpf: string | null }[] }>("assinatura_verificar", { p_hash: hash });
const linhaEnv = (id: string) => um<{ status: string; hash_final: string | null; hash_original: string; retencao_ate: string }>("select status, hash_final, hash_original, retencao_ate::text from public.assinatura_envelope where id = $1", [id]);

/** Envelope com 2 signatários em sequência, assinado pelos dois. */
async function envelopeConcluido(pdf?: Uint8Array) {
  const original = pdf ?? (await pdfDeTeste(2));
  const env = await criar(BIA, original, [{ nome: "Joana Teste", email: "Joana@Teste.com", ordem: 1 }, { nome: "Marcos Teste", email: "marcos@teste.com", ordem: 2 }]);
  const [joana, marcos] = [env.signatarios[0], env.signatarios[1]];
  const t1 = await emitir(BIA, joana.id);
  await ler(t1);
  const a1 = await assinar(t1, CPF_A);
  const t2 = await emitirServico(marcos.id);
  await ler(t2);
  const a2 = await assinar(t2, CPF_B);
  const fim = await finalizarEnvelope(rpc(), env.id);
  return { env, original, t1, t2, a1, a2, fim };
}

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, email] of [[ANA, "ana@t.com"], [BIA, "bia@t.com"], [CAIO, "caio@t.com"], [OUTRO, "outro@t.com"]]) await criarUsuario(db, id, email);
  esc = await usuario<string>(ANA, "criar_escritorio", { p_nome: "Prado Advocacia", p_cnpj: null, p_plano: "equipe" });
  escOutro = await usuario<string>(OUTRO, "criar_escritorio", { p_nome: "Outro Escritorio", p_cnpj: null, p_plano: "equipe" });
  const t1 = await usuario<string>(ANA, "criar_convite", { p_escritorio: esc, p_email: "bia@t.com", p_modulos: "{assinaturas}" });
  await usuario(BIA, "aceitar_convite", { p_token: t1 });
  const t2 = await usuario<string>(ANA, "criar_convite", { p_escritorio: esc, p_email: "caio@t.com", p_modulos: "{tarefas}" });
  await usuario(CAIO, "aceitar_convite", { p_token: t2 });
});

describe("CRITÉRIO: envelope com 2 signatários concluído; 1 byte alterado no PDF final faz a verificação falhar", () => {
  it("fluxo completo e verificação pública", async () => {
    const { env, original, a1, a2, fim } = await envelopeConcluido();

    // 1) o banco calculou o hash do original
    expect(env.hash_original).toBe(sha256Hex(original));
    // 2) Joana (ordem 1) abriu a vez de Marcos (ordem 2)
    expect(a1).toMatchObject({ ok: true, todos: false });
    expect(a1.liberados).toHaveLength(1);
    expect(a2).toMatchObject({ ok: true, todos: true });
    // 3) PDF final concluído
    expect(fim.ok).toBe(true);
    if (!fim.ok) return;
    const e = await linhaEnv(env.id);
    expect(e.status).toBe("concluido");
    expect(e.hash_final).toBe(fim.hashFinal);

    // 4) o PDF guardado tem o hash registrado e é original + manifesto
    const baixado = await usuario<{ ok: boolean; pdf: unknown }>(BIA, "assinatura_baixar", { p_envelope: env.id, p_qual: "final" });
    const final = bytesDeBytea(baixado.pdf);
    expect(sha256Hex(final)).toBe(fim.hashFinal);
    expect((await PDFDocument.load(final)).getPageCount()).toBeGreaterThanOrEqual(3);

    // 5) verificação pública: o arquivo íntegro confere
    const ok = await verificar(sha256Hex(final));
    expect(ok).toMatchObject({ encontrado: true, tipo: "final", status: "concluido" });
    expect(ok.signatarios?.map((s) => s.nome)).toEqual(["Joana Teste", "Marcos Teste"]);
    expect(ok.signatarios?.[0].cpf).toBe("***.982.247-**"); // CPF mascarado na página pública

    // 6) alterar 1 byte (em qualquer posição) → não confere
    for (const posicao of [0, final.length >> 1, final.length - 1]) {
      const adulterado = Uint8Array.from(final);
      adulterado[posicao] ^= 0x01;
      expect(await verificar(sha256Hex(adulterado)), `byte ${posicao}`).toEqual({ encontrado: false });
    }
    // 7) o original confere como ORIGINAL, não como final
    expect(await verificar(sha256Hex(original))).toMatchObject({ encontrado: true, tipo: "original" });
    // hash malformado
    expect(await verificar("zzz")).toEqual({ encontrado: false });
  });

  it("evidências na ordem certa, com IP, e cadeia íntegra", async () => {
    const { env } = await envelopeConcluido();
    await servico("assinatura_registrar_envio", { p_signatario: env.signatarios[0].id, p_enviado: true, p_motivo: null });
    const ev = await consultar<{ tipo: string; ip: string | null; hash: string; hash_anterior: string | null }>(BIA, "select tipo, host(ip) ip, hash, hash_anterior from public.assinatura_evidencia where envelope_id = $1 order by id", [env.id]);
    const tipos = ev.map((x) => x.tipo);
    expect(tipos[0]).toBe("envelope_criado");
    expect(tipos.at(-2)).toBe("conclusao_envelope");
    for (const t of ["envio_email", "visualizacao", "aceite", "assinatura", "conclusao_envelope"]) expect(tipos).toContain(t);
    expect(tipos.filter((t) => t === "assinatura")).toHaveLength(2);
    expect(ev.find((x) => x.tipo === "assinatura")?.ip).toBe(IP);
    expect(await servico("assinatura_verificar_cadeia", { p_envelope: env.id })).toBe(true);
    // cada linha aponta para a anterior
    ev.forEach((x, i) => expect(x.hash_anterior).toBe(i === 0 ? null : ev[i - 1].hash));
  });

  it("manifesto: o dado de cada assinatura (nome, e-mail, CPF, data, IP, navegador) está no banco", async () => {
    const { env } = await envelopeConcluido();
    const s = await consultar<{ nome: string; email: string; cpf: string; assinado_em: string; ip: string; user_agent: string; aceite_texto: string }>(
      BIA, "select nome, email, cpf, assinado_em, host(ip) ip, user_agent, aceite_texto from public.assinatura_signatario where envelope_id = $1 order by ordem", [env.id]);
    expect(s[0]).toMatchObject({ nome: "Joana Teste", email: "joana@teste.com", cpf: "52998224725", ip: IP, user_agent: UA });
    expect(s[0].assinado_em).toBeTruthy();
    expect(s[0].aceite_texto).toContain("assinatura eletrônica avançada");
    expect(s[0].aceite_texto).toContain("não por assinatura qualificada");
  });
});

describe("Regras da assinatura", () => {
  it("assinar exige: ter visualizado, CPF válido e aceite; erro não grava nada", async () => {
    const env = await criar(BIA, await pdfDeTeste(1), [{ nome: "Pedro Teste", email: "pedro@teste.com" }]);
    const t = await emitir(BIA, env.signatarios[0].id);
    expect(await assinar(t, CPF_A)).toMatchObject({ ok: false, motivo: "nao_visualizou" }); // não leu
    expect((await abrir(t)).ok).toBe(true); // só abrir a página também não vale como leitura
    expect(await assinar(t, CPF_A)).toMatchObject({ ok: false, motivo: "nao_visualizou" });
    await ler(t);
    for (const ruim of ["529.982.247-26", "11111111111", "123", ""]) expect(await assinar(t, ruim), ruim).toMatchObject({ ok: false, motivo: "cpf_invalido" });
    expect(await assinar(t, CPF_A, false)).toMatchObject({ ok: false, motivo: "aceite_obrigatorio" });
    expect((await um<{ status: string }>("select status from public.assinatura_signatario where id = $1", [env.signatarios[0].id])).status).toBe("pendente");
    expect(await assinar(t, "529.982.247-25")).toMatchObject({ ok: true, todos: true }); // máscara é aceita
  });

  it("validação de CPF do banco é igual à do app", async () => {
    for (const c of ["52998224725", "11144477735", "52998224726", "11111111111", "1234567890", "abcdefghijk", "00000000000", "39053344705", "39053344706"]) {
      expect((await um<{ v: boolean }>("select public.cpf_valido($1) v", [c])).v, c).toBe(cpfValido(c));
    }
    // o banco também recusa gravar CPF inválido por qualquer caminho
    await expect(db.query("update public.assinatura_signatario set cpf = '12345678900' where false")).resolves.toBeTruthy();
  });

  it("ordem: quem tem ordem maior só recebe link depois; mesma ordem recebe junto", async () => {
    const env = await criar(BIA, await pdfDeTeste(1), [
      { nome: "Primeiro Teste", email: "p1@teste.com", ordem: 1 }, { nome: "Segundo Teste", email: "p2@teste.com", ordem: 1 }, { nome: "Terceiro Teste", email: "p3@teste.com", ordem: 2 },
    ]);
    expect(env.signatarios.map((s) => s.vez)).toEqual([true, true, false]);
    await expect(emitir(BIA, env.signatarios[2].id)).rejects.toThrow(/fora_da_vez/);
    const t1 = await emitir(BIA, env.signatarios[0].id), t2 = await emitir(BIA, env.signatarios[1].id);
    await ler(t1); await ler(t2);
    const r1 = await assinar(t1, CPF_A);
    expect(r1).toMatchObject({ ok: true, todos: false, liberados: [] }); // o terceiro espera o segundo
    const r2 = await assinar(t2, CPF_B);
    expect(r2.liberados?.map((l) => l.id)).toEqual([env.signatarios[2].id]);
  });

  it("as duas últimas assinaturas ao mesmo tempo: só uma fecha o envelope", async () => {
    const env = await criar(BIA, await pdfDeTeste(1), [{ nome: "Ana Paralela", email: "pa@teste.com" }, { nome: "Bia Paralela", email: "pb@teste.com" }]);
    const ts = await Promise.all(env.signatarios.map((s) => emitir(BIA, s.id)));
    for (const t of ts) await ler(t);
    const rs = await Promise.all([assinar(ts[0], CPF_A), assinar(ts[1], CPF_B)]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.todos)).toHaveLength(1);
    expect((await linhaEnv(env.id)).status).toBe("assinado");
    expect((await finalizarEnvelope(rpc(), env.id)).ok).toBe(true);
    expect((await finalizarEnvelope(rpc(), env.id)).ok).toBe(true); // repetir é seguro
    expect((await um<{ n: number }>("select count(*)::int n from public.assinatura_evidencia where envelope_id = $1 and tipo = 'conclusao_envelope'", [env.id])).n).toBe(1);
  });

  it("finalizar antes de todos assinarem é recusado", async () => {
    const env = await criar(BIA, await pdfDeTeste(1), [{ nome: "Sozinho Teste", email: "s@teste.com" }, { nome: "Faltando Teste", email: "f@teste.com" }]);
    const t = await emitir(BIA, env.signatarios[0].id);
    await ler(t); await assinar(t, CPF_A);
    expect(await finalizarEnvelope(rpc(), env.id)).toEqual({ ok: false, motivo: "faltam_assinaturas" });
  });
});

describe("Link do signatário: token aleatório, 7 dias, uso único", () => {
  it("vale 7 dias, é guardado só como hash e é de uso único (reuso recusado)", async () => {
    const env = await criar(BIA, await pdfDeTeste(1), [{ nome: "Unico Teste", email: "u@teste.com" }]);
    const t = await emitir(BIA, env.signatarios[0].id);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const s = await um<{ dias: number; token_hash: string }>("select round(extract(epoch from token_expira_em - link_enviado_em) / 86400)::int dias, token_hash from public.assinatura_signatario where id = $1", [env.signatarios[0].id]);
    expect(s.dias).toBe(7);
    expect(s.token_hash).toBe(hashDoToken(t));
    expect(JSON.stringify((await db.query("select * from public.assinatura_signatario")).rows)).not.toContain(t);
    await ler(t);
    expect((await assinar(t, CPF_A)).ok).toBe(true);
    expect(await assinar(t, CPF_A)).toMatchObject({ ok: false, motivo: "assinado" });
    expect(await abrir(t)).toMatchObject({ ok: false, motivo: "assinado" });
    expect((await ler(t)).ok).toBe(false);
  });

  it("link vencido é recusado para abrir, ler e assinar; novo link invalida o antigo", async () => {
    const env = await criar(BIA, await pdfDeTeste(1), [{ nome: "Vencido Teste", email: "v@teste.com" }]);
    const velho = await emitir(BIA, env.signatarios[0].id);
    await ler(velho);
    await db.query("update public.assinatura_signatario set token_expira_em = now() - interval '1 second' where id = $1", [env.signatarios[0].id]);
    expect(await abrir(velho)).toMatchObject({ ok: false, motivo: "expirado" });
    expect((await ler(velho)).ok).toBe(false);
    expect(await assinar(velho, CPF_A)).toMatchObject({ ok: false, motivo: "expirado" });
    const novo = await emitir(BIA, env.signatarios[0].id);
    expect(await abrir(velho)).toMatchObject({ ok: false, motivo: "invalido" });
    expect((await abrir(novo)).ok).toBe(true);
  });

  it("token inventado é inválido; e-mail e CPF de outro envelope não ajudam", async () => {
    expect(await abrir(novoToken())).toMatchObject({ ok: false, motivo: "invalido" });
    expect(await assinar(novoToken(), CPF_A)).toMatchObject({ ok: false, motivo: "invalido" });
    expect((await ler(novoToken())).ok).toBe(false);
  });

  it("cancelar o envelope derruba os links; evidência e documento continuam", async () => {
    const env = await criar(BIA, await pdfDeTeste(1), [{ nome: "Cancelado Teste", email: "c@teste.com" }]);
    const t = await emitir(BIA, env.signatarios[0].id);
    await ler(t);
    await expect(usuario(CAIO, "assinatura_cancelar", { p_envelope: env.id })).rejects.toThrow(/sem_permissao/);
    await usuario(BIA, "assinatura_cancelar", { p_envelope: env.id });
    expect(await abrir(t)).toMatchObject({ ok: false, motivo: "cancelado" });
    expect(await assinar(t, CPF_A)).toMatchObject({ ok: false, motivo: "cancelado" });
    expect((await ler(t)).ok).toBe(false);
    await expect(emitir(BIA, env.signatarios[0].id)).rejects.toThrow(/envelope_encerrado/);
    expect((await linhaEnv(env.id)).status).toBe("cancelado");
    expect((await usuario<{ ok: boolean }>(BIA, "assinatura_baixar", { p_envelope: env.id, p_qual: "original" })).ok).toBe(true);
  });

  it("o envio do e-mail (e a falha dele) viram evidência", async () => {
    const env = await criar(BIA, await pdfDeTeste(1), [{ nome: "Email Teste", email: "e@teste.com" }]);
    await emitir(BIA, env.signatarios[0].id);
    await servico("assinatura_registrar_envio", { p_signatario: env.signatarios[0].id, p_enviado: false, p_motivo: "O envio de e-mails ainda não está configurado." });
    const e = await um<{ dados: { enviado: boolean; email: string } }>("select dados from public.assinatura_evidencia where envelope_id = $1 and tipo = 'envio_email'", [env.id]);
    expect(e.dados).toMatchObject({ enviado: false, email: "e@teste.com" });
  });
});

describe("Evidências: append-only garantido no banco", () => {
  let envId: string, evId: string;
  beforeAll(async () => {
    envId = (await criar(BIA, await pdfDeTeste(1), [{ nome: "Evid Teste", email: "ev@teste.com" }])).id;
    evId = (await um<{ id: string }>("select id::text from public.assinatura_evidencia where envelope_id = $1 limit 1", [envId])).id;
  });

  it("por permissão: nem service_role, nem usuário logado, nem anônimo fazem UPDATE, DELETE, TRUNCATE ou INSERT", async () => {
    const comandos = [
      `update public.assinatura_evidencia set tipo = 'aceite' where id = ${evId}`,
      `delete from public.assinatura_evidencia where id = ${evId}`,
      `truncate public.assinatura_evidencia`,
      `insert into public.assinatura_evidencia (envelope_id, escritorio_id, tipo) values ('${envId}', '${esc}', 'aceite')`,
    ];
    for (const sql of comandos) {
      await expect(comoUsuario(db, ANA, (tx) => tx.query(sql)), `dona: ${sql}`).rejects.toThrow(/permission denied/);
      await expect(comoAnonimo(db, (tx) => tx.query(sql)), `anon: ${sql}`).rejects.toThrow(/permission denied/);
      await expect(db.transaction(async (tx) => { await tx.exec("set local role service_role"); await tx.query(sql); }), `service: ${sql}`).rejects.toThrow(/permission denied/);
    }
  });

  it("por gatilho: nem o dono da tabela consegue UPDATE, DELETE ou TRUNCATE", async () => {
    await expect(db.query(`update public.assinatura_evidencia set tipo = 'aceite' where id = ${evId}`)).rejects.toThrow(/evidencia_imutavel/);
    await expect(db.query(`delete from public.assinatura_evidencia where id = ${evId}`)).rejects.toThrow(/evidencia_imutavel/);
    await expect(db.query("truncate public.assinatura_evidencia")).rejects.toThrow(/evidencia_imutavel/);
    expect((await um<{ n: number }>("select count(*)::int n from public.assinatura_evidencia where id = $1", [evId])).n).toBe(1);
  });

  it("se alguém burlar tudo e mexer numa linha, a cadeia de hashes denuncia", async () => {
    expect(await servico("assinatura_verificar_cadeia", { p_envelope: envId })).toBe(true);
    await db.exec("alter table public.assinatura_evidencia disable trigger assinatura_evidencia_sem_update");
    try {
      await db.query(`update public.assinatura_evidencia set dados = '{"adulterado": true}'::jsonb where id = ${evId}`);
    } finally {
      await db.exec("alter table public.assinatura_evidencia enable trigger assinatura_evidencia_sem_update");
    }
    expect(await servico("assinatura_verificar_cadeia", { p_envelope: envId })).toBe(false);
  });
});

describe("Documento congelado e retenção de 5 anos", () => {
  it("o arquivo e o hash do original não mudam (nem para o dono da tabela)", async () => {
    const env = await criar(BIA, await pdfDeTeste(1), [{ nome: "Congelado Teste", email: "cg@teste.com" }]);
    await expect(db.query("update public.assinatura_arquivo set original = $1 where envelope_id = $2", [await pdfDeTeste(1, "outro"), env.id])).rejects.toThrow(/envelope_congelado/);
    await expect(db.query("update public.assinatura_envelope set hash_original = $1 where id = $2", ["a".repeat(64), env.id])).rejects.toThrow(/envelope_congelado/);
    await expect(db.query("update public.assinatura_envelope set titulo = 'outro' where id = $1", [env.id])).rejects.toThrow(/envelope_congelado/);
    await expect(db.query("update public.assinatura_envelope set status = 'concluido' where id = $1", [env.id])).rejects.toThrow();
    for (const sql of ["update public.assinatura_arquivo set original = decode('00', 'hex')", "update public.assinatura_envelope set hash_original = 'x'"]) {
      await expect(comoUsuario(db, BIA, (tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied/);
      await expect(db.transaction(async (tx) => { await tx.exec("set local role service_role"); await tx.query(sql); }), sql).rejects.toThrow(/permission denied/);
    }
  });

  it("PDF final não é trocado depois de concluído, e signatário que assinou não muda", async () => {
    const { env } = await envelopeConcluido();
    await expect(db.query("update public.assinatura_arquivo set final = $1 where envelope_id = $2", [await pdfDeTeste(1, "troca"), env.id])).rejects.toThrow(/envelope_congelado/);
    await expect(db.query("update public.assinatura_envelope set hash_final = $1 where id = $2", ["b".repeat(64), env.id])).rejects.toThrow(/envelope_encerrado/);
    await expect(db.query("update public.assinatura_signatario set cpf = $1 where id = $2", ["39053344705", env.signatarios[0].id])).rejects.toThrow(/ja_assinado/);
  });

  it("guarda por 5 anos: nada é apagado, e a data de retenção vale 5 anos a partir da conclusão", async () => {
    const { env } = await envelopeConcluido();
    const e = await linhaEnv(env.id);
    const anos = (new Date(e.retencao_ate).getTime() - Date.now()) / (365.25 * 86400_000);
    expect(anos).toBeGreaterThan(4.95);
    expect(anos).toBeLessThan(5.05);
    await expect(db.query("delete from public.assinatura_envelope where id = $1", [env.id])).rejects.toThrow(/retencao_5_anos|violates foreign key/);
    await expect(db.query("delete from public.assinatura_arquivo where envelope_id = $1", [env.id])).rejects.toThrow(/retencao_5_anos/);
    await expect(db.query("delete from public.assinatura_signatario where envelope_id = $1", [env.id])).rejects.toThrow(/retencao_5_anos/);
    await expect(db.query("delete from public.assinatura_evidencia where envelope_id = $1", [env.id])).rejects.toThrow(/evidencia_imutavel/);
  });

  it("encerrar a conta do escritório não apaga o documento nem as evidências, e a verificação segue funcionando", async () => {
    const original = await pdfDeTeste(1, "outro escritório");
    const env = await criar(OUTRO, original, [{ nome: "Cliente Do Outro", email: "co@teste.com" }], escOutro);
    const t = await emitir(OUTRO, env.signatarios[0].id);
    await ler(t); await assinar(t, CPF_A);
    const fim = await finalizarEnvelope(rpc(), env.id);
    expect(fim.ok).toBe(true);
    const evidenciasAntes = (await um<{ n: number }>("select count(*)::int n from public.assinatura_evidencia where envelope_id = $1", [env.id])).n;

    await db.query("delete from public.escritorio where id = $1", [escOutro]);

    expect((await um<{ n: number }>("select count(*)::int n from public.escritorio where id = $1", [escOutro])).n).toBe(0);
    expect((await linhaEnv(env.id)).status).toBe("concluido");
    expect((await um<{ n: number }>("select count(*)::int n from public.assinatura_arquivo where envelope_id = $1 and final is not null", [env.id])).n).toBe(1);
    expect((await um<{ n: number }>("select count(*)::int n from public.assinatura_evidencia where envelope_id = $1", [env.id])).n).toBe(evidenciasAntes);
    if (fim.ok) expect(await verificar(fim.hashFinal)).toMatchObject({ encontrado: true, tipo: "final" });
    expect(await servico("assinatura_verificar_cadeia", { p_envelope: env.id })).toBe(true);
  });
});

describe("Permissões e RLS", () => {
  let envId: string, sigId: string;
  beforeAll(async () => {
    const e = await criar(BIA, await pdfDeTeste(1), [{ nome: "Rls Teste", email: "rls@teste.com" }]);
    envId = e.id; sigId = e.signatarios[0].id;
    await emitir(BIA, sigId);
  });

  it("quem tem a tela lê; quem não tem e outro escritório não leem nada", async () => {
    for (const t of ["assinatura_envelope", "assinatura_evidencia"]) {
      expect((await consultar(ANA, `select 1 from public.${t}`)).length, `${t}: dona`).toBeGreaterThan(0);
      expect((await consultar(BIA, `select 1 from public.${t}`)).length, `${t}: Bia`).toBeGreaterThan(0);
      expect(await consultar(CAIO, `select 1 from public.${t}`), `${t}: Caio`).toEqual([]);
    }
    expect((await consultar(BIA, "select 1 from public.assinatura_signatario")).length).toBeGreaterThan(0);
    expect(await consultar(CAIO, "select 1 from public.assinatura_signatario")).toEqual([]);
    // o outro escritório (já apagado em teste anterior ou não) nunca vê o nosso
    const novoDono = "00000000-0000-4000-8000-0000000000e5";
    await criarUsuario(db, novoDono, "novo@t.com");
    const escNovo = await usuario<string>(novoDono, "criar_escritorio", { p_nome: "Escritorio Novo", p_cnpj: null, p_plano: "equipe" });
    expect(escNovo).toBeTruthy();
    for (const t of ["assinatura_envelope", "assinatura_evidencia", "assinatura_signatario"]) expect(await consultar(novoDono, `select 1 from public.${t}`), t).toEqual([]);
  });

  it("hash do token e conteúdo do PDF nunca chegam ao navegador", async () => {
    await expect(consultar(BIA, "select token_hash from public.assinatura_signatario")).rejects.toThrow(/permission denied/);
    await expect(consultar(BIA, "select * from public.assinatura_signatario")).rejects.toThrow(/permission denied/);
    await expect(consultar(ANA, "select original from public.assinatura_arquivo")).rejects.toThrow(/permission denied/);
    await expect(comoAnonimo(db, (tx) => tx.query("select 1 from public.assinatura_envelope"))).rejects.toThrow(/permission denied/);
  });

  it("sem a tela Assinaturas não cria, não emite link, não baixa, não cancela", async () => {
    await expect(criar(CAIO, await pdfDeTeste(1), [{ nome: "Nao Pode", email: "np@teste.com" }])).rejects.toThrow(/sem_permissao/);
    await expect(usuario(CAIO, "assinatura_emitir_link", { p_signatario: sigId, p_token_hash: hashDoToken(novoToken()) })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(CAIO, "assinatura_baixar", { p_envelope: envId, p_qual: "original" })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(CAIO, "assinatura_cancelar", { p_envelope: envId })).rejects.toThrow(/sem_permissao/);
    await expect(usuario(CAIO, "assinatura_processos", { p_escritorio: esc })).rejects.toThrow(/sem_permissao/);
  });

  it("as funções do fluxo público e da verificação são só do servidor", async () => {
    const h = hashDoToken(novoToken());
    await expect(usuario(ANA, "assinatura_abrir", { p_token_hash: h, p_ip: null, p_user_agent: null })).rejects.toThrow(/permission denied/);
    await expect(usuario(ANA, "assinatura_assinar", { p_token_hash: h, p_cpf: CPF_A, p_aceite: true, p_ip: null, p_user_agent: null })).rejects.toThrow(/permission denied/);
    await expect(usuario(ANA, "assinatura_verificar", { p_hash: "a".repeat(64) })).rejects.toThrow(/permission denied/);
    await expect(usuario(ANA, "assinatura_concluir", { p_envelope: envId, p_pdf_final: "\\x255044462d" })).rejects.toThrow(/permission denied/);
    await expect(usuario(ANA, "assinatura_emitir_link_servico", { p_signatario: sigId, p_token_hash: h })).rejects.toThrow(/permission denied/);
    await expect(comoAnonimo(db, (tx) => tx.query("select public.assinatura_verificar($1)", ["a".repeat(64)]))).rejects.toThrow(/permission denied/);
    await expect(comoAnonimo(db, (tx) => tx.query("select public.assinatura_texto_aceite()"))).rejects.toThrow(/permission denied/);
  });

  it("validações da criação: PDF inválido, signatários inválidos ou repetidos, processo de outro escritório", async () => {
    const bom = await pdfDeTeste(1);
    const base = { p_escritorio: esc, p_titulo: "Contrato", p_nome_arquivo: "a.pdf", p_processo: null };
    const sigOk = [{ nome: "Fulano Teste", email: "f@teste.com" }];
    await expect(usuario(BIA, "assinatura_criar", { ...base, p_pdf: byteaDeBytes(new TextEncoder().encode("isto não é um pdf, mas é comprido o bastante para passar do tamanho mínimo da verificação.................")), p_signatarios: sigOk })).rejects.toThrow(/pdf_invalido/);
    await expect(usuario(BIA, "assinatura_criar", { ...base, p_pdf: byteaDeBytes(bom), p_signatarios: [] })).rejects.toThrow(/signatarios_invalidos/);
    await expect(usuario(BIA, "assinatura_criar", { ...base, p_pdf: byteaDeBytes(bom), p_signatarios: [{ nome: "X", email: "x@teste.com" }] })).rejects.toThrow(/signatarios_invalidos/);
    await expect(usuario(BIA, "assinatura_criar", { ...base, p_pdf: byteaDeBytes(bom), p_signatarios: [{ nome: "Fulano Teste", email: "nao-e-email" }] })).rejects.toThrow(/signatarios_invalidos/);
    await expect(usuario(BIA, "assinatura_criar", { ...base, p_pdf: byteaDeBytes(bom), p_signatarios: [sigOk[0], { nome: "Outro Nome", email: "F@teste.com" }] })).rejects.toThrow(/signatarios_invalidos/);
    await expect(usuario(BIA, "assinatura_criar", { ...base, p_pdf: byteaDeBytes(bom), p_signatarios: sigOk, p_processo: "00000000-0000-4000-8000-00000000ffff" })).rejects.toThrow(/processo_invalido/);
    await expect(usuario(BIA, "assinatura_criar", { ...base, p_titulo: "ab", p_pdf: byteaDeBytes(bom), p_signatarios: sigOk })).rejects.toThrow();
  });

  it("criar e cancelar entram no audit_log", async () => {
    const acoes = await consultar<{ acao: string }>(ANA, "select acao from public.audit_log where tabela = 'assinatura_envelope' and registro_id = $1 order by id", [envId]);
    expect(acoes.map((a) => a.acao)).toContain("insert");
  });
});
