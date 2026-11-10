import type { Metadata } from "next";
import { PaginaLegal, type Secao } from "@/components/pagina-legal";

export const metadata: Metadata = { title: "Termos de uso — LAW", robots: { index: false } };

// RASCUNHO: texto próprio, escrito para o LAW. Pontos entre [colchetes] dependem de decisão do negócio ou do advogado.
const SECOES: Secao[] = [
  {
    titulo: "O que é o LAW",
    paragrafos: [
      "O LAW é um programa de apoio à gestão de escritórios de advocacia: organiza processos, prazos, publicações, clientes, tarefas, agenda, financeiro, documentos e atendimento, e oferece uma assistente de inteligência artificial.",
      "O LAW é uma ferramenta de apoio. Ele não é advogado, não presta serviço jurídico e não substitui o julgamento, a conferência e a responsabilidade profissional de quem o usa.",
    ],
  },
  {
    titulo: "Quem pode usar",
    paragrafos: [
      "O LAW é para profissionais e escritórios de advocacia. Quem cria a conta do escritório (o dono) declara ter poderes para isso, responde pelos membros que convida e define o que cada um pode ver e fazer.",
      "Cada pessoa usa o seu próprio acesso e não o compartilha.",
    ],
  },
  {
    titulo: "Prazos e publicações: conferir sempre nos sistemas oficiais",
    paragrafos: [
      "O LAW lê publicações, sugere datas e calcula prazos com base em regras e calendários que podem conter erros, atrasos ou lacunas, e depende de fontes que não controlamos (tribunais, diários oficiais, serviços de terceiros).",
      "O advogado responsável deve conferir todo prazo, intimação e andamento diretamente nos sistemas oficiais do tribunal antes de agir ou de deixar de agir. A ausência de um aviso no LAW não significa que não há prazo ou intimação. Prazo calculado ou sugerido pelo LAW é uma sugestão a ser confirmada por uma pessoa.",
    ],
  },
  {
    titulo: "Assistente de inteligência artificial",
    paragrafos: [
      "A assistente usa modelos de inteligência artificial e pode errar, inventar ou entender mal. O que ela produz (resumos, minutas, respostas) é rascunho: deve ser lido, conferido e assumido por um advogado. Nenhuma ação importante é feita por ela sem a sua confirmação.",
      "O recebimento automático do WhatsApp, quando ativado pelo escritório, só cumprimenta, classifica o motivo do contato e passa para uma pessoa. Ele não dá orientação jurídica nem informa dados de processo.",
    ],
  },
  {
    titulo: "Assinatura eletrônica",
    paragrafos: [
      "O LAW registra evidências de cada assinatura (quem, quando, de onde, o que foi assinado e a integridade do documento). A escolha do tipo de assinatura adequado a cada documento e a sua aceitação por terceiros ou por um juízo é responsabilidade do escritório. [REVISAR: enquadramento na Lei 14.063/2020 e na MP 2.200-2/2001.]",
      "Os documentos assinados e suas evidências são guardados por 5 anos, mesmo depois do encerramento da conta.",
    ],
  },
  {
    titulo: "Seus dados e conteúdos",
    paragrafos: [
      "Os dados que o escritório coloca no LAW continuam sendo do escritório. O escritório garante que tem o direito de tratá-los e que cumpre o sigilo profissional e a legislação aplicável perante os seus clientes.",
      "Como tratamos dados pessoais está na Política de privacidade.",
    ],
  },
  {
    titulo: "Uso proibido",
    itens: [
      "usar o LAW para algo ilegal ou para prejudicar terceiros;",
      "tentar acessar dados de outro escritório, burlar permissões ou testar a segurança sem autorização por escrito;",
      "copiar, revender ou fazer engenharia reversa do programa;",
      "sobrecarregar o serviço, ou usar robôs para acessá-lo fora das integrações oferecidas.",
    ],
  },
  {
    titulo: "Planos, pagamento e preços",
    paragrafos: ["[DEFINIR: planos, valores, forma e data de cobrança, reajuste, período de teste, cancelamento e reembolso.]"],
  },
  {
    titulo: "Encerramento da conta",
    paragrafos: [
      "O dono pode pedir o encerramento a qualquer momento. A conta fica 30 dias somente para leitura, com exportação completa liberada (planilhas CSV e PDFs), e pode ser reativada nesse período cancelando o pedido.",
      "Passados os 30 dias, os dados do escritório são apagados, exceto os documentos assinados e suas evidências, guardados por 5 anos. Avisamos por e-mail no pedido, 7 dias antes e na exclusão final.",
      "Podemos suspender ou encerrar uma conta que descumpra estes termos, avisando por e-mail, e preservando a exportação dos dados sempre que possível.",
    ],
  },
  {
    titulo: "Disponibilidade e mudanças",
    paragrafos: [
      "Trabalhamos para manter o LAW no ar, mas não prometemos funcionamento ininterrupto ou livre de erros. Podem ocorrer paradas, falhas de serviços de terceiros e mudanças nas fontes oficiais.",
      "Podemos melhorar ou alterar funções. Mudanças relevantes nestes termos serão avisadas com antecedência razoável por e-mail ou dentro do aplicativo.",
    ],
  },
  {
    titulo: "Limite de responsabilidade",
    paragrafos: [
      "Na extensão permitida pela lei, a responsabilidade total do LAW perante o escritório por qualquer dano ligado ao uso do serviço fica limitada ao valor que o escritório efetivamente pagou ao LAW nos 12 meses anteriores ao fato que causou o dano.",
      "O LAW não responde por perda de prazo, de causa ou de cliente decorrente de falta de conferência nos sistemas oficiais, por decisão tomada com base em conteúdo da assistente sem revisão profissional, nem por fatos de terceiros fora do nosso controle. Nada neste item limita responsabilidade que a lei não permita limitar, como em caso de dolo. [REVISAR: validade do limite, inclusive diante do Código de Defesa do Consumidor, se aplicável.]",
    ],
  },
  {
    titulo: "Lei aplicável e contato",
    paragrafos: [
      "Estes termos seguem as leis do Brasil. [DEFINIR: foro, razão social, CNPJ e endereço da empresa que opera o LAW.]",
      "Dúvidas e pedidos: [DEFINIR: e-mail de contato].",
    ],
  },
];

export default function Termos() {
  return <PaginaLegal titulo="Termos de uso" vigencia="Rascunho de novembro de 2026. Ainda não está em vigor." secoes={SECOES} />;
}
