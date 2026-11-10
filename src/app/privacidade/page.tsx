import type { Metadata } from "next";
import { PaginaLegal, type Secao } from "@/components/pagina-legal";

export const metadata: Metadata = { title: "Política de privacidade — LAW", robots: { index: false } };

// RASCUNHO: texto próprio, escrito para o LAW (Lei 13.709/2018). Pontos entre [colchetes] dependem do advogado ou do negócio.
const SECOES: Secao[] = [
  {
    titulo: "Quem é quem",
    paragrafos: [
      "Esta política explica como o LAW trata dados pessoais, nos termos da Lei Geral de Proteção de Dados (LGPD).",
      "Há duas situações. (a) Dados do escritório e de quem usa o LAW (nome, e-mail, acesso, cobrança, segurança): aqui o LAW é o controlador, ou seja, decide como e para que tratar. (b) Dados dos clientes, partes e processos do escritório, que o escritório coloca no LAW: aqui o escritório é o controlador e o LAW é o operador, tratando os dados em nome do escritório e seguindo as suas instruções.",
      "Como controlador dos dados dos seus clientes, o escritório responde pela base legal, por informar os seus clientes e por atender os pedidos deles. O LAW ajuda com as ferramentas de exportação e exclusão.",
    ],
  },
  {
    titulo: "Dados que tratamos",
    itens: [
      "Conta e acesso: nome, e-mail, escritório, papel e permissões, registros de acesso e de ações (auditoria).",
      "Dados do escritório: processos, partes, publicações e prazos, clientes (nome, CPF/CNPJ, contatos), tarefas, agenda, lançamentos financeiros, documentos e minutas.",
      "Assinatura eletrônica: nome, e-mail, CPF, endereço de IP, navegador, data e hora e o aceite de cada signatário, mais o documento.",
      "Atendimento por WhatsApp: número de telefone, nome de perfil e o conteúdo das mensagens trocadas com o escritório.",
      "Assistente de IA: o que você escreve para ela e os dados do escritório de que ela precisa para responder, dentro das permissões da pessoa que a usa.",
      "Dados técnicos: endereço de IP, tipo de navegador e erros, para segurança e funcionamento.",
    ],
    paragrafos: ["Podem constar nos processos dados sensíveis e informações sob segredo de justiça. Elas recebem o mesmo cuidado e ficam sujeitas ao sigilo configurado pelo escritório."],
  },
  {
    titulo: "Para que usamos",
    itens: [
      "Prestar o serviço contratado: organizar processos, prazos, clientes e documentos, enviar avisos e convites, coletar assinaturas.",
      "Manter a segurança, prevenir fraude e registrar quem fez o quê.",
      "Cumprir obrigações legais, como a guarda de documentos assinados.",
      "Cobrar, dar suporte e melhorar o serviço.",
    ],
    paragrafos: ["Não vendemos dados pessoais e não os usamos para publicidade. [REVISAR: base legal de cada finalidade (art. 7º e 11 da LGPD) e se há uso de dados para treinamento de modelos, que hoje não existe.]"],
  },
  {
    titulo: "Quem recebe os dados (provedores)",
    paragrafos: ["Para funcionar, o LAW usa empresas que tratam dados em nosso nome. Elas recebem só o necessário para a sua função:"],
    itens: [
      "Supabase: banco de dados e autenticação (guarda os dados do escritório).",
      "Vercel: hospedagem e execução do aplicativo.",
      "Google: Agenda e Drive, apenas se o escritório conectar a conta; usados para sincronizar compromissos e pastas de documentos.",
      "Anthropic: modelos de IA que movem a assistente e a classificação de mensagens; recebem o texto necessário para cada resposta.",
      "Resend: envio de e-mails (convites, avisos, links de assinatura e do portal).",
      "Meta (WhatsApp): recebimento e envio de mensagens do atendimento, se o escritório ativar.",
    ],
  },
  {
    titulo: "Transferência para fora do Brasil",
    paragrafos: ["Alguns desses provedores podem tratar dados fora do Brasil. Quando isso ocorre, buscamos contratos e garantias que atendam a LGPD (art. 33). [REVISAR: regiões de cada provedor, cláusulas contratuais e eventual base para transferência.]"],
  },
  {
    titulo: "Por quanto tempo guardamos",
    itens: [
      "Enquanto a conta estiver ativa, mantemos os dados do escritório.",
      "No encerramento: 30 dias somente para leitura e exportação; depois os dados do escritório são apagados.",
      "Documentos assinados e suas evidências: 5 anos, para que continuem verificáveis, mesmo depois do encerramento.",
      "Registros mínimos da exclusão (nome do escritório, datas) e backups: [DEFINIR prazo].",
    ],
  },
  {
    titulo: "Segurança",
    paragrafos: ["Isolamos os dados de cada escritório no banco, limitamos o acesso por permissão, guardamos o histórico de ações, protegemos tokens e senhas com cifra ou hash e usamos conexão segura. Nenhum sistema é totalmente imune; se houver incidente que traga risco relevante, comunicaremos os afetados e a ANPD, como a lei exige."],
  },
  {
    titulo: "Seus direitos",
    paragrafos: ["Você pode pedir confirmação de que tratamos seus dados, acesso, correção, anonimização, eliminação, portabilidade, informação sobre com quem compartilhamos e revisão de decisões automatizadas, e pode se opor ou revogar consentimento quando for o caso (art. 18 da LGPD)."],
    itens: [
      "Se você é usuário do LAW, fale conosco.",
      "Se você é cliente ou parte de um escritório que usa o LAW, fale primeiro com o escritório, que é o controlador. Nós ajudamos o escritório a atender.",
      "O dono pode baixar todos os dados do escritório a qualquer momento em Conta > Baixar tudo.",
    ],
  },
  {
    titulo: "Contato e encarregado",
    paragrafos: ["[DEFINIR: razão social, CNPJ, endereço, nome e e-mail do encarregado de proteção de dados (DPO).]", "Reclamações também podem ser feitas à Autoridade Nacional de Proteção de Dados (ANPD)."],
  },
  {
    titulo: "Mudanças nesta política",
    paragrafos: ["Podemos atualizar este texto. Mudanças relevantes serão avisadas por e-mail ou no aplicativo."],
  },
];

export default function Privacidade() {
  return <PaginaLegal titulo="Política de privacidade" vigencia="Rascunho de novembro de 2026. Ainda não está em vigor." secoes={SECOES} />;
}
