import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { byteaDeBytes } from "@/lib/assinatura/bytea";
import { finalizarEnvelope } from "@/lib/assinatura/finalizar";
import { rodarRotinaEncerramento } from "@/lib/conta/rotina";
import type { ServicoEmail } from "@/lib/integrations/email";
import { hashDoToken, novoToken } from "@/lib/portal/token";
import { pdfDeTeste } from "../pdf-teste";
import { comoUsuario, criarBanco, criarUsuario, rpcComoServico } from "./banco";

/**
 * Critério de pronto do Prompt 14, de ponta a ponta: a ROTINA REAL (a mesma do cron) rodando dia a dia com relógio
 * simulado. Dia 0 pedido; dia 23 aviso de 7 dias; dia 30 exclusão; o documento assinado sobrevive.
 */
const ANA = "00000000-0000-4000-8000-0000000000a1";
const BIA = "00000000-0000-4000-8000-0000000000a2";
const T0 = new Date("2027-05-10T09:00:00Z");
const dia = (n: number) => new Date(T0.getTime() + n * 86_400_000);

let db: PGlite;
let esc: string, envelope: string, hashFinal: string;
const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const rpc = () => rpcComoServico(db);

class EmailFalso implements ServicoEmail {
  enviados: { para: string; assunto: string }[] = [];
  fora = false;
  async enviarAviso(p: { para: string; assunto: string; texto: string }) {
    if (this.fora) return { enviado: false as const, motivo: "Resend fora do ar (simulado)" };
    this.enviados.push({ para: p.para, assunto: p.assunto });
    return { enviado: true as const };
  }
  async enviarConvite() { return { enviado: true as const }; }
  async enviarLinkPortal() { return { enviado: true as const }; }
  async enviarLinkAssinatura() { return { enviado: true as const }; }
}
const email = new EmailFalso();
const rodar = (n: number) => rodarRotinaEncerramento(rpc(), email, dia(n));

beforeAll(async () => {
  db = await criarBanco();
  await criarUsuario(db, ANA, "ana@t.com");
  await criarUsuario(db, BIA, "bia@t.com");
  esc = await comoUsuario(db, ANA, async (tx) => (await tx.query<{ r: string }>("select public.criar_escritorio('Prado Advocacia', null, 'equipe') r")).rows[0].r);
  const tk = await comoUsuario(db, ANA, async (tx) => (await tx.query<{ r: string }>("select public.criar_convite($1, 'bia@t.com', array['assinaturas']) r", [esc])).rows[0].r);
  await comoUsuario(db, BIA, async (tx) => { await tx.query("select public.aceitar_convite($1)", [tk]); });
  await db.query("insert into public.cliente (escritorio_id, nome, status, confirmado_em) values ($1, 'Cliente Exemplo', 'confirmado', now())", [esc]);

  const env = await comoUsuario(db, BIA, async (tx) => (await tx.query<{ r: { id: string; signatarios: { id: string }[] } }>(
    "select public.assinatura_criar($1, 'Contrato', 'c.pdf', $2, null, $3::jsonb) r",
    [esc, await pdfDeTeste(1), JSON.stringify([{ nome: "Joana Teste", email: "joana@teste.com", ordem: 1 }])])).rows[0].r);
  envelope = env.id;
  const token = novoToken();
  await comoUsuario(db, BIA, async (tx) => { await tx.query("select public.assinatura_emitir_link($1, $2)", [env.signatarios[0].id, hashDoToken(token)]); });
  const base = { p_token_hash: hashDoToken(token), p_ip: "203.0.113.9", p_user_agent: "Teste" };
  await rpc()("assinatura_abrir", base);
  await rpc()("assinatura_documento_para_assinar", base);
  await rpc()("assinatura_assinar", { ...base, p_cpf: "529.982.247-25", p_aceite: true });
  const fim = await finalizarEnvelope(rpc(), envelope);
  if (!fim.ok) throw new Error("não finalizou");
  hashFinal = fim.hashFinal;
  void byteaDeBytes;
});

