import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { ServicoWhatsapp, ResultadoZap } from "@/lib/integrations/whatsapp";
import type { EntradaZap } from "@/lib/whatsapp/payload";
import { classificadorComIa, tratarMensagem, type DepsRecepcao } from "@/lib/whatsapp/processar";
import * as T from "@/lib/whatsapp/textos";
import { criarBanco, criarUsuario, rpcComoServico } from "./banco";

const ANA = "00000000-0000-4000-8000-0000000000b1"; // dona
const BIA = "00000000-0000-4000-8000-0000000000b2"; // módulo atendimento
const CAIO = "00000000-0000-4000-8000-0000000000b3"; // sem o módulo
const ZE = "00000000-0000-4000-8000-0000000000b4"; // dono de outro escritório
const PHONE_ID = "1000001";
const PESSOA = "5571999990001";

let db: PGlite;
let esc: string, outro: string;
const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const todos = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const servico = () => rpcComoServico(db);

async function chamar<R>(uid: string, funcao: string, args: Record<string, unknown>): Promise<R> {
  const nomes = Object.keys(args);
  const sql = `select public.${funcao}(${nomes.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`;
  const r = await db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    return tx.query<{ r: R }>(sql, nomes.map((n) => { const v = args[n]; return v !== null && typeof v === "object" && !(Array.isArray(v) && v.every((x) => typeof x === "string")) ? JSON.stringify(v) : v; }));
  });
  return r.rows[0].r;
}
const comoUsuario = async <R,>(uid: string, sql: string, p: unknown[] = []) => db.transaction(async (tx) => {
  await tx.exec("set local role authenticated");
  await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
  return (await tx.query<R>(sql, p)).rows;
});

class ZapFalso implements ServicoWhatsapp {
  enviados: { para: string; texto: string }[] = [];
  falhar = false;
  private n = 0;
  async enviarTexto(p: { phoneNumberId: string; para: string; texto: string }): Promise<ResultadoZap> {
    if (this.falhar) return { ok: false, motivo: "Meta 500 simulado" };
    this.enviados.push({ para: p.para, texto: p.texto });
    return { ok: true, wamid: `wamid.saida.${++this.n}` };
  }
  async enviarModelo(): Promise<ResultadoZap> { return { ok: true, wamid: `wamid.modelo.${++this.n}` }; }
}

let zap: ZapFalso;
const deps = (extra: Partial<DepsRecepcao> = {}): DepsRecepcao => ({ rpc: servico(), whatsapp: zap, ...extra });
let seq = 0;
const msg = (texto: string | null, o: Partial<EntradaZap> = {}): EntradaZap => ({
  phoneNumberId: PHONE_ID, waId: PESSOA, wamid: `wamid.in.${++seq}`, tipo: texto === null ? "outro" : "texto", tipoOriginal: texto === null ? "audio" : "text",
  texto, nomePerfil: "Perfil Teste", enviadaEm: new Date(), ...o,
});
const conversar = async (...textos: string[]) => { for (const t of textos) await tratarMensagem(deps(), msg(t)); };

async function limpar() {
  await db.query("delete from public.whatsapp_conversa");
  await db.query("delete from public.notificacao");
  zap = new ZapFalso();
}

