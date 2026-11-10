# Projeto LAW

## O que é
LAW é um SaaS de gestão para advogados e escritórios de advocacia no Brasil. O advogado faz o trabalho jurídico; o LAW organiza publicações, processos, prazos, tarefas, finanças, documentos, assinaturas e a comunicação com clientes. O assistente de IA sugere e prepara; quem decide é o advogado.

## Referência de produto
- As funcionalidades replicam FLUXOS e REGRAS DE NEGÓCIO de um produto de mercado. Nunca copie textos, marca, nomes de recursos, layout ou código de terceiros.
- Visual: referências de UI próprias do LAW em /docs/ui-referencias.
- /docs/prototipo/index.html é o protótipo navegável, com dados fictícios. Use como referência de telas e fluxos; não é fonte de regra jurídica nem de modelo de dados.

## Stack
- Next.js (App Router) + TypeScript estrito
- Supabase na região sa-east-1 (São Paulo): Postgres, Auth, Storage, Row Level Security (RLS)
- Vercel, com funções na região gru1 (São Paulo)
- Jobs agendados: Supabase pg_cron ou Vercel Cron, sempre executando em gru1/sa-east-1
- IA: API da Anthropic (Claude)
- E-mail transacional: Resend
- UI: Tailwind + shadcn/ui
- Validação: Zod em toda entrada externa (formulários, APIs, webhooks, respostas de provedores)

## Fontes oficiais
- Intimações: DJEN, pela Comunica API do CNJ (https://comunicaapi.pje.jus.br/api/v1/comunicacao). Pública, sem chave; consulta por OAB + UF, nome e número do processo. Documentação: https://comunicaapi.pje.jus.br/swagger/index.html
  - Pode recusar acesso de fora do Brasil (HTTP 403): chame só de funções em gru1/sa-east-1.
  - Após HTTP 429, espere 60 s. Nunca use vários IPs para contornar limite.
- Dados do processo: API Pública do DataJud (metadados e movimentos; não traz o texto das intimações). Chave em DATAJUD_API_KEY.
- O DJEN não cobre citações e intimações pessoais (Domicílio Judicial Eletrônico) nem o conteúdo de processos sigilosos. A interface deve dizer isso.

## Regras de arquitetura
- Multi-tenant: toda tabela de negócio tem `escritorio_id`. RLS obrigatória em todas, sem exceção. Cada tabela nova vem com teste que tenta ler dados de outro escritório e precisa falhar.
- Permissão em três camadas que precisam bater: menu, rota e RLS.
- A chave `service_role` do Supabase só existe no servidor. Tokens de terceiros (Google, Meta) ficam criptografados no banco (Supabase Vault).
- Datas e horas em `timestamptz`; exibição em America/Sao_Paulo.
- Dinheiro em centavos (`bigint`); cálculo intermediário com biblioteca decimal; nunca `float`.
- Toda ação que cria, altera ou apaga dado de cliente, processo, prazo, financeiro ou assinatura grava em `audit_log` (quem, quando, o quê, antes/depois).
- Integrações externas (tribunais, Google, IA, WhatsApp, cobrança) ficam atrás de interfaces próprias em /lib/integrations. A regra de negócio nunca chama SDK de terceiro direto.
- Segredos só em variáveis de ambiente, documentados em `.env.example`. Nunca no código, nunca no cliente.
- Tabelas e colunas em português, snake_case, sem acento.

## Regras de produto (inegociáveis)
- O LAW é ferramenta de apoio. Prazo calculado é SUGESTÃO: mostra o trecho da publicação de onde saiu e o passo a passo da contagem, e só passa a existir depois que o advogado confirma. Toda tela de prazo exibe aviso para conferir no sistema oficial do tribunal.
- A data do prazo é calculada por código determinístico e testado, nunca pela IA.
- IA nunca grava nada sem confirmação explícita do usuário. Rascunho gerado por IA nasce marcado como "não revisado".
- Falha ou atraso na captura de publicações aparece como alerta ao escritório, nunca como "nenhuma publicação".
- Processos em segredo de justiça nunca aparecem fora da área interna do escritório (portal do cliente, WhatsApp, conectores externos).
- Sem disparo em massa: WhatsApp só para avisos combinados e para responder quem iniciou a conversa.
- Textos de interface em português do Brasil, linguagem simples.

## Como trabalhar
- Antes de codar uma funcionalidade, mostre um resumo do modelo de dados, das telas e dos casos de erro, e siga sem esperar meu ok.
- Exceção: ações irreversíveis param e esperam minha confirmação: apagar dados, migração destrutiva, publicar em produção, enviar e-mail ou mensagem real.

## Regra de pendências (nunca travar a construção)
- Se faltar algo que bloqueie (informação, credencial, chave de API, decisão de produto, planilha de conferência, confirmação de regra jurídica), NÃO pare.
- Registre em /PENDENCIAS.md: id (P-001, P-002…), o que falta, por que importa, onde afeta (arquivo/funcionalidade), solução provisória usada, data.
- Siga com a solução provisória mais isolada e fácil de trocar: mock, dado de exemplo, variável de ambiente vazia com valor padrão, regra parametrizável. Marque no código com `// PENDENCIA P-00X`.
- Nunca use solução provisória que finja ser dado real para o usuário final (ex.: prazo ou cálculo com regra não confirmada sem aviso visível).
- Nunca use dados reais de pessoas em testes, seeds ou exemplos.

## Banco e testes
- Migrações SQL versionadas em /supabase/migrations. Nunca altere o banco fora de migração.
- Testes obrigatórios para: contagem de prazo, cálculos judiciais, permissões e RLS, saldo financeiro e verificação de hash da assinatura.

## Ao final de cada sessão
Liste o que foi feito, o que ficou pendente e as pendências novas e resolvidas.
