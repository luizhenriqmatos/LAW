import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import type { ChamarRpc } from "@/lib/captura/job";
import { enviarArquivo, LIMITE_ARQUIVO_BYTES, listarArquivos } from "@/lib/drive/arquivos";
import { concluirConexaoDrive } from "@/lib/drive/conectar";
import { processarFilaDrive } from "@/lib/drive/sync";
import type { DepsDrive } from "@/lib/drive/token";
import { decifrar } from "@/lib/integrations/google/cripto";
import { comoUsuario, criarBanco, criarUsuario, rpcComoServico } from "./banco";
import { DriveFalso } from "../fake-drive";

const ANA = "00000000-0000-4000-8000-0000000000c1"; // dona
const BIA = "00000000-0000-4000-8000-0000000000c2"; // membro: processos + documentos
const CAIO = "00000000-0000-4000-8000-0000000000c3"; // membro: só tarefas
const OUTRO = "00000000-0000-4000-8000-0000000000c4"; // dono de outro escritório

let db: PGlite;
let esc: string;
let escOutro: string;
const drive = new DriveFalso();
const chave = randomBytes(32);

const chamar = (uid: string, sql: string, p: unknown[] = []) => comoUsuario(db, uid, (tx) => tx.query(sql, p));
const um = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const rpcUser = async <T,>(uid: string, sql: string, p: unknown[] = []) => ((await chamar(uid, sql, p)).rows[0] as { r: T }).r;

const rpcServ: ChamarRpc = async (funcao, args) => {
  if (funcao === "drive_pegar_fila") {
    return db.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      return (await tx.query<{ r: unknown }>("select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) r from public.drive_pegar_fila(p_limite => $1) t", [args.p_limite])).rows[0].r as never;
    });
  }
  return rpcComoServico(db)(funcao, args);
};
const deps = (): DepsDrive => ({ rpc: rpcServ, api: drive, renovar: drive.renovar, chave });
const rodar = () => processarFilaDrive(deps());
/** Faz a fila andar até esvaziar (como o cron). */
async function esvaziar() {
  for (let i = 0; i < 5; i++) if ((await rodar()).itens === 0) return;
}

async function conectar(refresh = "ana", usuario = ANA, escritorio = esc) {
  return concluirConexaoDrive({
    rpc: rpcServ, api: drive, chave, escritorioId: escritorio, usuarioId: usuario,
    tokens: { accessToken: `acc-${refresh}-0`, refreshToken: refresh, expiraEm: new Date(Date.now() + 3600_000), escopo: "drive.file" },
  });
}
async function novoCliente(nome: string, confirmar = true) {
  const { id } = await um<{ id: string }>("insert into public.cliente (escritorio_id, nome) values ($1, $2) returning id", [esc, nome]);
  if (confirmar) await chamar(BIA, "select public.confirmar_cliente($1)", [id]);
  return id;
}
async function novoProcesso(cnj: string, classe: string | null, partes: { cliente: string | null; polo: string; nome: string }[], confirmar = true) {
  const { id } = await um<{ id: string }>("insert into public.processo (escritorio_id, numero_cnj, classe) values ($1, $2, $3) returning id", [esc, cnj, classe]);
  for (const p of partes) await db.query("insert into public.processo_parte (escritorio_id, processo_id, nome, polo, cliente_id) values ($1, $2, $3, $4, $5)", [esc, id, p.nome, p.polo, p.cliente]);
  if (confirmar) await chamar(BIA, "select public.confirmar_processo($1)", [id]);
  return id;
}
const pasta = async (tipo: string, ref: string) => um<{ drive_id: string; nome: string; pai_drive_id: string } | undefined>("select drive_id, nome, pai_drive_id from public.drive_pasta where tipo = $1 and ref_id = $2 and status = 'ativa'", [tipo, ref]);
const naFila = async () => (await um<{ n: number }>("select count(*)::int n from public.drive_fila where processado_em is null")).n;

