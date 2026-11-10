/**
 * Fila de requisições por fonte: uma chamada por vez, intervalo mínimo entre chamadas,
 * nova tentativa com espera crescente (backoff exponencial) em 429, 5xx e falha de rede.
 */
export class ErroFonte extends Error {
  constructor(
    public readonly fonte: string,
    public readonly codigo: "limite" | "indisponivel" | "bloqueado" | "chave_recusada" | "resposta_invalida" | "rede" | "outro",
    mensagem: string,
    public readonly status?: number,
  ) {
    super(mensagem);
    this.name = "ErroFonte";
  }
}

export type OpcoesFila = {
  fonte: string;
  intervaloMinimoMs: number;
  maxTentativas: number;
  backoffBaseMs: number;
  /** Espera mínima depois de HTTP 429 (o DJEN pede 1 minuto). */
  esperaApos429Ms: number;
  timeoutMs: number;
  dormir?: (ms: number) => Promise<void>;
  agora?: () => number;
  aleatorio?: () => number;
};

const dormirPadrao = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FilaRequisicoes {
  private cauda: Promise<unknown> = Promise.resolve();
  private ultimaChamada = Number.NEGATIVE_INFINITY;
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly agora: () => number;
  private readonly aleatorio: () => number;

  constructor(private readonly op: OpcoesFila) {
    this.dormir = op.dormir ?? dormirPadrao;
    this.agora = op.agora ?? Date.now;
    this.aleatorio = op.aleatorio ?? Math.random;
  }

  /** Enfileira uma chamada HTTP. Devolve a resposta OK (2xx) ou lança ErroFonte. */
  executar(chamada: (sinal: AbortSignal) => Promise<Response>): Promise<Response> {
    const tarefa = this.cauda.then(() => this.tentar(chamada));
    this.cauda = tarefa.catch(() => undefined);
    return tarefa;
  }

  private async tentar(chamada: (sinal: AbortSignal) => Promise<Response>): Promise<Response> {
    let ultimoErro: ErroFonte | null = null;
    for (let tentativa = 0; tentativa < this.op.maxTentativas; tentativa++) {
      const falta = this.ultimaChamada + this.op.intervaloMinimoMs - this.agora();
      if (falta > 0) await this.dormir(falta);
      this.ultimaChamada = this.agora();

      const controle = new AbortController();
      const timer = setTimeout(() => controle.abort(), this.op.timeoutMs);
      let resp: Response | null = null;
      try {
        resp = await chamada(controle.signal);
      } catch {
        ultimoErro = new ErroFonte(this.op.fonte, "rede", `Sem resposta de ${this.op.fonte}.`);
      } finally {
        clearTimeout(timer);
      }

      if (resp) {
        if (resp.ok) return resp;
        if (resp.status === 401 || resp.status === 403) {
          // Não adianta repetir: chave recusada ou acesso bloqueado (ex.: DJEN fora do Brasil).
          const codigo = resp.status === 401 ? "chave_recusada" : "bloqueado";
          throw new ErroFonte(this.op.fonte, codigo, `${this.op.fonte} recusou o acesso (HTTP ${resp.status}).`, resp.status);
        }
        if (resp.status !== 429 && resp.status < 500) {
          throw new ErroFonte(this.op.fonte, "outro", `${this.op.fonte} respondeu HTTP ${resp.status}.`, resp.status);
        }
        ultimoErro = new ErroFonte(
          this.op.fonte,
          resp.status === 429 ? "limite" : "indisponivel",
          resp.status === 429 ? `${this.op.fonte} pediu para esperar (limite de requisições).` : `${this.op.fonte} está instável (HTTP ${resp.status}).`,
          resp.status,
        );
      }

      if (tentativa === this.op.maxTentativas - 1) break;
      let espera = this.op.backoffBaseMs * 2 ** tentativa * (0.75 + this.aleatorio() * 0.5);
      if (resp?.status === 429) {
        const retryAfter = Number(resp.headers.get("retry-after"));
        espera = Math.max(espera, this.op.esperaApos429Ms, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0);
      }
      await this.dormir(espera);
    }
    throw ultimoErro ?? new ErroFonte(this.op.fonte, "outro", `Falha ao consultar ${this.op.fonte}.`);
  }
}

/** Lê JSON da resposta; corpo que não é JSON vira ErroFonte (ex.: página HTML de bloqueio). */
export async function lerJson<T>(fonte: string, resp: Response): Promise<T> {
  const texto = await resp.text();
  try {
    return JSON.parse(texto) as T;
  } catch {
    throw new ErroFonte(fonte, "resposta_invalida", `${fonte} devolveu uma resposta que não é JSON.`, resp.status);
  }
}
