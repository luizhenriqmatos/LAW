import { ErroGoogle } from "@/lib/integrations/google/erro";
import { MIME_PASTA, type ArquivoBaixado, type ArquivoDrive, type GoogleDriveApi } from "@/lib/integrations/google/drive-api";

type No = { id: string; name: string; mimeType: string; parents: string[]; trashed: boolean; marca?: string; size?: number; dono: string; dados?: Uint8Array };

/**
 * Google Drive de mentira, em memória, com as regras que importam: cada "conta" (refresh token, ex.: "ana") só enxerga o que
 * ela mesma criou (como o escopo drive.file); pasta apagada responde 404; token recusado responde 401.
 * NÃO existe método de apagar: o LAW nunca apaga nada no Drive, e o teste prova isso (`chamadas` não tem nenhum "apagar").
 */
export class DriveFalso implements GoogleDriveApi {
  nos = new Map<string, No>();
  chamadas: string[] = [];
  tokensRecusados = new Set<string>();
  refreshRevogados = new Set<string>();
  falhaTemporaria: "limite" | "indisponivel" | null = null;
  private n = 0;

  private dono(token: string) {
    return token.replace(/^acc-/, "").replace(/-\d+$/, "");
  }
  private checar(token: string) {
    if (this.tokensRecusados.has(token)) throw new ErroGoogle("nao_autorizado", "401");
    if (this.falhaTemporaria) throw new ErroGoogle(this.falhaTemporaria, this.falhaTemporaria);
  }
  private meu(token: string, id: string): No {
    const no = this.nos.get(id);
    if (!no || no.dono !== this.dono(token)) throw new ErroGoogle("nao_encontrado", "404");
    return no;
  }

  renovar = async (refresh: string) => {
    this.chamadas.push(`renovar:${refresh}`);
    if (this.refreshRevogados.has(refresh)) throw new ErroGoogle("revogado", "invalid_grant");
    return { accessToken: `acc-${refresh}-${++this.n}`, expiraEm: new Date(Date.now() + 3600_000) };
  };

  async buscarPorMarca(token: string, marca: string) {
    this.checar(token);
    const a = [...this.nos.values()].find((x) => x.marca === marca && !x.trashed && x.dono === this.dono(token));
    return a ? { id: a.id, name: a.name, parents: a.parents } : null;
  }
  async criarPasta(token: string, nome: string, paiId: string | null, marca: string) {
    this.checar(token);
    if (paiId) this.meu(token, paiId);
    const id = `pasta-${++this.n}`;
    this.nos.set(id, { id, name: nome, mimeType: MIME_PASTA, parents: paiId ? [paiId] : [], trashed: false, marca, dono: this.dono(token) });
    this.chamadas.push(`criarPasta:${nome}`);
    return { id };
  }
  async obterPasta(token: string, id: string) {
    this.checar(token);
    const no = this.nos.get(id);
    return no && no.dono === this.dono(token) ? { id, name: no.name, trashed: no.trashed, parents: no.parents } : null;
  }
  async renomear(token: string, id: string, nome: string) {
    this.checar(token);
    const no = this.meu(token, id);
    if (no.trashed) throw new ErroGoogle("nao_encontrado", "404");
    this.chamadas.push(`renomear:${nome}`);
    no.name = nome;
  }
  async mover(token: string, id: string, novoPai: string, antigoPai: string) {
    this.checar(token);
    const no = this.meu(token, id);
    this.meu(token, novoPai);
    this.chamadas.push(`mover:${no.name}`);
    no.parents = [...no.parents.filter((p) => p !== antigoPai), novoPai];
  }
  async listar(token: string, paiId: string): Promise<ArquivoDrive[]> {
    this.checar(token);
    this.meu(token, paiId);
    return [...this.nos.values()]
      .filter((x) => x.parents.includes(paiId) && !x.trashed && x.dono === this.dono(token))
      .map((x) => ({ id: x.id, name: x.name, mimeType: x.mimeType, size: x.size === undefined ? undefined : String(x.size), webViewLink: `https://drive.google.com/file/d/${x.id}/view` }));
  }
  async enviar(token: string, paiId: string, nome: string, mime: string, dados: Uint8Array): Promise<ArquivoDrive> {
    this.checar(token);
    const pai = this.meu(token, paiId);
    if (pai.trashed) throw new ErroGoogle("nao_encontrado", "404");
    const id = `arq-${++this.n}`;
    this.nos.set(id, { id, name: nome, mimeType: mime, parents: [paiId], trashed: false, size: dados.byteLength, dono: this.dono(token), dados });
    this.chamadas.push(`enviar:${nome}`);
    return { id, name: nome, mimeType: mime, size: String(dados.byteLength), webViewLink: `https://drive.google.com/file/d/${id}/view` };
  }

  async baixar(token: string, id: string): Promise<ArquivoBaixado> {
    this.checar(token);
    const no = this.meu(token, id);
    if (no.trashed || no.mimeType === MIME_PASTA) throw new ErroGoogle("nao_encontrado", "404");
    this.chamadas.push(`baixar:${no.name}`);
    const bytes = no.dados ?? new Uint8Array();
    return {
      nome: no.name,
      mime: no.mimeType,
      tamanho: no.size ?? bytes.byteLength,
      corpo: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
    };
  }

  /** Simula alguém do escritório apagando/lixeira a pasta direto no Drive. */
  apagarPorFora(id: string) {
    this.nos.delete(id);
  }
  caminho(id: string): string {
    const no = this.nos.get(id);
    if (!no) return "";
    const pai = no.parents[0];
    return pai && this.nos.has(pai) ? `${this.caminho(pai)}/${no.name}` : no.name;
  }
  caminhos(): string[] {
    return [...this.nos.values()].filter((x) => x.mimeType === MIME_PASTA && !x.trashed).map((x) => this.caminho(x.id)).sort();
  }
}
