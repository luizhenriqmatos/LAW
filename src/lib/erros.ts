/** Traduz erros do banco/Supabase para mensagens simples. Nunca mostra detalhe técnico ao usuário. */
const MENSAGENS: Record<string, string> = {
  sem_permissao: "Você não tem permissão para fazer isso.",
  nao_autenticado: "Sua sessão expirou. Entre de novo.",
  convite_invalido: "Este convite não existe ou foi cancelado.",
  convite_usado: "Este convite já foi usado.",
  convite_vencido: "Este convite venceu. Peça um novo ao responsável pelo escritório.",
  convite_outro_email: "Este convite foi enviado para outro e-mail. Entre com o e-mail convidado.",
  ja_e_membro: "Essa pessoa já faz parte do escritório.",
  modulo_invalido: "Módulo inválido.",
  modo_invalido: "Modo de monitoramento inválido.",
  alvos_vazios: "Informe pelo menos uma OAB, CNPJ ou nome.",
  conta_somente_leitura: "Esta conta está em encerramento e só permite leitura e exportação.",
  ja_em_encerramento: "O encerramento desta conta já foi pedido.",
  sem_encerramento: "Esta conta não está em encerramento.",
  fora_do_prazo: "Ainda não passaram os 30 dias do encerramento.",
  campo_imutavel: "Esse dado não pode ser alterado.",
  // Triagem (Prompt 3)
  nao_encontrado: "Esse item não foi encontrado. Ele pode ter sido tratado por outra pessoa.",
  nao_provisorio: "Esse item já foi tratado (não está mais provisório).",
  nao_descartado: "Esse item não está na lixeira.",
  prazo_restauracao_vencido: "Passaram mais de 30 dias do descarte. Não dá mais para restaurar.",
  documento_invalido: "CPF ou CNPJ inválido. Confira os números.",
  documento_duplicado: "Já existe um cliente confirmado com esse CPF/CNPJ. Use \"Mesclar\" para juntar os dois.",
  destino_invalido: "Só dá para mesclar com um cliente já confirmado.",
  nome_invalido: "Informe o nome do cliente.",
  processo_descartado: "Esse processo foi descartado. Restaure-o antes de ligar publicações a ele.",
  publicacao_ja_tratada: "Essa publicação já foi ligada ou descartada.",
  vinculo_provisorio: "Processo ou cliente provisório não entra no financeiro. Confirme-o na triagem primeiro.",
  prazo_mudou: "O cálculo mudou desde que você conferiu (o calendário foi alterado). Confira a nova data e confirme de novo.",
  processo_nao_confirmado: "Só dá para criar prazo em processo confirmado. Confirme o processo na triagem primeiro.",
  responsavel_invalido: "Escolha um responsável que tenha acesso aos Prazos.",
  publicacao_invalida: "Essa publicação não pertence a este processo.",
  raciocinio_invalido: "Não foi possível registrar o cálculo. Tente de novo.",
  status_invalido: "Situação inválida para o prazo.",
  escopo_invalido: "Feriados nacionais são mantidos pelo LAW. Cadastre estadual, municipal ou do tribunal.",
  nada_selecionado: "Marque pelo menos um item.",
  // Tarefas, agenda e Google (Prompt 5)
  coluna_invalida: "Essa coluna não existe mais. Atualize a página.",
  limite_colunas: "O quadro aceita até 12 colunas.",
  coluna_com_tarefas: "Mova ou apague as tarefas dessa coluna antes de removê-la.",
  ultima_coluna: "O quadro precisa ter pelo menos uma coluna.",
  tarefa_invalida: "Essa tarefa não existe mais. Ela pode ter sido apagada por outra pessoa.",
  cliente_nao_confirmado: "Só dá para ligar cliente confirmado. Confirme o cliente na triagem primeiro.",
  compromisso_invalido: "Esse compromisso não existe mais.",
  periodo_invalido: "Período inválido.",
  dados_invalidos: "Confira os campos e tente de novo.",
  google_nao_configurado: "A conexão com o Google ainda não foi ativada neste LAW. Avise o responsável pelo sistema.",
  google_estado: "A conexão com o Google expirou ou foi interrompida. Tente conectar de novo.",
  google_negado: "Você não autorizou o acesso. Nada foi conectado.",
  google_sem_refresh: "O Google não liberou o uso contínuo. Tente conectar de novo e aceite todas as permissões.",
  google_falha: "Não foi possível conectar ao Google agora. Tente de novo em alguns minutos.",
  // Financeiro (Prompt 7)
  tipo_invalido: "Escolha se é receita ou despesa.",
  categoria_invalida: "Escolha a categoria.",
  descricao_invalida: "Descreva o lançamento (de 2 a 200 letras).",
  valor_invalido: "Valor inválido. Use um valor maior que zero, por exemplo 1.500,00.",
  parcelas_invalidas: "O número de parcelas vai de 1 a 120.",
  parcelas_demais: "O valor é pequeno demais para tantas parcelas (cada uma precisa de pelo menos 1 centavo).",
  vencimento_invalido: "Informe a data do primeiro vencimento.",
  cliente_obrigatorio: "Receita precisa de um cliente. Escolha o cliente.",
  pagamento_excede: "O pagamento passa do que falta nessa parcela.",
  data_futura: "A data do pagamento não pode ser no futuro.",
  forma_invalida: "Forma de pagamento inválida.",
  parcela_cancelada: "Essa parcela está cancelada.",
  parcela_com_pagamento: "Essa parcela já tem pagamento. Estorne o pagamento antes de cancelar.",
  lancamento_com_pagamento: "Esse lançamento já tem pagamento. Estorne os pagamentos antes de cancelar.",
  parcela_encerrada: "Parcela paga ou cancelada não muda de vencimento.",
  ja_estornado: "Esse pagamento já foi estornado.",
  ja_cancelado: "Esse lançamento já está cancelado.",
  lancamento_com_parcelas: "O valor de um lançamento parcelado não muda. Cancele e lance de novo.",
  // Documentos / Google Drive (Prompt 6)
  drive_desconectado: "O Google Drive do escritório não está conectado. O dono precisa conectar em Documentos.",
  drive_pasta_sumiu: "A pasta não foi encontrada no Drive. Ela pode ter sido apagada ou movida lá; o LAW recria em instantes.",
  drive_indisponivel: "O Google Drive não respondeu agora. Tente de novo em alguns minutos.",
  arquivo_grande: "O arquivo passa de 4 MB. Para arquivos maiores, use “Abrir pasta no Drive” e envie por lá.",
  arquivo_vazio: "Escolha um arquivo para enviar.",
  drive_sem_pasta: "Ainda não existe pasta no Drive para este item. Ela é criada quando o cliente/processo está confirmado e o Drive está conectado.",
  erro_drive: "Não foi possível falar com o Google Drive agora. Tente de novo.",
  drive_nao_configurado: "A conexão com o Google Drive ainda não foi ativada neste LAW. Avise o responsável pelo sistema.",
  "Invalid login credentials": "E-mail ou senha incorretos.",
  "Email not confirmed": "Confirme seu e-mail pelo link que enviamos antes de entrar.",
  "User already registered": "Este e-mail já tem conta. Entre ou use o link de acesso.",
  "Email link is invalid or has expired": "Este link venceu ou já foi usado. Peça um novo.",
  "Password should be": "Senha fraca. Use pelo menos 8 caracteres.",
  "Signups not allowed": "O cadastro de novas contas está fechado no momento.",
  "address not authorized": "Não conseguimos enviar e-mail para este endereço agora. Tente outro e-mail ou avise o suporte.",
  "Email address": "Este e-mail não foi aceito. Confira se digitou certo.",
  "Error sending": "Não conseguimos enviar o e-mail agora. Tente de novo em alguns minutos.",
  "For security purposes": "Aguarde um minuto antes de pedir outro e-mail.",
  // Cálculos (Prompt 8)
  processo_invalido: "Escolha um processo confirmado deste escritório.",
  regime_invalido: "Regime inválido ou de outro escritório. Confira os campos do regime.",
  regime_imutavel: "Um regime nunca é alterado. Crie uma nova versão.",
  regime_do_sistema: "Os regimes padrão do LAW não podem ser alterados. Crie um regime personalizado.",
  regime_desatualizado: "Já existe uma versão mais nova deste regime. Abra a versão atual.",
  selic_com_indice: "A Selic já engloba correção e juros: escolha \"sem correção\" nesse regime (Lei 14.905/2024).",
  regime_sem_nome: "Dê um nome ao regime (3 a 120 letras).",
  fundamento_obrigatorio: "Informe o fundamento legal ou a decisão que fixa o critério.",
  vigencia_invalida: "O fim da vigência não pode ser antes do início.",
  juros_valor_invalido: "Informe a taxa de juros (maior que zero e até 100%).",
  servico_nao_configurado: "A chave de serviço do Supabase ainda não foi configurada (PENDENCIA P-015).",
  // Portal do cliente (Prompt 9)
  segredo_de_justica: "Processo em segredo de justiça nunca aparece no portal do cliente. Nada foi liberado.",
  cliente_sem_email: "Este cliente não tem e-mail cadastrado. Cadastre o e-mail do cliente antes.",
  cliente_fora_do_processo: "Este cliente não é parte deste processo.",
  liberacao_invalida: "Essa liberação não existe mais.",
  sem_processo_liberado: "Libere pelo menos um processo para este cliente antes de enviar o acesso.",
  limite_links: "Já foram enviados 5 links para este e-mail na última hora. Aguarde um pouco.",
  resumo_invalido: "O resumo não pôde ser salvo. Ele precisa ter texto e terminar com \"Dúvidas? Fale com seu advogado.\".",
  titulo_invalido: "Dê um título ao documento (pelo menos 3 letras).",
  assinatura_nao_configurada: "A assinatura eletrônica ainda não está ativa neste LAW (falta a chave do servidor).",
  pdf_invalido: "O arquivo não é um PDF válido (ou tem senha, ou passa de 4 MB). Envie outro PDF.",
  signatarios_invalidos: "Confira os signatários: nome, e-mail válido, sem repetir e até 20 pessoas.",
  envelope_encerrado: "Este envelope já foi concluído ou cancelado e não pode mais mudar.",
  envelope_invalido: "Envelope não encontrado.",
  signatario_invalido: "Signatário não encontrado.",
  fora_da_vez: "Ainda não é a vez dessa pessoa: ela recebe o link quando os signatários anteriores assinarem.",
  ja_assinou: "Essa pessoa já assinou.",
  retencao_5_anos: "Documentos assinados e evidências ficam guardados por 5 anos e não podem ser apagados.",
  // Atendimento por WhatsApp (Prompt 13)
  janela_24h_fechada: "Passaram mais de 24 horas desde a última mensagem da pessoa. Pelas regras do WhatsApp, agora só dá para enviar o modelo aprovado.",
  modelo_nao_configurado: "O modelo de retomada ainda não foi cadastrado. O dono define em Atendimentos > Configurar.",
  sem_conversa_iniciada_pelo_contato: "Só é possível falar com quem escreveu primeiro.",
  atendimento_encerrado: "Este atendimento já foi encerrado.",
  numero_em_uso: "Este número do WhatsApp já está ligado a outro escritório.",
  envio_falhou: "A mensagem foi registrada, mas o WhatsApp não aceitou o envio. Veja o motivo na conversa.",
  // Conexões / MCP (Prompt 12)
  conectores_desligados: "O dono do escritório desligou as conexões com assistentes externos.",
  cliente_invalido: "Este aplicativo não está registrado no LAW.",
  // Assistente Lia (Prompt 11)
  assistente_nao_configurada: "A Lia ainda não foi ativada neste LAW (falta a chave da IA). Avise o responsável pelo sistema.",
  limite_assistente: "Você chegou ao limite de perguntas à Lia por hoje. Amanhã libera de novo.",
  rascunho_encerrado: "Esse rascunho já foi confirmado ou descartado.",
  rascunho_vencido: "Esse rascunho tem mais de 24 horas. Peça de novo à Lia: os dados podem ter mudado.",
  rascunhos_demais: "Há rascunhos demais esperando decisão. Confirme ou descarte os que estão abertos.",
  pergunta_invalida: "Escreva a pergunta (até 4.000 letras).",
  nome_modelo_invalido: "Dê um nome ao modelo (de 2 a 120 letras).",
  texto_modelo_invalido: "O texto do modelo precisa ter de 20 a 50.000 letras.",
  modelo_duplicado: "Já existe um modelo com esse nome.",
  modelo_nao_encontrado: "O modelo não foi encontrado ou está desativado.",
  documento_portal_invalido: "Esse arquivo não está na pasta do processo no Drive, ou já não está compartilhado.",
  ia_nao_configurada: "A IA ainda não foi configurada neste LAW. Escreva o resumo à mão por enquanto.",
  ia_falhou: "A IA não respondeu agora. Tente de novo em alguns minutos ou escreva o resumo à mão.",
  sem_movimentacoes: "Este processo ainda não tem movimentações para resumir.",
  calculo_sem_processo: "Ligue o cálculo a um processo para salvar o PDF na pasta dele.",
};