const FRASES = (cfg: { prazo: string | null; horario: string | null }) => {
  const s = new Set<string>([T.saudacao("Prado Advocacia"), T.MENU_MOTIVOS, T.PEDIR_NOME, T.PEDIR_NOME_DE_NOVO, T.PEDIR_RESUMO, T.SO_TEXTO, T.SEM_ORIENTACAO]);
  for (const c of T.CATEGORIAS) for (const t of T.transferencia({ escritorio: "Prado Advocacia", prazoTexto: cfg.prazo, horarioTexto: cfg.horario, categoria: c })) s.add(t);
  return s;
};

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, e] of [[ANA, "ana@t.com"], [BIA, "bia@t.com"], [CAIO, "caio@t.com"], [ZE, "ze@t.com"]]) await criarUsuario(db, id, e);
  esc = await chamar<string>(ANA, "criar_escritorio", { p_nome: "Prado Advocacia", p_cnpj: null, p_plano: "equipe" });
  outro = await chamar<string>(ZE, "criar_escritorio", { p_nome: "Outro Escritório", p_cnpj: null, p_plano: "equipe" });
  const t1 = await chamar<string>(ANA, "criar_convite", { p_escritorio: esc, p_email: "bia@t.com", p_modulos: ["atendimento"] });
  await chamar(BIA, "aceitar_convite", { p_token: t1 });
  const t2 = await chamar<string>(ANA, "criar_convite", { p_escritorio: esc, p_email: "caio@t.com", p_modulos: ["processos"] });
  await chamar(CAIO, "aceitar_convite", { p_token: t2 });
  await db.query("update public.membro set nome = initcap(split_part(email, '@', 1)) where escritorio_id = $1", [esc]);
  await chamar(ANA, "whatsapp_numero_salvar", { p_escritorio: esc, p_phone_number_id: PHONE_ID, p_numero_exibicao: "(71) 3000-0001", p_ativo: true });
  await chamar(ANA, "recepcao_config_salvar", { p_escritorio: esc, p_dados: { ativa: true, responsavel_id: BIA, prazo_resposta_texto: "", horario_texto: "", modelo_retomada: "retomada_atendimento", modelo_idioma: "pt_BR" } });
  // Clientes: um confirmado com o telefone da PESSOA (sem o 9 e sem o 55 no cadastro), dois confirmados com o mesmo telefone, um provisório.
  await db.query("insert into public.cliente (escritorio_id, nome, telefone, status, confirmado_em) values ($1, 'Cliente Exemplo', '7199990001', 'confirmado', now())", [esc]);
  await db.query("insert into public.cliente (escritorio_id, nome, telefone, status, confirmado_em) values ($1, 'Irmão Um', '71988880002', 'confirmado', now()), ($1, 'Irmão Dois', '5571988880002', 'confirmado', now())", [esc]);
  await db.query("insert into public.cliente (escritorio_id, nome, telefone, status) values ($1, 'Provisório', '71977770003', 'provisorio')", [esc]);
  zap = new ZapFalso();
});

describe("Critério de pronto: conversa simulada de um novo contato", () => {
  it("termina com atendimento criado, humano avisado e nenhuma orientação jurídica", async () => {
    await limpar();
    const NOVO = "5571955550009"; // telefone que não está no cadastro
    const falas = ["Oi", "Boa tarde, preciso de um advogado, fui demitido sem receber nada", "vou ganhar a causa? tenho direito a indenização?", "Maria da Silva"];
    for (const f of falas) await tratarMensagem(deps(), msg(f, { waId: NOVO }));

    const at = await todos<{ id: string; categoria: string; nome_contato: string; identificacao: string; status: string; responsavel_id: string; telefone: string }>("select * from public.atendimento");
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ categoria: "novo_caso", nome_contato: "Maria da Silva", identificacao: "novo_contato", status: "aberto", responsavel_id: BIA, telefone: NOVO });

    // Humano avisado (a responsável configurada) com link para o atendimento.
    const av = await todos<{ usuario_id: string; tipo: string; link: string; titulo: string }>("select * from public.notificacao");
    expect(av).toHaveLength(1);
    expect(av[0]).toMatchObject({ usuario_id: BIA, tipo: "atendimento_novo", link: `/app/atendimentos/${at[0].id}` });

    // A recepcionista parou: a conversa está com humano.
    expect((await um<{ estado: string }>("select estado from public.whatsapp_conversa")).estado).toBe("humano");

    // Tudo o que a recepcionista disse (banco e envio) é frase fixa; nada de orientação.
    const ok = FRASES({ prazo: null, horario: null });
    const saidas = await todos<{ texto: string; status: string }>("select texto, status from public.whatsapp_mensagem where autor = 'recepcao' order by criado_em");
    expect(saidas.length).toBeGreaterThanOrEqual(5);
    for (const s of saidas) { expect(ok.has(s.texto), s.texto).toBe(true); expect(s.status).toBe("enviada"); }
    expect(zap.enviados.map((e) => e.texto)).toEqual(saidas.map((s) => s.texto));
    expect(saidas.some((s) => s.texto === T.SEM_ORIENTACAO)).toBe(true);
    const tudo = saidas.map((s) => s.texto).join("\n");
    expect(tudo).not.toMatch(/(vai ganhar|tem direito|indeniza|recomendo|aconselho|chance|probabilidade)/i);
    expect(tudo).not.toMatch(/\b(horas?|dias?|úteis|semanas?|amanhã|breve)\b/i);
    // Saudou com o nome do escritório.
    expect(saidas[0].texto).toContain("Prado Advocacia");
  });
});

