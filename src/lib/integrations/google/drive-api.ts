import { ErroGoogle } from "./erro";
import type { Fetch } from "./oauth";

export type ArquivoDrive = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
};

export const MIME_PASTA = "application/vnd.google-apps.folder";

/**
 * O que o LAW usa do Google Drive (escopo drive.file: só o que o próprio LAW criou).
 * Não existe "apagar" aqui DE PROPÓSITO: o LAW nunca apaga nada no Drive do escritório.
 * A implementação real é `apiGoogleDrive`; os testes usam uma falsa em memória.
 */
export interface GoogleDriveApi {
  /** Procura uma pasta criada pelo LAW pela marca (tipo+id) gravada nela; evita duplicar se o LAW caiu no meio. */
  buscarPorMarca(token: string, marca: string): Promise<{ id: string; name: string; parents: string[] } | null>;
  criarPasta(token: string, nome: string, paiId: string | null, marca: string): Promise<{ id: string }>;
  obterPasta(token: string, id: string): Promise<{ id: string; name: string; trashed: boolean; parents: string[] } | null>;
  renomear(token: string, id: string, nome: string): Promise<void>; // 404 => nao_encontrado
  mover(token: string, id: string, novoPaiId: string, antigoPaiId: string): Promise<void>; // 404 => nao_encontrado
  listar(token: string, paiId: string): Promise<ArquivoDrive[]>; // 404 => nao_encontrado
  enviar(token: string, paiId: string, nome: string, mime: string, dados: Uint8Array): Promise<ArquivoDrive>; // 404 => nao_encontrado
  /** Baixa o conteúdo de UM arquivo (portal do cliente). Arquivo nativo do Google (Docs, Planilhas) não baixa assim: erro "outro". */
  baixar(token: string, id: string): Promise<ArquivoBaixado>; // 404 => nao_encontrado
}

export type ArquivoBaixado = { nome: string; mime: string; tamanho: number | null; corpo: ReadableStream<Uint8Array> };

const BASE = "https://www.googleapis.com/drive/v3";
const ENVIO = "https://www.googleapis.com/upload/drive/v3/files";
const CAMPOS_ARQUIVO = "id,name,mimeType,size,modifiedTime,webViewLink";

/** Aspas e barras dentro de uma consulta do Drive precisam de escape. */
export const escapar = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function chamar(f: Fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await f(url, init);
  } catch {
    throw new ErroGoogle("indisponivel", "Sem resposta do Google Drive.");
  }
}

async function falha(res: Response): Promise<never> {
  const json = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[] } };
  const motivo = json.error?.errors?.[0]?.reason ?? "";
  const msg = `Google Drive (${res.status}${motivo ? `: ${motivo}` : ""}).`;
  if (res.status === 401) throw new ErroGoogle("nao_autorizado", msg);
  if (res.status === 429 || (res.status === 403 && /ratelimit|quota|storagequota/i.test(motivo))) throw new ErroGoogle("limite", msg);
  // Pasta que este app não pode tocar (ex.: criada por outra conexão): trata como "não achei" e o LAW recria.
  // Revogação de verdade é detectada na renovação do token (invalid_grant), não aqui.
  if (res.status === 403 && /appnotauthorizedtofile|insufficientfilepermissions|notfound/i.test(motivo)) throw new ErroGoogle("nao_encontrado", msg);
  if (res.status === 403) throw new ErroGoogle("outro", msg);
  if (res.status === 404 || res.status === 410) throw new ErroGoogle("nao_encontrado", msg);
  if (res.status >= 500) throw new ErroGoogle("indisponivel", msg);
  throw new ErroGoogle("outro", msg);
}

