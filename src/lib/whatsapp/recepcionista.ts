import { CATEGORIAS, MENU_MOTIVOS, NUMERO_PARA_CATEGORIA, PEDIR_NOME, PEDIR_NOME_DE_NOVO, PEDIR_RESUMO, SEM_ORIENTACAO, SO_TEXTO, saudacao, transferencia, type Categoria } from "./textos";

/**
 * Cérebro da recepcionista: função pura (sem banco, sem rede, sem IA). Dado o estado da conversa e a mensagem,
 * devolve o novo estado e as frases fixas a enviar. Fica fácil provar que nunca sai nada além de textos.ts.
 */
export type EstadoConversa = "novo" | "aguardando_motivo" | "aguardando_nome" | "aguardando_resumo" | "humano" | "encerrada";

export type Conversa = {
  estado: EstadoConversa;
  categoria: Categoria | null;
  nome: string | null;
  resumo: string | null;
  tentativas: number;
  /** Já sabemos quem é (cliente cadastrado pelo telefone): não perguntamos o nome. */
  identificado: boolean;
};

export type Entrada = { tipo: "texto" | "outro"; texto: string | null };
export type ConfigRecepcao = { escritorio: string; prazoTexto: string | null; horarioTexto: string | null };

export type Decisao = {
  estado: EstadoConversa;
  categoria: Categoria | null;
  nome: string | null;
  resumo: string | null;
  tentativas: number;
  respostas: string[];
  transferir: boolean;
};

const MAX_TENTATIVAS = 2;