describe("passou para humano: recepcionista muda até alguém encerrar", () => {
  it("mensagens novas são guardadas, ninguém responde, não nasce outro atendimento", async () => {
    await limpar();
    await conversar("Oi", "quero marcar uma reunião", "Joana Souza");
    const antes = zap.enviados.length;
    await conversar("alguém aí?", "oi???", "por favor respondam");
    expect(zap.enviados.length).toBe(antes);
    expect(await um<{ n: string }>("select count(*)::text n from public.atendimento")).toEqual({ n: "1" });
    const entradas = await um<{ n: string; pend: string }>("select count(*)::text n, count(*) filter (where processada_em is null)::text pend from public.whatsapp_mensagem where direcao = 'entrada'");
    expect(entradas).toEqual({ n: "6", pend: "0" });
  });

  it("depois de encerrar, a próxima mensagem abre uma conversa nova e a recepcionista volta a atender", async () => {
    const at = await um<{ id: string }>("select id from public.atendimento");
    await chamar(BIA, "atendimento_encerrar", { p_id: at.id });
    expect((await um<{ estado: string }>("select estado from public.whatsapp_conversa where atendimento_id = $1", [at.id])).estado).toBe("encerrada");
    const antes = zap.enviados.length;
    await conversar("Olá, de novo");
    expect(zap.enviados.length).toBeGreaterThan(antes);
    expect(zap.enviados[antes].texto).toContain("recepção virtual");
    expect(await um<{ n: string }>("select count(*)::text n from public.whatsapp_conversa")).toEqual({ n: "2" });
  });
});

describe("identificação pelo telefone", () => {
  it("telefone de um único cliente confirmado casa mesmo sem o 9 e sem o 55; não pergunta o nome", async () => {
    await limpar();
    await conversar("Oi", "preciso da segunda via do boleto");
    expect(zap.enviados.map((e) => e.texto)).not.toContain(T.PEDIR_NOME);
    const at = await um<{ identificacao: string; nome_contato: string; cliente_id: string; categoria: string }>("select * from public.atendimento");
    expect(at).toMatchObject({ identificacao: "cliente_cadastrado", nome_contato: "Cliente Exemplo", categoria: "financeiro" });
    expect(at.cliente_id).toBeTruthy();
    // A recepcionista NÃO revela o nome nem nada do cadastro.
    expect(zap.enviados.map((e) => e.texto).join("\n")).not.toContain("Cliente Exemplo");
  });

  it("telefone de mais de um cliente fica 'ambíguo' (não é confirmado como de ninguém)", async () => {
    await limpar();
    await tratarMensagem(deps(), msg("Oi", { waId: "5571988880002" }));
    const c = await um<{ identificacao: string; cliente_id: string | null }>("select identificacao, cliente_id from public.whatsapp_conversa");
    expect(c).toEqual({ identificacao: "ambiguo", cliente_id: null });
  });

  it("cliente provisório e telefone desconhecido são 'contato novo'", async () => {
    await limpar();
    await tratarMensagem(deps(), msg("Oi", { waId: "5571977770003" }));
    await tratarMensagem(deps(), msg("Oi", { waId: "5571911112222" }));
    expect((await todos<{ identificacao: string }>("select identificacao from public.whatsapp_conversa")).map((c) => c.identificacao)).toEqual(["novo_contato", "novo_contato"]);
  });

  it("assunto de processo: a recepcionista não informa dado algum e avisa que a equipe confirma a identidade", async () => {
    await limpar();
    await db.query("insert into public.processo (escritorio_id, numero_cnj, tribunal, titulo, status, confirmado_em) values ($1, '00012345620248050001', 'TJBA', 'Ação secreta de Cliente Exemplo', 'confirmado', now())", [esc]);
    await conversar("Oi", "qual o andamento do processo 0001234-56.2024.8.05.0001?", "continua sem resposta");
    const texto = zap.enviados.map((e) => e.texto).join("\n");
    expect(texto).toContain(T.SEM_DADO_DE_PROCESSO);
    expect(texto).not.toMatch(/0001234|TJBA|secreta|Cliente Exemplo/);
    await db.query("delete from public.processo");
  });
});

