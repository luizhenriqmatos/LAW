# LAW

SaaS de gestão para advogados e escritórios. Regras do projeto em `CLAUDE.md`; pendências em `PENDENCIAS.md`.

## Rodar localmente

```bash
npm install
cp .env.example .env.local   # preencha com o projeto Supabase (sa-east-1)
npm run dev
```

Sem as variáveis do Supabase, o app abre a tela "Configuração pendente" em vez de quebrar.

## Banco

Migrações em `supabase/migrations`. Para aplicar num projeto Supabase:

```bash
npx supabase link --project-ref <ref>
npx supabase db push
```

## Testes

```bash
npx vitest run
```

- `tests/regras.test.ts` — validação de OAB, UF e CNPJ; menu e rota usam a mesma regra de módulos.
- `tests/fontes.test.ts` — nº CNJ (extração e dígito verificador módulo 97), limpeza do HTML, hash de deduplicação, fila com espera crescente, adaptadores DJEN e DataJud.
- `tests/db/captura.test.ts` — job de captura no Postgres embutido: grava sem duplicar ao rodar duas vezes, falha no DataJud não impede a gravação, falha no DJEN vira alerta, RLS das publicações.
- `tests/captura-regras.test.ts` — regra do aviso de captura atrasada.
- `tests/db/triagem.test.ts` — critério de pronto do Prompt 3: publicação nova → processo e clientes provisórios → confirmação → publicação seguinte ligada sozinha; publicação sem nº na fila e ligada manualmente; descarte e restauração em 30 dias; mesclagem; lote; permissões e auditoria.
- `tests/prazos-contagem.test.ts` — contagem: sexta-feira, véspera de feriado, recesso, feriado estadual, vencimento em sábado/domingo/feriado, corridos, entradas inválidas, sugestão de dias pelo texto.
- `tests/prazos-alertas.test.ts` — regra dos alertas (7h, 3 dias antes, no dia, vencido todo dia) com relógio simulado.
- `tests/db/prazos.test.ts` — calendário semeado, criação de prazo (permissões, processo confirmado, responsável), status e os três alertas rodando de ponta a ponta no banco, com e-mail falso.
- `tests/triagem-regras.test.ts` — CPF/CNPJ, formulário de cliente e sugestão de mesclagem por nome parecido.
- `tests/db/tarefas.test.ts` — colunas padrão e gestão (só dono), cartões e vínculos validados, ordem persistida ao arrastar, isolamento por tela e por escritório, agenda interna (data muda nos dois lugares), fila de sincronização sem repetição.
- `tests/db/google-sync.test.ts` — sincronização com Google falso: calendário "LAW" criado, tarefa com data aparece, editar atualiza o mesmo evento, apagar remove, trocar responsável move, segredo de justiça, idempotência, falha temporária, token revogado (para só aquela conexão, avisa, o resto segue), reconexão.
- `tests/google-agenda.test.ts`, `tests/tarefas-regras.test.ts` — cifra dos tokens, OAuth e escopo mínimo, mapeamento de erros do Google, montagem do evento, ordem do quadro e grade do mês.
- `tests/db/rls.test.ts` — roda a migração num Postgres embutido (PGlite) e simula o usuário logado como o Supabase faz (papel `authenticated` + `auth.uid()`). Prova o critério de pronto do Prompt 1: membro sem financeiro não lê, não grava, não altera nem apaga lançamentos, nem devolve a permissão a si mesmo.

## Captura de publicações (Prompt 2)

- Fontes em `src/lib/integrations/fontes` (interface `FonteJuridica`): DJEN (intimações) e DataJud (dados do processo). Provedor pago entra como novo adaptador, sem mexer no job.
- Job em `src/lib/captura/job.ts`; roda todo dia às 4h (Brasília) pela Vercel Cron (`vercel.json`, região gru1) e logo após o onboarding.
- O DJEN recusa acesso de fora do Brasil. Teste ao vivo, de uma máquina no Brasil:

```bash
npm run captura:ao-vivo -- --oab 54321 --uf BA --dias 7
```

## Triagem (Prompt 3)

No fim de cada captura, `triar_publicacoes()` (só o job chama) separa o que chegou:

- nº CNJ de processo **confirmado** → publicação ligada sozinha (aparece na linha do tempo);
- nº CNJ novo → **processo provisório** + **clientes provisórios** a partir das partes;
- sem nº identificável → fila **Publicações sem processo**.

Telas: `/app/processos` (confirmados e busca), `/app/processos/triagem` (abas Processos novos, Clientes novos, Publicações sem processo, com contador e confirmação em lote), `/app/processos/[id]` (dados, partes, linha do tempo, prazos, tarefas, documentos, financeiro) e `/app/processos/clientes/[id]` (editar e confirmar, mesclar).