const CNJ1 = "00000011220268050001"; // 0000001-12.2026.8.05.0001
const CNJ1_FMT = "0000001-12.2026.8.05.0001";

beforeAll(async () => {
  db = await criarBanco();
  for (const [id, email] of [[ANA, "ana@t.com"], [BIA, "bia@t.com"], [CAIO, "caio@t.com"], [OUTRO, "outro@t.com"]]) await criarUsuario(db, id, email);
  esc = await rpcUser<string>(ANA, "select public.criar_escritorio('Prado Advocacia', null, 'equipe') as r");
  escOutro = await rpcUser<string>(OUTRO, "select public.criar_escritorio('Outro Escritorio', null, 'equipe') as r");
  const t1 = await rpcUser<string>(ANA, "select public.criar_convite($1, 'bia@t.com', '{processos,documentos}'::text[]) as r", [esc]);
  await chamar(BIA, "select public.aceitar_convite($1)", [t1]);
  const t2 = await rpcUser<string>(ANA, "select public.criar_convite($1, 'caio@t.com', '{tarefas}'::text[]) as r", [esc]);
  await chamar(CAIO, "select public.aceitar_convite($1)", [t2]);
});

describe("Segurança do banco", () => {
  it("tabelas do Drive não são acessíveis ao usuário logado (nem a conexão com os tokens)", async () => {
    for (const t of ["drive_conexao", "drive_pasta", "drive_fila"]) {
      await expect(chamar(ANA, `select * from public.${t}`)).rejects.toThrow(/permission denied/i);
    }
  });
  it("funções de serviço não são executáveis pelo usuário logado", async () => {
    await expect(chamar(ANA, "select public.drive_conexao_obter($1)", [esc])).rejects.toThrow(/permission denied/i);
    await expect(chamar(ANA, "select public.drive_pegar_fila(10)")).rejects.toThrow(/permission denied/i);
    await expect(chamar(ANA, "select public.drive_conexao_remover($1)", [esc])).rejects.toThrow(/permission denied/i);
  });
  it("só o dono pode gravar a conexão", async () => {
    await expect(rpcServ("drive_conexao_salvar", {
      p_escritorio: esc, p_usuario: BIA, p_refresh_cifrado: "x", p_access_cifrado: "y", p_expira: new Date().toISOString(), p_raiz: "r", p_clientes: "c",
    })).rejects.toThrow(/sem_permissao/);
  });
});

describe("Antes de conectar", () => {
  it("confirmar cliente não cria nada na fila nem no Drive", async () => {
    await novoCliente("Cliente Antigo");
    expect(await naFila()).toBe(0);
    expect(drive.nos.size).toBe(0);
    expect(await rpcUser(ANA, "select public.drive_status($1) as r", [esc])).toEqual({ conectado: false });
  });
});

describe("Conexão", () => {
  it("cria LAW e LAW/Clientes, guarda tokens CIFRADOS e põe os já confirmados na fila", async () => {
    await conectar("ana");
    expect(drive.caminhos()).toEqual(["LAW", "LAW/Clientes"]);
    const c = await um<{ refresh_token_cifrado: string; status: string }>("select refresh_token_cifrado, status from public.drive_conexao where escritorio_id = $1", [esc]);
    expect(c.status).toBe("ativa");
    expect(c.refresh_token_cifrado.startsWith("v1:")).toBe(true);
    expect(c.refresh_token_cifrado).not.toContain("ana");
    expect(decifrar(c.refresh_token_cifrado, chave)).toBe("ana");
    const st = await rpcUser<Record<string, unknown>>(ANA, "select public.drive_status($1) as r", [esc]);
    expect(st).toMatchObject({ conectado: true, status: "ativa" });
    expect(JSON.stringify(st)).not.toContain("v1:");
    expect(await naFila()).toBe(1); // o "Cliente Antigo" já confirmado
  });
  it("reconectar não duplica LAW nem LAW/Clientes", async () => {
    await conectar("ana");
    expect(drive.caminhos()).toEqual(["LAW", "LAW/Clientes"]);
    expect((await um<{ n: number }>("select count(*)::int n from public.drive_conexao")).n).toBe(1);
  });
  it("clientes já confirmados ganham pasta na primeira carga", async () => {
    await esvaziar();
    expect(drive.caminhos()).toEqual(["LAW", "LAW/Clientes", "LAW/Clientes/Cliente Antigo"]);
  });
});