describe("webhook: idempotência e falhas", () => {
  it("a mesma mensagem (mesmo wamid) reenviada pela Meta não gera outra resposta", async () => {
    await limpar();
    const m = msg("Oi");
    await tratarMensagem(deps(), m);
    const r = await tratarMensagem(deps(), m);
    expect(r).toEqual({ situacao: "ignorada", motivo: "duplicada" });
    expect(zap.enviados).toHaveLength(2); // saudação + menu, uma vez só
    expect(await um<{ n: string }>("select count(*)::text n from public.whatsapp_mensagem where direcao = 'entrada'")).toEqual({ n: "1" });
  });

  it("se o servidor caiu depois de guardar a mensagem, o reenvio da Meta ainda é tratado", async () => {
    await limpar();
    const m = msg("Oi");
    await servico()("recepcao_receber", { p_phone_number_id: PHONE_ID, p_wa_id: m.waId, p_wamid: m.wamid, p_tipo: "texto", p_texto: "Oi", p_nome_perfil: null, p_enviada_em: null }); // gravou e "caiu"
    expect(zap.enviados).toHaveLength(0);
    const r = await tratarMensagem(deps(), m);
    expect(r.situacao).toBe("tratada");
    expect(zap.enviados.length).toBe(2);
    expect(await um<{ n: string }>("select count(*)::text n from public.whatsapp_mensagem where direcao = 'entrada'")).toEqual({ n: "1" });
  });

  it("número desconhecido, desativado ou escritório com a recepcionista desligada: nada é guardado", async () => {
    await limpar();
    expect(await tratarMensagem(deps(), msg("Oi", { phoneNumberId: "9999999" }))).toEqual({ situacao: "ignorada", motivo: "numero_desconhecido" });
    await chamar(ANA, "recepcao_config_salvar", { p_escritorio: esc, p_dados: { ativa: false } });
    expect(await tratarMensagem(deps(), msg("Oi"))).toEqual({ situacao: "ignorada", motivo: "recepcao_desativada" });
    expect(await um<{ n: string }>("select count(*)::text n from public.whatsapp_mensagem")).toEqual({ n: "0" });
    expect(zap.enviados).toHaveLength(0);
    await chamar(ANA, "recepcao_config_salvar", { p_escritorio: esc, p_dados: { ativa: true, responsavel_id: BIA, modelo_retomada: "retomada_atendimento" } });
  });

  it("envio recusado pela Meta: o estado e o atendimento ficam gravados e a falha aparece para a equipe", async () => {
    await limpar();
    zap.falhar = true;
    await conversar("Oi", "quero marcar uma reunião", "Joana Souza");
    expect(await um<{ n: string }>("select count(*)::text n from public.atendimento")).toEqual({ n: "1" });
    const s = await todos<{ status: string; erro: string }>("select status, erro from public.whatsapp_mensagem where direcao = 'saida'");
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.status === "falhou" && x.erro === "Meta 500 simulado")).toBe(true);
  });

  it("mensagem que não é texto: pede texto e, depois de duas, passa para humano", async () => {
    await limpar();
    await tratarMensagem(deps(), msg(null));
    await tratarMensagem(deps(), msg(null));
    await tratarMensagem(deps(), msg(null));
    expect(zap.enviados.some((e) => e.texto === T.SO_TEXTO)).toBe(true);
    expect(await um<{ estado: string }>("select estado from public.whatsapp_conversa")).toEqual({ estado: "humano" });
    expect((await um<{ categoria: string }>("select categoria from public.atendimento")).categoria).toBe("outro");
  });

  it("decisão baseada em estado velho é recusada (conversa_mudou) e não grava nada", async () => {
    await limpar();
    await tratarMensagem(deps(), msg("Oi"));
    const c = await um<{ id: string; versao: number }>("select id, versao from public.whatsapp_conversa");
    const args = (v: number) => ({ p_conversa: c.id, p_versao: v, p_estado: "aguardando_nome", p_categoria: "outro", p_nome: null, p_resumo: null, p_tentativas: 0, p_respostas: ["x"], p_transferir: false, p_mensagem: null });
    await expect(servico()("recepcao_aplicar", args(c.versao - 1))).rejects.toThrow(/conversa_mudou/);
    expect(await um<{ n: string }>("select count(*)::text n from public.whatsapp_mensagem where texto = 'x'")).toEqual({ n: "0" });
  });

  it("recibos só avançam: enviada < entregue < lida; falha sempre vale", async () => {
    await limpar();
    await conversar("Oi");
    const w = (await um<{ wamid: string }>("select wamid from public.whatsapp_mensagem where direcao = 'saida' order by criado_em limit 1")).wamid;
    const st = async () => (await um<{ status: string }>("select status from public.whatsapp_mensagem where wamid = $1", [w])).status;
    await servico()("recepcao_status_webhook", { p_wamid: w, p_status: "lida", p_erro: null });
    expect(await st()).toBe("lida");
    await servico()("recepcao_status_webhook", { p_wamid: w, p_status: "entregue", p_erro: null });
    expect(await st()).toBe("lida");
    await servico()("recepcao_status_webhook", { p_wamid: w, p_status: "falhou", p_erro: "131047" });
    expect(await st()).toBe("falhou");
  });
});