export function apiGoogleDrive(f: Fetch = fetch): GoogleDriveApi {
  const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
  const json = { "content-type": "application/json; charset=UTF-8" };
  const id = encodeURIComponent;

  return {
    async buscarPorMarca(token, marca) {
      const q = `appProperties has { key='law_marca' and value='${escapar(marca)}' } and mimeType='${MIME_PASTA}' and trashed=false`;
      const res = await chamar(f, `${BASE}/files?${new URLSearchParams({ q, fields: "files(id,name,parents)", pageSize: "1", spaces: "drive" })}`, { headers: auth(token) });
      if (!res.ok) await falha(res);
      const j = (await res.json()) as { files?: { id: string; name: string; parents?: string[] }[] };
      const a = j.files?.[0];
      return a ? { id: a.id, name: a.name, parents: a.parents ?? [] } : null;
    },
    async criarPasta(token, nome, paiId, marca) {
      const res = await chamar(f, `${BASE}/files?fields=id`, {
        method: "POST",
        headers: auth(token, json),
        body: JSON.stringify({ name: nome, mimeType: MIME_PASTA, ...(paiId ? { parents: [paiId] } : {}), appProperties: { law_marca: marca } }),
      });
      if (!res.ok) await falha(res);
      return { id: ((await res.json()) as { id: string }).id };
    },
    async obterPasta(token, pasta) {
      const res = await chamar(f, `${BASE}/files/${id(pasta)}?fields=id,name,trashed,parents`, { headers: auth(token) });
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) await falha(res);
      const j = (await res.json()) as { id: string; name: string; trashed?: boolean; parents?: string[] };
      return { id: j.id, name: j.name, trashed: !!j.trashed, parents: j.parents ?? [] };
    },
    async renomear(token, pasta, nome) {
      const res = await chamar(f, `${BASE}/files/${id(pasta)}?fields=id`, { method: "PATCH", headers: auth(token, json), body: JSON.stringify({ name: nome }) });
      if (!res.ok) await falha(res);
    },
    async mover(token, pasta, novoPai, antigoPai) {
      const q = new URLSearchParams({ addParents: novoPai, removeParents: antigoPai, fields: "id" });
      const res = await chamar(f, `${BASE}/files/${id(pasta)}?${q}`, { method: "PATCH", headers: auth(token) });
      if (!res.ok) await falha(res);
    },
    async listar(token, paiId) {
      const q = `'${escapar(paiId)}' in parents and trashed=false`;
      const out: ArquivoDrive[] = [];
      let pagina: string | undefined;
      do {
        const params = new URLSearchParams({ q, fields: `nextPageToken,files(${CAMPOS_ARQUIVO})`, orderBy: "folder,name", pageSize: "100" });
        if (pagina) params.set("pageToken", pagina);
        const res = await chamar(f, `${BASE}/files?${params}`, { headers: auth(token) });
        if (!res.ok) await falha(res);
        const j = (await res.json()) as { files?: ArquivoDrive[]; nextPageToken?: string };
        out.push(...(j.files ?? []));
        pagina = j.nextPageToken;
      } while (pagina && out.length < 500);
      return out;
    },
    async baixar(token, arquivo) {
      const meta = await chamar(f, `${BASE}/files/${id(arquivo)}?fields=id,name,mimeType,size`, { headers: auth(token) });
      if (!meta.ok) await falha(meta);
      const m = (await meta.json()) as ArquivoDrive;
      if (m.mimeType.startsWith("application/vnd.google-apps.")) throw new ErroGoogle("outro", "Arquivo nativo do Google não tem download direto.");
      const res = await chamar(f, `${BASE}/files/${id(arquivo)}?alt=media`, { headers: auth(token) });
      if (!res.ok) await falha(res);
      if (!res.body) throw new ErroGoogle("outro", "O Google Drive não devolveu o conteúdo.");
      return { nome: m.name, mime: m.mimeType, tamanho: m.size ? Number(m.size) : null, corpo: res.body };
    },
    async enviar(token, paiId, nome, mime, dados) {
      // Envio retomável: 1) abre a sessão com os dados do arquivo, 2) manda os bytes. Funciona para qualquer tamanho.
      const abre = await chamar(f, `${ENVIO}?uploadType=resumable&fields=${CAMPOS_ARQUIVO}`, {
        method: "POST",
        headers: auth(token, { ...json, "x-upload-content-type": mime, "x-upload-content-length": String(dados.byteLength) }),
        body: JSON.stringify({ name: nome, parents: [paiId], mimeType: mime }),
      });
      if (!abre.ok) await falha(abre);
      const local = abre.headers.get("location");
      if (!local) throw new ErroGoogle("outro", "O Google Drive não devolveu o endereço de envio.");
      const res = await chamar(f, local, { method: "PUT", headers: auth(token, { "content-type": mime }), body: dados as unknown as BodyInit });
      if (!res.ok) await falha(res);
      return (await res.json()) as ArquivoDrive;
    },
  };
}

/** Só aceita links que são mesmo do Google (o link vem do Drive, mas nunca vai para o `href` sem conferir). */
export function linkDoDriveSeguro(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "drive.google.com" || u.hostname === "docs.google.com") ? u.toString() : null;
  } catch {
    return null;
  }
}

export const linkDaPasta = (driveId: string) => `https://drive.google.com/drive/folders/${encodeURIComponent(driveId)}`;