describe("Pastas de cliente e processo", () => {
  let maria: string, proc1: string;

  it("confirmar cliente cria LAW/Clientes/<Nome>; provisório não cria", async () => {
    await novoCliente("Provisório Joaquim", false);
    maria = await novoCliente("Maria Silva");
    await esvaziar();
    expect(drive.caminhos()).toContain("LAW/Clientes/Maria Silva");
    expect(drive.caminhos().some((c) => c.includes("Joaquim"))).toBe(false);
    expect((await pasta("cliente", maria))?.nome).toBe("Maria Silva");
  });

  it("confirmar processo cria “<CNJ> - <classe>” dentro da pasta do cliente principal", async () => {
    proc1 = await novoProcesso(CNJ1, "Procedimento Comum", [
      { cliente: null, polo: "passivo", nome: "Empresa Ré SA" },
      { cliente: maria, polo: "ativo", nome: "Maria Silva" },
    ]);
    await esvaziar();
    expect(drive.caminhos()).toContain(`LAW/Clientes/Maria Silva/${CNJ1_FMT} - Procedimento Comum`);
    const p = await pasta("processo", proc1);
    expect(p?.pai_drive_id).toBe((await pasta("cliente", maria))?.drive_id);
  });

  it("processo sem cliente confirmado ainda não ganha pasta (e ganha quando o cliente aparece)", async () => {
    const prov = await novoCliente("Carlos Souza", false);
    const p = await novoProcesso("00000033420268050001", "Execução", [{ cliente: prov, polo: "ativo", nome: "Carlos Souza" }]);
    await esvaziar();
    expect(await pasta("processo", p)).toBeUndefined();
    await chamar(BIA, "select public.confirmar_cliente($1)", [prov]);
    await esvaziar();
    expect(drive.caminhos()).toContain("LAW/Clientes/Carlos Souza/0000003-34.2026.8.05.0001 - Execução");
  });

  it("renomear o cliente renomeia a pasta dele (a do processo continua dentro)", async () => {
    await chamar(BIA, "select public.cliente_renomear($1, '  Maria   Silva Santos ')", [maria]);
    await esvaziar();
    expect((await pasta("cliente", maria))?.nome).toBe("Maria Silva Santos");
    expect(drive.caminhos()).toContain(`LAW/Clientes/Maria Silva Santos/${CNJ1_FMT} - Procedimento Comum`);
    expect(drive.caminhos()).not.toContain("LAW/Clientes/Maria Silva");
  });

  it("renomear só vale para cliente confirmado e com permissão de Processos", async () => {
    const prov = await novoCliente("Ainda Provisório", false);
    await expect(chamar(BIA, "select public.cliente_renomear($1, 'X Y')", [prov])).rejects.toThrow(/cliente_nao_confirmado/);
    await expect(chamar(CAIO, "select public.cliente_renomear($1, 'Novo Nome')", [maria])).rejects.toThrow(/sem_permissao/);
    await expect(chamar(BIA, "select public.cliente_renomear($1, ' ')", [maria])).rejects.toThrow(/nome_invalido/);
  });

  it("muitas mudanças seguidas viram UMA entrada na fila (com versão maior), sem duplicar pasta", async () => {
    for (const n of ["Maria Silva S.", "Maria Silva Sa", "Maria Silva Santos"]) await chamar(BIA, "select public.cliente_renomear($1, $2)", [maria, n]);
    const f = await um<{ n: number; v: number }>("select count(*)::int n, max(versao)::int v from public.drive_fila where tipo = 'cliente' and ref_id = $1 and processado_em is null", [maria]);
    expect(f).toEqual({ n: 1, v: 3 });
    await esvaziar();
    expect((await pasta("cliente", maria))?.nome).toBe("Maria Silva Santos");
    expect(drive.caminhos().filter((c) => c.startsWith("LAW/Clientes/Maria")).length).toBe(2); // cliente + 1 processo
  });

  it("nome com barras e símbolos vira nome de pasta seguro", async () => {
    const c = await novoCliente("Ana / Bia \\ Ltda.");
    await esvaziar();
    expect((await pasta("cliente", c))?.nome).toBe("Ana - Bia - Ltda.");
  });

  it("mesclar um provisório num cliente: o processo muda de pasta para dentro do cliente destino", async () => {
    const prov = await novoCliente("Maria S Santos", false);
    const p = await novoProcesso("00000044520268050001", "Alimentos", [{ cliente: prov, polo: "ativo", nome: "Maria S Santos" }], false);
    // processo confirmado depois que o cliente já foi mesclado? aqui: confirma o processo com cliente provisório e mescla em seguida
    await chamar(BIA, "select public.confirmar_processo($1)", [p]);
    await chamar(BIA, "select public.mesclar_cliente($1, $2)", [prov, maria]);
    await esvaziar();
    expect(drive.caminhos()).toContain("LAW/Clientes/Maria Silva Santos/0000004-45.2026.8.05.0001 - Alimentos");
    expect(drive.chamadas.some((x) => x.startsWith("apagar"))).toBe(false);
  });
});