describe("IA só classifica", () => {
  it("categoria vem da IA quando as palavras não acharam nada; resposta fora das 5 vira 'outro'", async () => {
    await limpar();
    const ia = { gerarTexto: async () => ({ ok: true as const, texto: "financeiro" }) };
    await tratarMensagem(deps({ classificar: classificadorComIa(ia) }), msg("Oi, estou com uma situação complicada com o meu vizinho", { waId: "5571966660001" }));
    expect((await um<{ categoria: string; estado: string }>("select categoria, estado from public.whatsapp_conversa")).categoria).toBe("financeiro");

    await limpar();
    const hostil = { gerarTexto: async () => ({ ok: true as const, texto: "Você vai ganhar a causa com certeza!" }) };
    await tratarMensagem(deps({ classificar: classificadorComIa(hostil) }), msg("Oi, estou com uma situação complicada com o meu vizinho", { waId: "5571966660001" }));
    expect((await um<{ categoria: string }>("select categoria from public.whatsapp_conversa")).categoria).toBe("outro");
    expect(zap.enviados.map((e) => e.texto).join("\n")).not.toContain("ganhar");
  });

  it("IA fora do ar não derruba a conversa", async () => {
    await limpar();
    const quebrada = { gerarTexto: async () => { throw new Error("timeout"); } };
    await tratarMensagem(deps({ classificar: classificadorComIa(quebrada) }), msg("Oi, estou com uma situação complicada com o meu vizinho", { waId: "5571966660002" }));
    expect(zap.enviados.length).toBeGreaterThan(0);
  });
});

describe("aviso à equipe", () => {
  it("sem responsável configurado, avisa todos os donos", async () => {
    await limpar();
    await chamar(ANA, "recepcao_config_salvar", { p_escritorio: esc, p_dados: { ativa: true, modelo_retomada: "retomada_atendimento" } });
    await conversar("Oi", "quero marcar uma reunião", "Joana Souza");
    expect((await todos<{ usuario_id: string }>("select usuario_id from public.notificacao")).map((n) => n.usuario_id)).toEqual([ANA]);
    await chamar(ANA, "recepcao_config_salvar", { p_escritorio: esc, p_dados: { ativa: true, responsavel_id: BIA, modelo_retomada: "retomada_atendimento" } });
  });

  it("frases de prazo e horário só saem se o escritório escreveu", async () => {
    await limpar();
    await chamar(ANA, "recepcao_config_salvar", { p_escritorio: esc, p_dados: { ativa: true, responsavel_id: BIA, prazo_resposta_texto: "Retornamos em até 1 dia útil.", horario_texto: "Atendemos de segunda a sexta, das 9h às 18h.", modelo_retomada: "retomada_atendimento" } });
    await conversar("Oi", "quero marcar uma reunião", "Joana Souza");
    const texto = zap.enviados.map((e) => e.texto).join("\n");
    expect(texto).toContain("Retornamos em até 1 dia útil.");
    expect(texto).toContain("Atendemos de segunda a sexta, das 9h às 18h.");
    for (const s of zap.enviados) expect(FRASES({ prazo: "Retornamos em até 1 dia útil.", horario: "Atendemos de segunda a sexta, das 9h às 18h." }).has(s.texto)).toBe(true);
    await chamar(ANA, "recepcao_config_salvar", { p_escritorio: esc, p_dados: { ativa: true, responsavel_id: BIA, modelo_retomada: "retomada_atendimento" } });
  });
});

