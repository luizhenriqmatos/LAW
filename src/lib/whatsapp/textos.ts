/**
 * TODAS as frases que a recepcionista pode enviar. Não existe texto gerado por IA nesta conversa:
 * a IA, quando ligada, só escolhe uma categoria (ver recepcionista.ts). Por isso a recepcionista não tem como dar
 * orientação jurídica, opinar sobre o caso, prever resultado, citar dado de processo ou prometer prazo.
 * O único texto "de fora" é o que o próprio escritório escreveu na configuração (prazo e horário), repetido como está.
 */
export const CATEGORIAS = ["novo_caso", "andamento", "financeiro", "agendamento", "outro"] as const;
export type Categoria = (typeof CATEGORIAS)[number];

export const ROTULO_CATEGORIA: Record<Categoria, string> = {
  novo_caso: "Novo caso",
  andamento: "Andamento de processo",
  financeiro: "Financeiro",
  agendamento: "Agendamento",
  outro: "Outro assunto",
};

export const MENU_MOTIVOS = [
  "Qual é o motivo do seu contato? Responda com o número ou escreva com suas palavras:",
  "1 - Quero contratar o escritório (novo caso)",
  "2 - Andamento de processo",
  "3 - Financeiro",
  "4 - Agendamento",
  "5 - Outro assunto",
].join("\n");

export const NUMERO_PARA_CATEGORIA: Record<string, Categoria> = {
  "1": "novo_caso", "2": "andamento", "3": "financeiro", "4": "agendamento", "5": "outro",
};

export function saudacao(escritorio: string): string {
  return `Olá! Aqui é a recepção virtual do ${escritorio}. Eu só faço o primeiro atendimento: anoto o motivo do seu contato e passo para a equipe.`;
}

export const PEDIR_NOME = "Para registrar o atendimento, qual é o seu nome completo?";
export const PEDIR_NOME_DE_NOVO = "Não consegui entender o nome. Pode escrever seu nome completo?";
export const PEDIR_RESUMO = "Em uma frase, o que você precisa? Por segurança, não envie senhas nem dados de cartão por aqui.";
export const SO_TEXTO = "Por aqui eu consigo ler só mensagens de texto. Pode escrever sua mensagem?";

/** Resposta fixa para quem pede opinião ou orientação sobre o caso. */
export const SEM_ORIENTACAO =
  "Entendo a sua dúvida, mas eu não posso orientar nem opinar sobre o caso. Quem pode responder é a equipe do escritório.";

/** Aviso fixo para assunto de processo: a recepcionista nunca informa dado de processo. */
export const SEM_DADO_DE_PROCESSO =
  "Por segurança, a equipe confirma a sua identidade antes de passar qualquer informação de processo.";

export function transferencia(p: { escritorio: string; prazoTexto: string | null; horarioTexto: string | null; categoria: Categoria }): string[] {
  const linhas = [
    `Pronto, anotei tudo e avisei a equipe do ${p.escritorio}. Uma pessoa vai continuar esta conversa por aqui, e a partir de agora eu não respondo mais.`,
  ];
  if (p.categoria === "andamento") linhas.push(SEM_DADO_DE_PROCESSO);
  // Só repete o que o escritório escreveu. Sem texto configurado, nenhuma promessa de prazo.
  if (p.prazoTexto) linhas.push(p.prazoTexto);
  if (p.horarioTexto) linhas.push(p.horarioTexto);
  return [linhas.join("\n")];
}
