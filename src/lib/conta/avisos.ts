/** Textos dos três e-mails do encerramento. Fixos, sem dado do processo/cliente. */
export type TipoAviso = "pedido" | "sete_dias" | "exclusao";

export type Pendencia = { escritorio_id: string; tipo: TipoAviso; nome: string; ate: string; destinatarios: string[] };

const data = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Bahia", day: "2-digit", month: "long", year: "numeric" });

export function montarAviso(p: Pendencia): { assunto: string; texto: string } {
  const fim = data(p.ate);
  if (p.tipo === "pedido") {
    return {
      assunto: `Encerramento da conta ${p.nome} no LAW: você tem 30 dias`,
      texto: [
        `Recebemos o pedido para encerrar a conta do escritório ${p.nome}.`,
        "",
        `Até ${fim} a conta fica somente para leitura: nada pode ser alterado, mas tudo pode ser consultado e exportado (Conta > Baixar tudo).`,
        `Depois dessa data, os dados do escritório são apagados. Só os documentos assinados e as evidências das assinaturas ficam guardados por 5 anos, por obrigação de guarda.`,
        "",
        "Mudou de ideia? O dono pode cancelar o encerramento em Conta, a qualquer momento antes do prazo.",
        "Se você não pediu isso, entre agora e cancele, e troque a sua senha.",
      ].join("\n"),
    };
  }
  if (p.tipo === "sete_dias") {
    return {
      assunto: `Faltam 7 dias para apagarmos os dados de ${p.nome}`,
      texto: [
        `Os dados do escritório ${p.nome} serão apagados em ${fim}.`,
        "",
        "Baixe agora a exportação completa em Conta > Baixar tudo (um arquivo ZIP com planilhas CSV e os PDFs assinados). Depois do prazo não conseguiremos recuperar nada.",
        "Para manter a conta, cancele o encerramento em Conta.",
      ].join("\n"),
    };
  }
  return {
    assunto: `Os dados de ${p.nome} foram apagados do LAW`,
    texto: [
      `O encerramento da conta do escritório ${p.nome} foi concluído em ${fim}. Os dados foram apagados.`,
      "",
      "Ficaram guardados por 5 anos apenas os documentos assinados eletronicamente e as evidências das assinaturas (quem assinou, quando e de onde), para que continuem verificáveis.",
      "Se precisar de uma cópia deles, responda a este e-mail.",
    ].join("\n"),
  };
}