describe("janela de 24 h da Meta (resposta do humano)", () => {
  let at: string;
  it("dentro das 24 h o humano envia texto livre", async () => {
    await limpar();
    await conversar("Oi", "quero marcar uma reunião", "Joana Souza");
    at = (await um<{ id: string }>("select id from public.atendimento")).id;
    const p = await chamar<{ modo: string; telefone: string; phone_number_id: string; mensagem_id: string }>(BIA, "atendimento_preparar_envio", { p_id: at, p_texto: "Olá, Joana! Posso te atender na terça às 15h?" });
    expect(p).toMatchObject({ modo: "texto", telefone: PESSOA, phone_number_id: PHONE_ID });
    await chamar(BIA, "atendimento_envio_resultado", { p_mensagem: p.mensagem_id, p_wamid: "wamid.h1", p_ok: true, p_erro: null });
    expect((await um<{ status: string; autor: string; usuario_id: string }>("select status, autor, usuario_id from public.whatsapp_mensagem where wamid = 'wamid.h1'"))).toEqual({ status: "enviada", autor: "humano", usuario_id: BIA });
    expect((await um<{ status: string; responsavel_id: string }>("select status, responsavel_id from public.atendimento where id = $1", [at])).status).toBe("em_andamento");
  });

  it("passadas 24 h, texto livre é recusado; só o modelo aprovado pode ir", async () => {
    await db.query("update public.whatsapp_conversa set ultima_entrada_em = now() - interval '25 hours'");
    await expect(chamar(BIA, "atendimento_preparar_envio", { p_id: at, p_texto: "Posso te ligar agora?" })).rejects.toThrow(/janela_24h_fechada/);
    const p = await chamar<{ modo: string; modelo: string; idioma: string }>(BIA, "atendimento_preparar_envio", { p_id: at, p_texto: null });
    expect(p).toMatchObject({ modo: "modelo", modelo: "retomada_atendimento", idioma: "pt_BR" });
    // O texto digitado nunca foi guardado como enviado.
    expect(await um<{ n: string }>("select count(*)::text n from public.whatsapp_mensagem where texto = 'Posso te ligar agora?'")).toEqual({ n: "0" });
  });

  it("sem modelo cadastrado, fora da janela não há como falar", async () => {
    await chamar(ANA, "recepcao_config_salvar", { p_escritorio: esc, p_dados: { ativa: true, responsavel_id: BIA } });
    await expect(chamar(BIA, "atendimento_preparar_envio", { p_id: at, p_texto: null })).rejects.toThrow(/modelo_nao_configurado/);
    await chamar(ANA, "recepcao_config_salvar", { p_escritorio: esc, p_dados: { ativa: true, responsavel_id: BIA, modelo_retomada: "retomada_atendimento" } });
  });

  it("quando a pessoa responde, a janela reabre", async () => {
    await tratarMensagem(deps(), msg("Pode ser sim", { waId: PESSOA }));
    const p = await chamar<{ modo: string }>(BIA, "atendimento_preparar_envio", { p_id: at, p_texto: "Combinado!" });
    expect(p.modo).toBe("texto");
  });

  it("atendimento encerrado não recebe mais mensagem do humano", async () => {
    await chamar(BIA, "atendimento_encerrar", { p_id: at });
    await expect(chamar(BIA, "atendimento_preparar_envio", { p_id: at, p_texto: "oi" })).rejects.toThrow(/atendimento_encerrado/);
  });
});