describe("Nunca apagar no Drive", () => {
  it("descartar cliente só desvincula: a pasta continua no Drive; confirmar de novo reaproveita a MESMA pasta", async () => {
    const c = await novoCliente("Descartável Ltda");
    await esvaziar();
    const antes = await pasta("cliente", c);
    const total = drive.nos.size;
    // Hoje o LAW só descarta provisórios; aqui forçamos o estado para provar que, se um confirmado deixar de valer, a pasta só é desvinculada.
    await db.query("update public.cliente set status = 'descartado', descartado_em = now() where id = $1", [c]);
    await esvaziar();
    expect(await pasta("cliente", c)).toBeUndefined();
    expect(drive.nos.has(antes!.drive_id)).toBe(true);
    expect(drive.nos.size).toBe(total);
    expect((await um<{ status: string }>("select status from public.drive_pasta where drive_id = $1", [antes!.drive_id])).status).toBe("desvinculada");
    await db.query("update public.cliente set status = 'confirmado', descartado_em = null where id = $1", [c]);
    await esvaziar();
    expect((await pasta("cliente", c))?.drive_id).toBe(antes!.drive_id);
    expect(drive.nos.size).toBe(total);
  });

  it("pasta apagada por fora no Drive: o LAW desvincula a antiga e recria, sem duplicar", async () => {
    const c = await novoCliente("Pasta Sumida");
    await esvaziar();
    const velha = (await pasta("cliente", c))!;
    drive.apagarPorFora(velha.drive_id);
    await chamar(BIA, "select public.cliente_renomear($1, 'Pasta Sumida Renomeada')", [c]);
    await esvaziar();
    const nova = (await pasta("cliente", c))!;
    expect(nova.drive_id).not.toBe(velha.drive_id);
    expect(drive.caminhos().filter((x) => x.includes("Pasta Sumida")).length).toBe(1);
    expect((await um<{ status: string }>("select status from public.drive_pasta where drive_id = $1", [velha.drive_id])).status).toBe("desvinculada");
  });

  it("jamais houve chamada de apagar durante todo o teste", () => {
    expect(drive.chamadas.filter((x) => /apagar|delete|remover/i.test(x))).toEqual([]);
  });
});