describe("Rotina do cron com relógio simulado", () => {
  it("dia 0: sem pedido, a rotina não faz nada", async () => {
    expect(await rodar(0)).toEqual({ excluidas: [], avisos: [], falhas: [] });
  });

  it("pedido no dia 0: e-mail do pedido sai; se o Resend cair, não é marcado e sai no dia seguinte", async () => {
    await rpc()("conta_encerramento_solicitar", { p_escritorio: esc, p_usuario: ANA, p_agora: dia(0).toISOString() });
    email.fora = true;
    const falho = await rodar(0);
    expect(falho.avisos).toEqual([{ escritorio: esc, tipo: "pedido", enviado: false }]);
    expect(email.enviados).toHaveLength(0);
    email.fora = false;
    const ok = await rodar(1);
    expect(ok.avisos).toEqual([{ escritorio: esc, tipo: "pedido", enviado: true }]);
    expect(email.enviados.map((e) => e.para)).toEqual(["ana@t.com"]);
    expect(email.enviados[0].assunto).toContain("30 dias");
    expect((await rodar(2)).avisos).toEqual([]); // não repete
  });

  it("dias 3 a 22: silêncio. Dia 23: aviso de 7 dias, uma vez", async () => {
    for (const n of [3, 10, 22]) expect((await rodar(n)).avisos).toEqual([]);
    const r = await rodar(23);
    expect(r.avisos).toEqual([{ escritorio: esc, tipo: "sete_dias", enviado: true }]);
    expect(email.enviados.at(-1)?.assunto).toContain("Faltam 7 dias");
    expect((await rodar(24)).avisos).toEqual([]);
    expect((await rodar(29)).excluidas).toEqual([]);
    expect((await um<{ n: number }>("select count(*)::int n from public.cliente where escritorio_id = $1", [esc])).n).toBe(1);
  });

  it("dia 30: exclui o escritório, avisa a exclusão, e o documento assinado sobrevive", async () => {
    const r = await rodar(30);
    expect(r.excluidas).toEqual([esc]);
    expect(r.falhas).toEqual([]);
    expect(r.avisos).toEqual([{ escritorio: esc, tipo: "exclusao", enviado: true }]);
    expect(email.enviados.at(-1)?.assunto).toContain("foram apagados");
    expect(email.enviados.map((e) => e.assunto.split(":")[0].slice(0, 12))).toHaveLength(3);

    // Escritório e dados: sumiram.
    expect(await um("select id from public.escritorio where id = $1", [esc])).toBeUndefined();
    expect((await um<{ n: number }>("select count(*)::int n from public.cliente where escritorio_id = $1", [esc])).n).toBe(0);
    expect((await um<{ n: number }>("select count(*)::int n from public.membro where escritorio_id = $1", [esc])).n).toBe(0);

    // Documento assinado: intacto.
    const e = await um<{ status: string; hash_final: string }>("select status, hash_final from public.assinatura_envelope where id = $1", [envelope]);
    expect(e).toEqual({ status: "concluido", hash_final: hashFinal });
    expect((await um<{ n: number }>("select count(*)::int n from public.assinatura_arquivo where envelope_id = $1 and final is not null", [envelope])).n).toBe(1);
    expect((await um<{ n: number }>("select count(*)::int n from public.assinatura_evidencia where envelope_id = $1", [envelope])).n).toBeGreaterThan(3);
    expect(await rpc()("assinatura_verificar", { p_hash: hashFinal })).toMatchObject({ encontrado: true });
  });

  it("dia 31 em diante: rotina quieta, nada de e-mail repetido", async () => {
    const antes = email.enviados.length;
    expect(await rodar(31)).toEqual({ excluidas: [], avisos: [], falhas: [] });
    expect(await rodar(400)).toEqual({ excluidas: [], avisos: [], falhas: [] });
    expect(email.enviados).toHaveLength(antes);
  });
});