describe("permissões e RLS", () => {
  let at: string;
  it("prepara: um atendimento no escritório", async () => {
    await limpar();
    await conversar("Oi", "quero marcar uma reunião", "Joana Souza");
    at = (await um<{ id: string }>("select id from public.atendimento")).id;
    // Atendimento do outro escritório
    await chamar(ZE, "whatsapp_numero_salvar", { p_escritorio: outro, p_phone_number_id: "2000002", p_numero_exibicao: null, p_ativo: true });
    await chamar(ZE, "recepcao_config_salvar", { p_escritorio: outro, p_dados: { ativa: true } });
    await tratarMensagem(deps(), msg("Oi", { phoneNumberId: "2000002", waId: "5571900000001" }));
  });

  it("quem tem o módulo vê; quem não tem não vê atendimento, conversa nem mensagem", async () => {
    for (const t of ["atendimento", "whatsapp_conversa", "whatsapp_mensagem"]) {
      expect((await comoUsuario<{ n: string }>(BIA, `select count(*)::text n from public.${t}`))[0].n).not.toBe("0");
      expect((await comoUsuario<{ n: string }>(CAIO, `select count(*)::text n from public.${t}`))[0].n).toBe("0");
    }
    await expect(chamar(CAIO, "atendimento_preparar_envio", { p_id: at, p_texto: "oi" })).rejects.toThrow(/sem_permissao/);
    await expect(chamar(CAIO, "atendimento_encerrar", { p_id: at })).rejects.toThrow(/sem_permissao/);
  });

  it("outro escritório não lê nem mexe em nada daqui", async () => {
    for (const t of ["atendimento", "whatsapp_conversa", "whatsapp_mensagem", "whatsapp_numero", "recepcao_config"]) {
      const linhas = await comoUsuario<{ escritorio_id: string }>(ZE, `select escritorio_id from public.${t}`);
      expect(linhas.every((l) => l.escritorio_id === outro), t).toBe(true);
    }
    await expect(chamar(ZE, "atendimento_encerrar", { p_id: at })).rejects.toThrow(/sem_permissao/);
    await expect(chamar(ZE, "atendimento_assumir", { p_id: at })).rejects.toThrow(/sem_permissao/);
    await expect(chamar(ZE, "recepcao_config_salvar", { p_escritorio: esc, p_dados: { ativa: false } })).rejects.toThrow(/sem_permissao/);
    expect((await um<{ ativa: boolean }>("select ativa from public.recepcao_config where escritorio_id = $1", [esc])).ativa).toBe(true);
  });

  it("ninguém grava direto nas tabelas; funções do webhook não são do usuário", async () => {
    await expect(comoUsuario(BIA, "update public.atendimento set status = 'encerrado'")).rejects.toThrow();
    await expect(comoUsuario(BIA, "insert into public.whatsapp_mensagem (escritorio_id, conversa_id, direcao, autor, texto, status) select escritorio_id, id, 'saida', 'recepcao', 'x', 'enviada' from public.whatsapp_conversa limit 1")).rejects.toThrow();
    await expect(chamar(BIA, "recepcao_receber", { p_phone_number_id: PHONE_ID, p_wa_id: PESSOA, p_wamid: "w", p_tipo: "texto", p_texto: "x", p_nome_perfil: null, p_enviada_em: null })).rejects.toThrow();
    await expect(chamar(BIA, "recepcao_status_webhook", { p_wamid: "w", p_status: "lida", p_erro: null })).rejects.toThrow();
  });

  it("configuração e números: só o dono; o mesmo número não serve a dois escritórios", async () => {
    await expect(chamar(BIA, "recepcao_config_salvar", { p_escritorio: esc, p_dados: { ativa: false } })).rejects.toThrow(/sem_permissao/);
    await expect(chamar(BIA, "whatsapp_numero_salvar", { p_escritorio: esc, p_phone_number_id: "3000003", p_numero_exibicao: null, p_ativo: true })).rejects.toThrow(/sem_permissao/);
    await expect(chamar(ZE, "whatsapp_numero_salvar", { p_escritorio: outro, p_phone_number_id: PHONE_ID, p_numero_exibicao: null, p_ativo: true })).rejects.toThrow(/numero_em_uso/);
    await expect(chamar(ANA, "recepcao_config_salvar", { p_escritorio: esc, p_dados: { ativa: true, responsavel_id: ZE } })).rejects.toThrow(/responsavel_invalido/);
  });

  it("as conversas de um escritório nunca recebem resposta do número de outro", async () => {
    const r = await um<{ phone_number_id: string }>("select n.phone_number_id from public.whatsapp_conversa c join public.whatsapp_numero n on n.id = c.numero_id where c.telefone = '5571900000001'");
    expect(r.phone_number_id).toBe("2000002");
  });

  it("auditoria: atendimento e configuração gravam no audit_log; o texto das mensagens não", async () => {
    const tabelas = (await todos<{ tabela: string }>("select distinct tabela from public.audit_log")).map((t) => t.tabela);
    expect(tabelas).toEqual(expect.arrayContaining(["atendimento", "recepcao_config", "whatsapp_numero", "whatsapp_conversa"]));
    expect(tabelas).not.toContain("whatsapp_mensagem");
  });

  it("dados de processo e financeiro não vazam por estas tabelas: nenhuma referencia processo", async () => {
    const cols = await todos<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('atendimento','whatsapp_conversa','whatsapp_mensagem') and column_name like '%processo%'");
    expect(cols).toEqual([]);
  });
});