describe("Permissões na tela", () => {
  let c: string;
  beforeAll(async () => { c = await novoCliente("Cliente Permissões"); await esvaziar(); });

  it("quem tem Processos/Documentos enxerga a pasta; quem só tem Tarefas não; outro escritório não", async () => {
    expect(await rpcUser<{ nome: string }>(BIA, "select public.drive_pasta_de('cliente', $1) as r", [c])).toMatchObject({ nome: "Cliente Permissões" });
    expect(await rpcUser<{ nome: string }>(ANA, "select public.drive_pasta_de('cliente', $1) as r", [c])).toMatchObject({ nome: "Cliente Permissões" });
    await expect(chamar(CAIO, "select public.drive_pasta_de('cliente', $1)", [c])).rejects.toThrow(/sem_permissao/);
    await expect(chamar(OUTRO, "select public.drive_pasta_de('cliente', $1)", [c])).rejects.toThrow(/sem_permissao/);
  });
  it("pasta de cliente que deixou de estar confirmado não é entregue", async () => {
    const d = await novoCliente("Logo Descartado");
    await esvaziar();
    await db.query("update public.cliente set status = 'descartado', descartado_em = now() where id = $1", [d]);
    expect(await rpcUser(BIA, "select public.drive_pasta_de('cliente', $1) as r", [d])).toBeNull();
  });
  it("drive_status: quem não é do escritório não vê", async () => {
    await expect(chamar(OUTRO, "select public.drive_status($1)", [esc])).rejects.toThrow(/sem_permissao/);
  });
});