/** Mensagens da tela de entrada quando o link do e-mail falha (código vai na URL: /entrar?erro=...). */
export const ERROS_DE_LINK: Record<string, string> = {
  expirado: "Este link venceu ou já foi usado. Entre com sua senha ou peça um novo link.",
  navegador:
    "Não deu para entrar direto por este link: ele precisa ser aberto no mesmo navegador em que você pediu. Se era a confirmação do cadastro, seu e-mail já foi confirmado: entre com e-mail e senha.",
  link: "O link não é mais válido. Entre com sua senha ou peça um novo link.",
};

export function mensagemDeErro(erro: unknown): string {
  const texto = erro instanceof Error ? erro.message : typeof erro === "object" && erro && "message" in erro ? String((erro as { message: unknown }).message) : String(erro ?? "");
  for (const [chave, msg] of Object.entries(MENSAGENS)) {
    if (texto.includes(chave)) return msg;
  }
  if (/check constraint/.test(texto)) return "Algum dado não passou na validação. Confira os campos.";
  if (/rate limit/i.test(texto)) return "Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.";
  return "Algo deu errado. Tente de novo em instantes.";
}

/** Código conhecido do erro (para levar na URL sem expor texto técnico). */
export function codigoDeErro(erro: unknown): string {
  const texto = erro instanceof Error ? erro.message : typeof erro === "object" && erro && "message" in erro ? String((erro as { message: unknown }).message) : String(erro ?? "");
  return Object.keys(MENSAGENS).find((k) => /^[a-z_]+$/.test(k) && texto.includes(k)) ?? "falha";
}

/** Só aceita caminho interno (evita redirecionar para outro site). */
export function caminhoSeguro(valor: string | null | undefined, padrao = "/app"): string {
  if (!valor || !valor.startsWith("/") || valor.startsWith("//") || valor.includes("\\")) return padrao;
  return valor;
}
