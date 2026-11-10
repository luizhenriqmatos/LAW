/**
 * Interface de e-mail do LAW. A regra de negócio só fala com esta interface, nunca com o SDK do provedor.
 * PENDENCIA P-016: RESEND_API_KEY e remetente verificado (EMAIL_REMETENTE). Sem eles, o convite não é enviado
 * e a tela mostra o link para o dono copiar — avisando claramente que o e-mail não saiu.
 */
export type ResultadoEnvio = { enviado: true } | { enviado: false; motivo: string };

export interface ServicoEmail {
  enviarConvite(p: { para: string; escritorio: string; link: string; validade: string }): Promise<ResultadoEnvio>;
  enviarAviso(p: { para: string; assunto: string; texto: string }): Promise<ResultadoEnvio>;
  /** Link de acesso ao portal do cliente: uso único, vale `validadeMinutos`. Nunca é enviado em lote. */
  enviarLinkPortal(p: { para: string; escritorios: string[]; link: string; validadeMinutos: number }): Promise<ResultadoEnvio>;
  enviarLinkAssinatura(p: { para: string; nome: string; escritorio: string; titulo: string; link: string; validadeDias: number }): Promise<ResultadoEnvio>;
}

class EmailNaoConfigurado implements ServicoEmail {
  async enviarConvite(): Promise<ResultadoEnvio> {
    return { enviado: false, motivo: "O envio de e-mails ainda não está configurado." };
  }
  async enviarAviso(): Promise<ResultadoEnvio> {
    return { enviado: false, motivo: "O envio de e-mails ainda não está configurado." };
  }
  async enviarLinkPortal(): Promise<ResultadoEnvio> {
    return { enviado: false, motivo: "O envio de e-mails ainda não está configurado." };
  }
  async enviarLinkAssinatura(): Promise<ResultadoEnvio> {
    return { enviado: false, motivo: "O envio de e-mails ainda não está configurado." };
  }
}

class EmailResend implements ServicoEmail {
  constructor(private chave: string, private remetente: string) {}

  async enviarAviso(p: { para: string; assunto: string; texto: string }): Promise<ResultadoEnvio> {
    return this.enviar(p.para, p.assunto, p.texto);
  }

  async enviarLinkPortal(p: { para: string; escritorios: string[]; link: string; validadeMinutos: number }): Promise<ResultadoEnvio> {
    const de = p.escritorios.length === 1 ? ` de ${p.escritorios[0]}` : "";
    const texto = [
      `Olá! Este é o seu acesso ao portal para acompanhar seus processos${de}.`,
      "",
      `Abra o link abaixo (vale por ${p.validadeMinutos} minutos e só pode ser usado uma vez):`,
      p.link,
      "",
      "Se você não pediu este acesso, ignore este e-mail. Ninguém entra sem abrir o link.",
    ].join("\n");
    return this.enviar(p.para, "Seu acesso ao portal de processos", texto);
  }

  async enviarLinkAssinatura(p: { para: string; nome: string; escritorio: string; titulo: string; link: string; validadeDias: number }): Promise<ResultadoEnvio> {
    const texto = [
      `Olá, ${p.nome}!`,
      "",
      `${p.escritorio} enviou o documento "${p.titulo}" para a sua assinatura eletrônica.`,
      "",
      `Abra o link, leia o documento e assine (vale por ${p.validadeDias} dias e é só seu, não o encaminhe):`,
      p.link,
      "",
      "Esta é uma assinatura eletrônica avançada (Lei 14.063/2020). Você vai informar o seu CPF e o aceite fica registrado com data, hora e endereço IP.",
      "Se você não esperava este documento, ignore este e-mail.",
    ].join("\n");
    return this.enviar(p.para, `Documento para assinar: ${p.titulo}`, texto);
  }

  private async enviar(para: string, assunto: string, texto: string): Promise<ResultadoEnvio> {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.chave}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: this.remetente, to: [para], subject: assunto, text: texto }),
      });
      return r.ok ? { enviado: true } : { enviado: false, motivo: "O provedor de e-mail recusou o envio." };
    } catch {
      return { enviado: false, motivo: "Não foi possível falar com o provedor de e-mail." };
    }
  }

  async enviarConvite(p: { para: string; escritorio: string; link: string; validade: string }): Promise<ResultadoEnvio> {
    const texto = [
      `Você foi convidado para a equipe de ${p.escritorio} no LAW.`,
      "",
      `Para aceitar, abra o link abaixo (válido até ${p.validade}):`,
      p.link,
      "",
      "Se você não esperava este convite, ignore este e-mail.",
    ].join("\n");
    return this.enviar(p.para, `Convite para ${p.escritorio} no LAW`, texto);
  }
}

export function servicoEmail(): ServicoEmail {
  const chave = process.env.RESEND_API_KEY;
  const remetente = process.env.EMAIL_REMETENTE;
  return chave && remetente ? new EmailResend(chave, remetente) : new EmailNaoConfigurado();
}