export function normalizar(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Tira caracteres de controle e limita o tamanho. */
export function limpar(t: string, max = 500): string {
  return t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Classificação do motivo (palavras-chave, determinística)
// ---------------------------------------------------------------------------
const PALAVRAS: Record<Exclude<Categoria, "outro">, string[]> = {
  agendamento: ["agendar", "agendamento", "marcar", "remarcar", "desmarcar", "reuniao", "horario", "consulta", "visita"],
  financeiro: ["honorario", "boleto", "pagamento", "pagar", "parcela", "fatura", "nota fiscal", "recibo", "cobranca", "segunda via", "2a via", "valor", "pix"],
  andamento: ["andamento", "processo", "movimentacao", "sentenca", "audiencia", "decisao", "numero do processo", "como esta meu", "meu caso", "atualizacao"],
  novo_caso: ["novo caso", "contratar", "contratacao", "preciso de um advogado", "quero um advogado", "procuro advogado", "procuro um advogado", "abrir um processo", "entrar com acao", "quero processar", "fui demitid", "divorcio", "inventario"],
};
const PRIORIDADE: Exclude<Categoria, "outro">[] = ["agendamento", "financeiro", "andamento", "novo_caso"];

export function classificarPorPalavras(texto: string): Categoria {
  const t = normalizar(texto);
  let melhor: Categoria = "outro";
  let pontos = 0;
  for (const cat of PRIORIDADE) {
    const n = PALAVRAS[cat].filter((p) => t.includes(p)).length;
    if (n > pontos) { melhor = cat; pontos = n; }
  }
  return melhor;
}

/** Resposta da IA vira categoria só se for EXATAMENTE uma das cinco; qualquer outra coisa vira "outro". */
export function categoriaDaResposta(resposta: string): Categoria {
  const r = normalizar(resposta).replace(/[^a-z_]/g, "");
  return (CATEGORIAS as readonly string[]).includes(r) ? (r as Categoria) : "outro";
}

// ---------------------------------------------------------------------------
// Pedido de opinião / orientação jurídica
// ---------------------------------------------------------------------------
const PEDE_ORIENTACAO = [
  "tenho direito", "vou ganhar", "vou perder", "chance de", "chances de", "posso processar", "posso ser preso", "o que devo fazer",
  "o que eu faco", "o que fazer", "qual a pena", "e crime", "e legal", "vale a pena", "quanto vou receber", "devo assinar",
  "o que voce acha", "qual sua opiniao", "me orienta", "me oriente", "preciso pagar", "sou obrigad", "posso ser demitid",
];

export function pedeOrientacao(texto: string): boolean {
  const t = normalizar(texto);
  return PEDE_ORIENTACAO.some((p) => t.includes(p));
}

// ---------------------------------------------------------------------------
// Nome e resumo
// ---------------------------------------------------------------------------
export function nomeValido(texto: string): string | null {
  const n = limpar(texto, 120);
  if (n.length < 3 || n.length > 80) return null;
  if (/\d|@|https?:/i.test(n)) return null;
  if (!/^[\p{L}][\p{L}'’.\- ]+$/u.test(n)) return null;
  if (n.split(" ").length > 8) return null;
  return n;
}

/** Resposta só com o número do menu (ou "1.", "2 -"). */
export function numeroDoMenu(texto: string): Categoria | null {
  const m = /^\s*([1-5])\s*[.)\-–]?\s*$/.exec(texto);
  return m ? NUMERO_PARA_CATEGORIA[m[1]] : null;
}

function palavras(t: string): number {
  return t.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Decisão
// ---------------------------------------------------------------------------
/**
 * @param categoriaIa categoria escolhida pela IA para este texto (opcional). Só vale se as palavras-chave não acharam nada.
 */
export function decidir(conv: Conversa, entrada: Entrada, cfg: ConfigRecepcao, categoriaIa: Categoria | null = null): Decisao {
  const base: Decisao = {
    estado: conv.estado, categoria: conv.categoria, nome: conv.nome, resumo: conv.resumo,
    tentativas: conv.tentativas, respostas: [], transferir: false,
  };
  // Com humano (ou conversa encerrada) a recepcionista não fala.
  if (conv.estado === "humano" || conv.estado === "encerrada") return base;

  const texto = entrada.tipo === "texto" && entrada.texto ? limpar(entrada.texto, 1000) : "";
  const primeiraVez = conv.estado === "novo";
  const respostas: string[] = [];
  if (primeiraVez) respostas.push(saudacao(cfg.escritorio));

  // Mídia, áudio, figurinha, localização...
  if (!texto) {
    const tentativas = conv.tentativas + 1;
    if (tentativas > MAX_TENTATIVAS) return passar({ ...base, tentativas }, cfg, respostas);
    respostas.push(SO_TEXTO);
    if (primeiraVez) respostas.push(MENU_MOTIVOS);
    return { ...base, estado: primeiraVez ? "aguardando_motivo" : conv.estado, tentativas, respostas };
  }

  if (pedeOrientacao(texto)) respostas.push(SEM_ORIENTACAO);

  let d: Decisao = { ...base, respostas };
  const estado = conv.estado;

  if (estado === "novo" || estado === "aguardando_motivo") {
    const porNumero = numeroDoMenu(texto);
    const porPalavra = classificarPorPalavras(texto);
    const categoria = porNumero ?? (porPalavra !== "outro" ? porPalavra : categoriaIa ?? "outro");
    const reconhecida = porNumero !== null || porPalavra !== "outro" || categoriaIa !== null;
    if (estado === "novo" && !reconhecida && palavras(texto) < 4) {
      // Primeira mensagem tipo "oi": só cumprimenta e mostra as opções.
      return { ...d, estado: "aguardando_motivo", respostas: [...d.respostas, MENU_MOTIVOS] };
    }
    d = { ...d, categoria, resumo: porNumero ? null : limpar(texto, 500) };
  } else if (estado === "aguardando_nome") {
    const nome = nomeValido(texto);
    if (!nome) {
      const tentativas = conv.tentativas + 1;
      if (tentativas > MAX_TENTATIVAS) d = { ...d, tentativas }; // segue sem nome
      else return { ...d, tentativas, respostas: [...d.respostas, PEDIR_NOME_DE_NOVO] };
    } else {
      d = { ...d, nome, tentativas: 0 };
    }
  } else if (estado === "aguardando_resumo") {
    d = { ...d, resumo: limpar(texto, 500) };
  }

  return proximoPasso(d, conv, cfg);
}

/** Pergunta o que ainda falta; quando não falta nada, passa para humano. */
function proximoPasso(d: Decisao, conv: Conversa, cfg: ConfigRecepcao): Decisao {
  const jaPerguntouNome = conv.estado === "aguardando_nome";
  if (!conv.identificado && !d.nome && !jaPerguntouNome) {
    return { ...d, estado: "aguardando_nome", respostas: [...d.respostas, PEDIR_NOME] };
  }
  const jaPerguntouResumo = conv.estado === "aguardando_resumo";
  if (!d.resumo && !jaPerguntouResumo) {
    return { ...d, estado: "aguardando_resumo", respostas: [...d.respostas, PEDIR_RESUMO] };
  }
  return passar(d, cfg, d.respostas);
}

function passar(d: Decisao, cfg: ConfigRecepcao, respostas: string[]): Decisao {
  const categoria = d.categoria ?? "outro";
  return {
    ...d, categoria, estado: "humano", transferir: true,
    respostas: [...respostas, ...transferencia({ escritorio: cfg.escritorio, prazoTexto: cfg.prazoTexto, horarioTexto: cfg.horarioTexto, categoria })],
  };
}