Provisório não entra em relatório, financeiro nem portal: use as views `processo_confirmado` e `cliente_confirmado`; lançamento ligado a provisório é recusado pelo banco. Descartar não apaga: some da fila e pode ser restaurado por 30 dias. Toda ação passa por função do banco que confere a permissão Processos e fica na auditoria.

## Prazos (Prompt 4)

- **Contagem** (`src/lib/prazos/contagem.ts`, módulo puro): publicação = 1º dia útil após a disponibilização; o prazo começa no 1º dia útil após a publicação (esse dia é o dia 1); dias úteis por padrão (CPC 219); suspensão de 20/12 a 20/01 (CPC 220) também para dias corridos; vencimento em dia não útil prorroga. Mostra o raciocínio passo a passo e sempre o aviso "Prazo sugerido. Confira no sistema oficial do tribunal."
- **Calendário** (`calendario_forense`): semente com feriados nacionais, Sexta-feira Santa (pela Páscoa), 2 de Julho (BA) e Carnaval/Corpus Christi do TJBA; o dono acrescenta os do escritório.
- **Fluxo**: publicação ligada a processo confirmado → "Criar prazo" → sugestão de dias lida do texto → responsável → data calculada com o raciocínio → o usuário confere e confirma → só então o prazo existe. O servidor recalcula a data e recusa se for diferente da que o usuário viu.
- **Alertas** (`/api/cron/prazos`, 07h de Brasília): 3 dias antes, no dia e todo dia depois de vencido, até cumprir. Aviso no app (menu "Avisos") e e-mail; cada alerta sai uma vez só.
- Telas: `/app/prazos` (Hoje / Esta semana / Vencidos / Todos, filtros), `/app/prazos/novo`, `/app/prazos/calendario`, `/app/avisos`.

## Tarefas, agenda e Google Agenda (Prompt 5)