describe("Arquivos: listar e enviar", () => {
  let c: string;
  beforeAll(async () => { c = await novoCliente("Cliente Arquivos"); await esvaziar(); });

  it("upload pelo LAW aparece na pasta do Drive e na listagem, com link só do Google", async () => {
    const p = (await pasta("cliente", c))!;
    const r = await enviarArquivo(deps(), esc, p.drive_id, { nome: "procuração.pdf", tipo: "application/pdf", dados: new Uint8Array([1, 2, 3]) });
    expect(r).toMatchObject({ ok: true, dados: { nome: "procuração.pdf", tamanho: 3 } });
    expect(drive.caminhos().length).toBeGreaterThan(0);
    const lista = await listarArquivos(deps(), esc, p.drive_id);
    expect(lista.ok && lista.dados.map((a) => a.nome)).toEqual(["procuração.pdf"]);
    expect(lista.ok && lista.dados[0].link).toMatch(/^https:\/\/drive\.google\.com\//);
  });
  it("nome com caminho é limpo; arquivo vazio e arquivo grande são recusados antes de falar com o Google", async () => {
    const p = (await pasta("cliente", c))!;
    const antes = drive.chamadas.length;
    const r = await enviarArquivo(deps(), esc, p.drive_id, { nome: "../../etc/passwd.txt", tipo: "texto qualquer", dados: new Uint8Array([9]) });
    expect(r).toMatchObject({ ok: true, dados: { nome: "passwd.txt" } });
    expect(await enviarArquivo(deps(), esc, p.drive_id, { nome: "a.pdf", tipo: "application/pdf", dados: new Uint8Array(0) })).toEqual({ ok: false, codigo: "arquivo_vazio" });
    expect(await enviarArquivo(deps(), esc, p.drive_id, { nome: "g.pdf", tipo: "application/pdf", dados: new Uint8Array(LIMITE_ARQUIVO_BYTES + 1) })).toEqual({ ok: false, codigo: "arquivo_grande" });
    expect(drive.chamadas.length - antes).toBe(1); // só o envio válido chegou ao Drive
  });
  it("pasta sumida no Drive vira erro claro, não exceção", async () => {
    expect(await listarArquivos(deps(), esc, "pasta-que-nao-existe")).toEqual({ ok: false, codigo: "drive_pasta_sumiu" });
  });
});

describe("Falhas do Google", () => {
  it("falha temporária: tenta de novo depois, sem perder nem duplicar", async () => {
    const c = await novoCliente("Cliente Instável");
    drive.falhaTemporaria = "indisponivel";
    const r = await rodar();
    expect(r.falhas).toBeGreaterThan(0);
    drive.falhaTemporaria = null;
    const f = await um<{ tentativas: number; erro: string }>("select tentativas, erro from public.drive_fila where tipo = 'cliente' and ref_id = $1 and processado_em is null", [c]);
    expect(f.tentativas).toBe(1);
    await db.query("update public.drive_fila set proxima_tentativa = now() where processado_em is null");
    await esvaziar();
    expect(await pasta("cliente", c)).toBeDefined();
    expect(drive.caminhos().filter((x) => x.includes("Cliente Instável")).length).toBe(1);
  });

  it("token de acesso recusado (401): renova uma vez e segue", async () => {
    const c = await novoCliente("Cliente Token");
    const atual = decifrar((await um<{ a: string }>("select access_token_cifrado a from public.drive_conexao"))!.a, chave);
    drive.tokensRecusados.add(atual);
    await esvaziar();
    expect(await pasta("cliente", c)).toBeDefined();
    expect(drive.chamadas.filter((x) => x.startsWith("renovar")).length).toBeGreaterThan(0);
  });

  it("acesso revogado: PARA só o Drive, avisa os donos, não mexe em nada e reconectar retoma tudo", async () => {
    const c = await novoCliente("Cliente Revogado");
    drive.tokensRecusados.add(decifrar((await um<{ a: string }>("select access_token_cifrado a from public.drive_conexao"))!.a, chave));
    drive.refreshRevogados.add("ana");
    const r = await rodar();
    expect(r.conexoesParadas).toBe(1);
    expect(await pasta("cliente", c)).toBeUndefined();
    const st = await rpcUser<{ status: string }>(ANA, "select public.drive_status($1) as r", [esc]);
    expect(st.status).toBe("revogada");
    const n = await um<{ n: number; titulo: string }>("select count(*)::int n, max(titulo) titulo from public.notificacao where tipo = 'google' and titulo like 'Google Drive%'");
    expect(n).toEqual({ n: 1, titulo: "Google Drive desconectado" });
    // com a conexão parada, mudanças novas não enfileiram nada (e nada quebra)
    await chamar(BIA, "select public.cliente_renomear($1, 'Cliente Revogado 2')", [c]);
    // reconectar: a nova conexão é válida e tudo que faltava é criado
    drive.refreshRevogados.clear();
    drive.tokensRecusados.clear();
    await conectar("ana");
    await esvaziar();
    expect((await pasta("cliente", c))?.nome).toBe("Cliente Revogado 2");
    expect((await rpcUser<{ status: string }>(ANA, "select public.drive_status($1) as r", [esc])).status).toBe("ativa");
  });
});

describe("Desconectar", () => {
  it("remove a conexão e DESVINCULA as pastas; nada é apagado no Drive", async () => {
    const total = drive.nos.size;
    const antes = (await um<{ n: number }>("select count(*)::int n from public.drive_pasta where status = 'ativa'")).n;
    expect(antes).toBeGreaterThan(0);
    await rpcServ("drive_conexao_remover", { p_escritorio: esc });
    expect(drive.nos.size).toBe(total);
    expect((await um<{ n: number }>("select count(*)::int n from public.drive_pasta where status = 'ativa'")).n).toBe(0);
    expect(await rpcUser(ANA, "select public.drive_status($1) as r", [esc])).toEqual({ conectado: false });
    // mudanças depois de desconectar não enfileiram
    await novoCliente("Depois De Desconectar");
    expect(await naFila()).toBe(0);
  });
  it("isolamento: o outro escritório nunca teve nada do Drive", async () => {
    expect((await um<{ n: number }>("select count(*)::int n from public.drive_pasta where escritorio_id = $1", [escOutro])).n).toBe(0);
  });
});