- **Kanban** (`/app/tarefas`): colunas A fazer, Fazendo, Revisão, Feito (o dono cria, renomeia, reordena e remove em `/app/tarefas/colunas`; só remove coluna vazia). Cartão com título, descrição, responsável, data, processo e cliente (só confirmados), etiquetas, checklist e comentários. Arrastar e soltar entre colunas e dentro da coluna, com a ordem gravada no banco (`mover_tarefa`); botões ↑ ↓ e seletor de coluna para teclado e celular. Filtros por responsável, processo e etiqueta (com filtro ligado o arrastar fica desligado).
- **Agenda** (`/app/agenda`): mês com prazos, tarefas com data e compromissos (audiência, reunião, outro). Tarefa com data já é item da agenda: mudar a data no cartão ou na agenda muda a mesma linha. Cada bloco só aparece para quem tem a tela correspondente.
- **Google Agenda** (mão única LAW → Google): conexão por usuário com o escopo mínimo `calendar.app.created`; ao conectar cria o calendário separado "LAW". Criar, editar e apagar tarefa/prazo/compromisso reflete lá. O id do evento é determinístico e fica guardado (`google_evento`), então refazer nunca duplica. Token revogado ou expirado para só aquela conexão, avisa o usuário (aviso no app e faixa em todas as telas) e o resto do LAW segue. Processo em segredo de justiça vai ao Google como "LAW: item restrito".
- Arquitetura: gatilhos no banco colocam cada mudança na fila `agenda_sync_fila`; `processarFila()` (`src/lib/agenda/sync.ts`) esvazia a fila logo depois da ação do usuário (`after()`), e o cron diário `/api/cron/agenda-sync` repete o que falhou. Tokens cifrados com `GOOGLE_TOKEN_KEY` e sem nenhuma permissão de leitura para o navegador.
- Variáveis novas: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_KEY` (ver `.env.example` e P-026/P-029).

## Documentos e Google Drive (Prompt 6)

- **Conexão** (`/app/documentos`, só o dono): OAuth com a conta Google do escritório, escopo mínimo `drive.file` (o LAW só enxerga o que ele mesmo criou). Mesmo app do Google Agenda e mesmo endereço de retorno; o propósito (agenda ou drive) vai no cookie do `state`. Cria `LAW` e `LAW/Clientes`.
- **Pastas automáticas**: confirmar cliente cria `LAW/Clientes/<Nome>`; confirmar processo cria `<CNJ formatado> - <classe>` dentro da pasta do cliente principal (P-037). Renomear cliente (`/app/processos/clientes/<id>`) renomeia a pasta. Os ids ficam em `drive_pasta`; mesclar clientes move a pasta do processo.
- **Nunca apaga**: não existe chamada de apagar no código (um teste confere). Descartar, mesclar, pasta apagada por fora ou desconectar só DESVINCULAM no banco; confirmar de novo reaproveita a mesma pasta (marca gravada na pasta, `appProperties`).
- **Telas**: seção "Arquivos" no cliente e no processo (lista a pasta, envia arquivo até 4 MB, abre no Drive, abre a pasta). Quem tem Processos ou Documentos vê; o banco confere (`drive_pasta_de`).
- Arquitetura: gatilhos colocam cliente/processo na fila `drive_fila` (com versão, sem duplicar); `processarFilaDrive()` esvazia depois da ação (`after()`) e o cron diário `/api/cron/drive-sync` repete o que falhou. Acesso revogado para só o Drive, avisa os donos e a reconexão reenfileira tudo. Tokens cifrados com a mesma `GOOGLE_TOKEN_KEY`; as tabelas do Drive não têm nenhuma permissão para o navegador.
- Pendências: P-033 a P-038 (Google Cloud, arquivos soltos no Drive, pasta "LAW" antiga, revogação cruzada, regra do cliente principal, limite de 4 MB).

## Financeiro (Prompt 7)

- **Modelo**: `lancamento` (receita/despesa, categoria, cliente, processo opcional, valor total em centavos, competência), `parcela` (número, valor, vencimento, pago, forma, status) e `pagamento` (cada pagamento ou estorno; permite "recebido no mês" exato e estorno). Parcela e pagamento só mudam por funções do banco que conferem a permissão `financeiro`.
- **Parcelamento**: N parcelas; a diferença de centavos vai para a primeira (R$ 100,00 em 3 = 33,34 + 33,33 + 33,33). Vencimentos mensais; dia 31 cai no último dia do mês curto. A tela mostra a prévia com a mesma conta do banco.
- **Saldo** = soma do que falta nas parcelas não pagas e não canceladas. Pagamento parcial vira `parcial`. Atrasado é derivado da data na leitura; o job diário (`/api/cron/financeiro`) grava `atrasada` nas abertas vencidas.
- **Telas**: `/app/financeiro` (a receber, recebido no mês, atrasado, despesas do mês, saldos por cliente e processo), `/lancamentos` (filtros), `/novo`, `/lancamentos/<id>` (pagar, estornar, cancelar, mudar vencimento), extratos `/clientes/<id>` e `/processos/<id>`, CSV em `/exportar` (UTF-8 com BOM, `;`, vírgula decimal, proteção contra injeção de fórmula).
- **Permissão**: sem `financeiro`, o membro não vê nenhum valor (RLS e toda função recusam com `sem_permissao`); cliente e processo precisam estar confirmados.
- **Gateway**: `GatewayCobranca` vazia em `src/lib/integrations` (P-039).
- Pendências: P-039 a P-044.

## Cálculos (Prompt 8A)

- **Motor por trechos** (`src/lib/calculos/motor.ts`, decimal de 50 dígitos com `decimal.js`, nunca float):
  - Corta a linha do tempo pela vigência de cada regime e aplica a regra de cada trecho.
  - Um débito de 2023 a 2026 sai em dois trechos, com a troca exatamente em 30/08/2024 (Lei 14.905/2024).
  - Correção: fator acumulado mês a mês.
  - Juros: simples, proporcionais aos dias corridos (6 casas, Res. CMN 5.171/2024).
  - Dinheiro é arredondado só no valor final de cada linha.
- **Regimes são dados** (`regime_atualizacao`):
  - Vêm dois cíveis padrão: até 29/08/2024, INPC editável + 1% ao mês; desde 30/08/2024, IPCA + Taxa Legal.
  - O advogado cria regime personalizado ("critério da sentença").
  - Nenhum regime é alterado: mudança vira nova versão, e o cálculo antigo continua reproduzível.
  - O banco recusa Selic somada a outro índice no mesmo regime.
- **Índices em cache** (`indice_valor`):
  - Carga inicial do SGS do Banco Central em 09/11/2026: IPCA, IPCA-E, IPCA-15, INPC, IGP-M (28655), TR, Selic e Taxa Legal (29543).
  - O job `/api/cron/indices` roda nos dias 2, 12 e 26 e busca os últimos 24 meses; o dono também pode clicar em "Atualizar agora".
  - O cálculo nunca chama a API na hora. A Selic do mês corrente (parcial) não entra.
- **Cálculos**:
  - (1) Atualização + juros de mora, com juros desde o vencimento ou a citação.
  - (2) Art. 523: prazo de 15 dias úteis com a contagem do Prompt 4 e o calendário forense do tribunal; multa de 10% e honorários de 10%; pagamento parcial no prazo faz multa e honorários incidirem só sobre o restante.
  - (3) Honorários: sucumbência de 10% a 20% sobre condenação, proveito ou valor da causa; contratuais fixos ou percentuais; êxito. Contra a Fazenda só avisa (art. 85, § 3º; entra no 8C).
- **Demonstrativo**: a tela e o PDF (`pdf-lib`, A4 deitado) mostram as mesmas partes:
  - cabeçalho;
  - regras aplicadas por trecho, com fundamento;
  - tabela mês a mês;
  - totais;
  - fonte, código e data de coleta de cada série;
  - o aviso "Cálculo de apoio".
- **O que dá para fazer com um cálculo**: salvar o PDF na pasta do processo no Drive, editar (recalcula), duplicar (copia sem recalcular), e partir dele para um art. 523 ou para honorários sobre o total.
- **Permissão**: tela nova `calculos` (o dono recebe automaticamente). Sem ela, o membro não vê cálculo nenhum (RLS e funções recusam).
- **Conferência**: `docs/conferencia/README.md` traz as respostas reais da Calculadora do Cidadão e o script independente `conferir.py`.
- **Pendências**: P-003 (planilhas do escritório) e P-045 a P-050.

## Créditos trabalhistas (Prompt 8B)

- **Fases do STF (ADC 58) e do TST (E-ED-RR-713-03.2010.5.04.0029)**, cadastradas como regimes de escopo "trabalhista":
  - Antes do ajuizamento: IPCA-E + juros do art. 39, caput, da Lei 8.177/1991 (TR).
  - Do ajuizamento até 29/08/2024: só a Selic, que entra no fator em soma simples, sem juros à parte.
  - Desde 30/08/2024: IPCA + Taxa Legal.
- **O motor do 8A ganhou marcos**: um regime pode valer "a partir do ajuizamento" ou "até a véspera do ajuizamento", além das datas fixas. A data de ajuizamento é obrigatória no cálculo trabalhista.
- **Verba por verba**: cada verba tem o seu vencimento e a sua linha do tempo; o total é a soma. O demonstrativo agrupa as verbas por vencimento, com as regras e a tabela mês a mês de cada grupo.
- **Verbas rescisórias** (`src/lib/calculos/rescisao.ts`):
  - Saldo de salário.
  - Aviso prévio proporcional (30 + 3 por ano, até 90 dias), com projeção.
  - 13º proporcional.
  - Férias vencidas (simples ou em dobro) e proporcionais, + 1/3.
  - FGTS do mês da rescisão e multa de 40% (20% no acordo do art. 484-A).
  - Tipos de desligamento: sem justa causa, pedido de demissão, justa causa e acordo. Cada verba mostra a sua regra, inclusive as não devidas.
- **Fora desta entrega** (8B-2): horas extras e reflexos, adicionais, INSS e IR (P-052).
- **Conferência**: `docs/conferencia/conferencia-trabalhista.xlsx` traz a planilha com fórmulas próprias e bate centavo a centavo; o IPCA-E foi conferido na Calculadora do Cidadão.
- **Pendências**: P-004 e P-051 a P-054.

## Estado

- Prompt 1 (escritório, equipe e permissões): pronto, com as pendências P-015 a P-017.
- Prompt 2 (captura de publicações): pronto, faltando o teste ao vivo a partir do Brasil (P-014).
- Prompt 3 (triagem): pronto pelo teste de banco; telas compiladas, falta ver no navegador com um Supabase real (P-015/P-017).
- Prompt 4 (prazos): pronto pelos testes de contagem e de alertas com relógio simulado; falta ver as telas com um Supabase real (P-015/P-017).
- Prompt 5 (tarefas, agenda e Google Agenda): pronto pelos testes de banco e de sincronização com um Google falso; falta o teste contra um Google real (P-026/P-027).
- Prompt 6 (documentos e Google Drive): pronto pelos testes de banco e de sincronização com um Drive falso; falta o teste contra um Google real (P-033/P-036).
- Prompt 7 (financeiro): pronto pelos testes de banco (parcelamento, saldo, permissão) e de regras; falta ver as telas com um Supabase real (P-015/P-017) e validar as regras com o piloto (P-040).
- Prompt 8A (motor de cálculo, atualização, art. 523, honorários, PDF): pronto pelos testes. Os fatores e a Taxa Legal batem com a Calculadora do Cidadão, e os valores com o script independente. Falta conferir com as planilhas do escritório (P-003) e ver as telas com um Supabase real (P-015/P-017).
- Prompt 8B (trabalhista ADC 58 + verbas rescisórias): pronto pelos testes. Os três trechos e a rescisão de exemplo batem com a planilha de conferência própria. Falta validar as convenções com o PJe-Calc e com advogados trabalhistas (P-051 a P-054) e conferir com a planilha do escritório (P-004).
- Prompt 9 (portal do cliente): pronto pelos testes (segredo de justiça barrado em todas as camadas; link reutilizado/expirado recusado). Falta chave da IA, e-mail real e revisão do dicionário de linguagem simples (P-055 a P-059). Próximo: Prompt 11.
- Prompt 10 (assinatura eletrônica avançada): pronto pelos testes (envelope com 2 signatários concluído; 1 byte alterado no PDF final falha na verificação; evidências append-only por permissão e gatilho). Falta segundo fator/validação de CPF, PAdES, armazenamento de objetos, revisão jurídica e e-mail real (P-060 a P-065).
- Prompt 11 (assistente de IA "Lia"): pronto pelos testes com IA de roteiro ("3 parcelas de R$ 1.000 para Fulano" gera o rascunho certo e nada é gravado antes do Confirmar; sem Financeiro a ferramenta recusa e a tela mostra aviso fixo). Falta teste com a API real, avaliação de qualidade, marca no INPI, DPA/LGPD e limites de custo (P-066 a P-070).
- Prompt 12 (conectores Claude/ChatGPT por MCP + OAuth 2.1): pronto pelos testes com cliente simulado. O Claude lista os prazos da semana e cria tarefa (ferramenta marcada como destrutiva). Revogar em Conexões corta na chamada seguinte. Falta segredo JWT do Supabase, site em https e teste ao vivo nos dois assistentes (P-071 a P-075).
- Prompt 13 (recepcionista do WhatsApp): pronto pelos testes com WhatsApp falso. Conversa de novo contato termina com atendimento criado e responsável avisado, sem nenhuma orientação jurídica. Falta conta da Meta, número, modelo aprovado e teste ao vivo (P-076 a P-081).
- Prompt 14 (encerramento de conta, exportação e páginas legais): pronto pelos testes com relógio simulado (dia 0 pedido, dia 23 aviso de 7 dias, dia 30 exclusão; o documento assinado sobrevive). Textos legais são RASCUNHO e levam "REVISAR COM ADVOGADO" no topo (P-082 a P-089).
- Próximo: Prompt 8C (Fazenda Pública + honorários do art. 85 §3º) ou o próximo da fila.

## Portal do cliente (Prompt 9)

Área sem senha onde o cliente acompanha só o que o advogado liberou, processo a processo (`/portal`).

- **Padrão: nada visível.** O advogado libera em Portal do cliente: situação, movimentações, resumo, compromissos marcados como visíveis e documentos, cada um por opção.
- **Segredo de justiça nunca aparece.** O banco recusa liberar (gatilhos valem até para o servidor), retira o que já estava liberado se o processo virar sigiloso (inclusive `nivelSigilo` do tribunal) e toda leitura do portal filtra de novo. A IA nunca recebe conteúdo de processo em segredo.
- **Acesso:** link por e-mail, token aleatório de 32 bytes (só o hash é guardado), uso único, vale 30 minutos; sessão de 7 dias. O link abre uma página com botão, e só o clique consome o link (leitores de e-mail não o queimam).
- **Resumo em linguagem simples:** IA a partir das movimentações, sem opinião nem previsão, termina com "Dúvidas? Fale com seu advogado.". Por escritório: revisar antes (padrão) ou publicar direto; alerta automático força rascunho.
- **Registro:** cada entrada, lista, processo e documento fica em `portal_acesso` com data e IP.
- Testes: `tests/db/portal.test.ts` (segredo, link reutilizado/expirado, RLS) e `tests/portal-regras.test.ts`.
- Pendências: P-055 a P-059.

## Assinatura eletrônica avançada (Prompt 10)

Envio de contratos e procurações para assinatura eletrônica **avançada** (Lei 14.063/2020, art. 4º, II), sem certificado ICP-Brasil. **Não é assinatura qualificada**: a interface, o e-mail e o PDF dizem isso.

- **Fluxo:** o advogado sobe o PDF (ou escolhe um PDF da pasta do processo no Drive) e cadastra os signatários (nome, e-mail, ordem opcional) em **Assinaturas**. O banco calcula o SHA-256 do original e congela o arquivo. Cada signatário recebe um link com token aleatório de 32 bytes (só o hash é guardado), válido por 7 dias.
- **Assinar:** o signatário lê o documento (a entrega do PDF é registrada como "visualização"), digita o CPF (dígitos verificadores conferidos no app e no banco), marca o aceite e assina. O texto do aceite é do banco.
- **Ordem:** quem tem ordem maior só recebe o link quando todos de ordem menor assinaram.
- **PDF final:** original + manifesto (nome, e-mail, CPF informado, data/hora, IP, navegador, hash do original). O banco calcula e registra o hash do PDF final.
- **Evidências append-only:** envio do e-mail, abertura do link, visualização, aceite, assinatura, conclusão (e criação/cancelamento). Sem UPDATE, DELETE nem TRUNCATE por permissão (nem para `service_role`) e por gatilho (nem para o dono da tabela). Cada linha guarda o hash da anterior: mexer em uma quebra a cadeia, e a tela do envelope mostra se está íntegra.
- **Retenção de 5 anos:** as tabelas não têm chave estrangeira para escritório, processo ou usuário; apagar a conta não apaga o documento. Gatilhos barram DELETE antes de `retencao_ate`.
- **Verificação pública:** `/verificar` — quem tem o PDF final sobe o arquivo; o servidor calcula o SHA-256 e confere. Alterar 1 byte faz falhar. Reconhece também o original (mostra que não é o final).
- Testes: `tests/db/assinatura.test.ts` (fluxo com 2 signatários, 1 byte alterado, append-only, token, retenção, RLS) e `tests/assinatura-regras.test.ts`.
- Pendências: P-060 a P-065 (armazenamento, força jurídica/segundo fator, PAdES, LGPD, funções fora do escopo, e-mail).

## Assistente de IA "Lia" (Prompt 11)

**Lia** (L de LAW + IA) responde perguntas com os dados do escritório e **prepara** ações. Ela **nunca grava sozinha** (tela `/app/assistente`, módulo `assistente` na equipe). O nome fica numa constante só: `src/lib/assistente/nome.ts`.

- **Arquitetura:** API da Anthropic com uso de ferramentas (`src/lib/integrations/ia`). O laço está em `src/lib/assistente/motor.ts`. Tem no máximo 8 rodadas e 6 ferramentas por rodada.
- **Ferramentas de leitura** (executam direto): `buscar_processos`, `buscar_clientes`, `buscar_prazos`, `buscar_tarefas`, `buscar_lancamentos`, `buscar_publicacoes`.
  - Cada uma é uma função do banco chamada **com o login do usuário**, pela RLS. Quem não vê o módulo recebe `sem_permissao`, e não uma lista vazia.
  - Cada item traz `rotulo` e `link` da tela. A resposta só vira link se o link veio de uma ferramenta.
- **Ferramentas de escrita** (`preparar_lancamento`, `preparar_tarefa`, `preparar_prazo`, `preparar_minuta`) só criam um **rascunho pendente**. O rascunho aparece num cartão com **Confirmar / Editar / Descartar**.
  - Só o Confirmar grava, por `assistente_rascunho_confirmar`. Essa função chama as mesmas funções das telas (`lancamento_criar`, `tarefa_criar`, `criar_prazo`), com as mesmas permissões e validações.
  - O rascunho vence em 24 h.
- **Regras feitas em código (não pela IA):**
  - Valor em reais vira centavos exatos ("3 × R$ 1.000" = 300000 centavos).
  - O cliente é achado pelo nome no banco. Se o nome der em mais de um cliente, o cartão pede para escolher.
  - A data do prazo é calculada pelo módulo de contagem e recalculada no Confirmar. A IA não consegue mandar a data final.
  - A minuta é montada a partir de **modelo cadastrado pelo escritório** (Lia > Modelos de contrato, campos `{{campo}}`). Os dados do cliente vêm do cadastro, e o CPF/CNPJ **não vai para a IA**. A minuta nasce **não revisada**.
- **Permissões:** a Lia vê exatamente o que o usuário vê. Sem Financeiro, a ferramenta recusa, nenhum valor chega à IA, e a tela mostra um aviso fixo que não depende do texto da IA.
- **Segredo de justiça:** o processo vai à IA sem partes, título e texto de publicação. Ele também não é achado pelo nome da parte.
- **Registro:**
  - Conversa, mensagens (só-acréscimo: ninguém edita nem apaga), rascunhos, modelos e minutas gravam no `audit_log`.
  - A conversa é só de quem conversou. O dono vê as conversas no `audit_log`, e a tela avisa isso.
- Variáveis: `ANTHROPIC_API_KEY` e, se quiser, `ANTHROPIC_MODEL_ASSISTENTE` (padrão `claude-sonnet-5-5`). Sem a chave, a tela avisa que a Lia não está ativa.
- Testes:
  - `tests/db/assistente.test.ts`: critério de pronto, recusa sem Financeiro, RLS cruzada, segredo de justiça, só-acréscimo, prazo pelo módulo de contagem, minuta sem CPF na IA.
  - `tests/assistente-regras.test.ts` e `tests/assistente-tela.test.ts`.
- Pendências: P-066 a P-070.

## Conectores: Claude e ChatGPT (Prompt 12)

O advogado liga o assistente que já usa à conta do LAW. O conector é um **servidor MCP remoto** (MCP = Model Context Protocol, o padrão que esses assistentes usam para falar com sistemas externos) em `/api/mcp`, com **OAuth 2.1** (o usuário autoriza e o token herda as permissões dele).

- **Descoberta automática:**
  - Sem token, `/api/mcp` responde 401 apontando para `/.well-known/oauth-protected-resource/api/mcp` (RFC 9728).
  - Esse endereço indica `/.well-known/oauth-authorization-server` (RFC 8414).
  - O assistente se registra sozinho em `/api/oauth/register` (RFC 7591).
  - O usuário autoriza em `/oauth/autorizar`, e o assistente troca o código em `/api/oauth/token`. O PKCE com S256 é obrigatório.
- **Tokens:**
  - São aleatórios, e o banco guarda só o hash.
  - O acesso dura 1 h e o refresh dura 30 dias, renovado a cada uso.
  - Refresh reaproveitado revoga a conexão inteira. Código reaproveitado derruba o token emitido com ele.
- **Mesmas ferramentas da Lia:**
  - Leitura (`law.read`): `buscar_*`, marcadas como só leitura. Prazos e tarefas aceitam `periodo` (hoje/semana/próximos 7 dias/mês).
  - Escrita (`law.write`): `criar_lancamento`, `criar_tarefa`, `criar_prazo`, `gerar_minuta`. São marcadas como **destrutivas**, para o assistente pedir aprovação a cada chamada.
  - A escrita segue o caminho da Lia: rascunho de origem `mcp`, confirmação pelas funções das telas e registro no `audit_log`. A data do prazo continua calculada pelo LAW.
- **Permissões reais:**
  - Cada chamada roda com um JWT de 5 minutos do próprio usuário (`law_canal = mcp`), então a RLS vale exatamente como na tela.
  - O token é conferido no banco a cada chamada. Revogar, tirar a tela da Lia do membro ou desligar os conectores corta na hora.
- **Teto de escopos por cliente:** detectado pelo endereço de retorno. Claude = leitura + escrita; ChatGPT e outros = só leitura. Fica em `oauth_cliente.escopos_permitidos`.
- **Segredo de justiça:**
  - No canal externo, processos em segredo **somem** de todas as buscas (nem o número), junto com seus prazos, tarefas, lançamentos e publicações.
  - O dono pode permitir na tela Conexões. Mesmo assim, só saem o número, o tribunal e o link, sem partes, título ou texto.
- **Limites:** 60 chamadas por minuto por token e 2.000 por dia por conexão. Cada chamada fica em `mcp_chamada`.
- **Tela Conexões** (`/app/conexoes`): mostra o endereço para colar no assistente, as conexões ativas (com o último uso e as gravações das últimas 24 h) e o botão **Revogar acesso**. O dono vê e revoga as conexões do escritório e configura as regras.
- Variáveis: `NEXT_PUBLIC_SITE_URL` (https), `SUPABASE_SERVICE_ROLE_KEY` e `SUPABASE_JWT_SECRET`. Sem elas, os endpoints respondem 503 e a tela avisa.
- Testes:
  - `tests/db/conectores.test.ts`: critério de pronto de ponta a ponta, PKCE, código e refresh reaproveitados, ChatGPT só leitura, segredo de justiça, limite, revogação, RLS.
  - `tests/mcp-regras.test.ts`: protocolo, transporte, cripto e metadados.
- Pendências: P-071 a P-075.

## Recepcionista do WhatsApp (Prompt 13)

Atendimento inicial automático pelo WhatsApp Cloud API oficial da Meta, com passagem para humano. Webhook em `/api/whatsapp`.

- **Webhook:**
  - `GET` devolve o desafio da Meta só com o `WHATSAPP_VERIFY_TOKEN` certo.
  - `POST` confere a assinatura `X-Hub-Signature-256` (HMAC-SHA256 do corpo bruto com `WHATSAPP_APP_SECRET`) **antes** de ler o JSON. Sem assinatura válida: 401 e nada é gravado.
  - Cada mensagem é idempotente pelo id da Meta. Se o servidor cair no meio, a Meta reenvia e a mensagem ainda é tratada.
- **A recepcionista não escreve texto livre.**
  - Todas as frases vêm de `src/lib/whatsapp/textos.ts`. A IA, quando ligada, só escolhe uma entre cinco categorias, e qualquer resposta fora das cinco vira "outro".
  - Por isso ela não consegue dar orientação jurídica, opinar, prever resultado, citar dado de processo nem prometer prazo.
  - Prazo e horário só saem se o escritório escreveu a frase na configuração, e ela é repetida como está.
  - Quem pede opinião recebe uma recusa fixa e a conversa segue.
- **Fluxo:**
  - Cumprimenta com o nome do escritório e pergunta o motivo: novo caso, andamento de processo, financeiro, agendamento ou outro.
  - Contato novo informa o nome; quem tem o telefone de um único cliente confirmado não precisa informar.
  - Cria o `atendimento`, avisa o responsável (ou todos os donos) em Avisos e passa para humano.
- **Identificação pelo telefone:** casa DDD + 8 últimos dígitos com clientes **confirmados**. Um cliente = "cliente cadastrado"; mais de um = "ambíguo"; nenhum = "contato novo". A recepcionista **nunca** revela o nome nem dado algum do cadastro. A tela do atendimento lembra a equipe de confirmar a identidade antes de passar dado de processo.
- **Humano assumiu:** a conversa fica em estado `humano` e a recepcionista não responde mais até alguém clicar em **Encerrar atendimento**. Depois disso, a próxima mensagem abre uma conversa nova.
- **Janela de 24 h da Meta:**
  - O banco só deixa a equipe enviar texto livre até 24 h depois da última mensagem **da pessoa**.
  - Depois, só o modelo (template) aprovado, e só em conversa que a pessoa iniciou (sem disparo em massa).
  - Quando a pessoa responde, a janela reabre.
- **Telas:** `/app/atendimentos` (lista, conversa, responder, assumir, encerrar; módulo `atendimento`) e `/app/atendimentos/configurar` (só o dono: ligar, responsável, frases de prazo e horário, modelo de retomada, números).
- **Privacidade:** as mensagens só são lidas por quem tem o módulo. Não vão para o `audit_log` (a própria `whatsapp_mensagem` é o registro); conversa, atendimento, número e configuração vão.
- **Testes:**
  - `tests/whatsapp-regras.test.ts`: assinatura, payload, fluxo e as proibições (toda resposta é frase fixa).
  - `tests/whatsapp-rota.test.ts`: a rota.
  - `tests/db/atendimento.test.ts`: o critério de pronto, humano mudo, encerrar, identificação, duplicidade e falhas, janela de 24 h, permissões e RLS.
- Pendências: P-076 a P-081.

## Encerramento de conta, exportação e páginas legais (Prompt 14)

**Fluxo.** O dono pede em *Conta* (digita o nome do escritório) -> a conta fica 30 dias em *encerramento*: só leitura para quem está logado, exportação liberada, o dono pode cancelar -> no dia 30 a rotina diária apaga os dados do escritório. Avisos por e-mail ao dono: no pedido, 7 dias antes e na exclusão.

**O que fica.** Documentos assinados e suas evidências ficam 5 anos. Não é uma exceção no código de exclusão: as tabelas `assinatura_*` não têm chave estrangeira para `escritorio`, então apagar o escritório não chega a elas, e os gatilhos delas ainda bloqueiam DELETE até `retencao_ate`. Também fica uma linha em `conta_encerrada` (nome, datas, e-mails do dono, quantos envelopes) e uma linha de auditoria da exclusão.

**Somente leitura.** Gatilho `bloquear_encerramento` em toda tabela com `escritorio_id` (exceto `audit_log`, `notificacao` e `assinatura_*`) vale para usuário logado. Rotinas de serviço (captura, Drive, etc.) seguem gravando. Um teste falha se uma tabela nova com `escritorio_id` ficar sem o gatilho.

**Exportação.** `Conta > Baixar tudo` (`/app/conta/exportar`, só dono, a qualquer momento): ZIP com um CSV por tabela, PDFs original e final dos assinados, e LEIA-ME. Sem tokens, hashes de token nem colunas cifradas. Os arquivos do Google Drive não entram (continuam no Drive).

**Relógio.** Tudo recebe `p_agora`; a rotina `rodarRotinaEncerramento(rpc, email, agora)` é a mesma do cron `/api/cron/encerramento` (16h UTC, `CRON_SECRET`). Testes: `tests/db/encerramento.test.ts` (regras no banco), `tests/db/encerramento-rotina.test.ts` (dia a dia), `tests/conta-regras.test.ts` (CSV, ZIP, e-mails, páginas legais).

**Páginas legais.** `/termos` e `/privacidade`, públicas, texto próprio, com a faixa vermelha **REVISAR COM ADVOGADO** no topo (componente `PaginaLegal`; `rascunho={false}` só depois da revisão). Pontos entre [colchetes] dependem de decisão do negócio ou do advogado.
