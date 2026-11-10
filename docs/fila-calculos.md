# Fila de cálculos (cada item vira um prompt próprio quando chegar a vez)

Anotado em 10/11/2026. Nada disso está implementado. Cada item precisa de advogado da área validando antes de ir ao usuário.

## 1. Fazenda Pública: precatório e RPV (Prompt 8C)

A regra mudou de novo com a **EC 136/2025**, promulgada em 09/09/2025. Conferido em 10/11/2026 em fontes oficiais: TRF6, CNJ (Provimento 207/2025) e Comunicado 09/2025 da UFEP do TRF3.

- **Depois da expedição do requisitório:**
  - A correção é pelo **IPCA**, aplicado sobre o principal mais os juros já somados.
  - Os juros de mora são **simples, de 2% ao ano**, calculados mês a mês **só sobre o principal**, sem juros compensatórios.
  - Se IPCA + juros passar da **Selic** do período, vale a Selic.
- **Prazo constitucional de pagamento (CF, art. 100, § 5º):** só correção, **sem juros**.
- **Início da regra nova (a confirmar por ente):**
  - Federal: a partir de **09/2025** (Provimento CNJ 207/2025).
  - Estados, DF e Municípios: há fonte que diz **1º/08/2025**.
- **Antes da expedição:** há fonte que indica **IPCA-15 + Taxa Legal desde 09/2025** (Manual CJF 2026). Ainda **a confirmar**, ver P-006.
- **Risco:** há ADI no STF contra a EC 136/2025. A regra pode mudar de novo, então ela precisa ficar parametrizada no regime, nunca fixa no código.
- **Como encaixa no motor do 8A:** regime com quatro trechos e cortes por marco do processo:
  1. até 11/2021;
  2. de 12/2021 a 08/2025 (EC 113/2021, Selic);
  3. a partir de 09/2025, antes da expedição;
  4. depois da expedição, com a regra da EC 136 e o período de graça sem juros.
- **Novidade para o motor:** juros simples sobre o principal com **teto pela Selic** comparado no período. Hoje o motor não compara duas regras e fica com a menor.

## 2. Honorários contra a Fazenda (vai junto do 8C)

São as faixas escalonadas do CPC, art. 85, § 3º (I a V, em salários-mínimos), aplicadas por faixa (§ 5º). Hoje `calcularHonorarios()` só avisa da regra (P-048).

## 3. Previdenciário

Cobre RMI, atrasados e revisões. As regras mudaram muito com a Reforma da Previdência (EC 103/2019). É de alto valor e alta complexidade, então **só com um advogado previdenciarista validando**, com casos de conferência dele.

## 4. Revisional bancária

- Tabela Price × SAC.
- Recálculo sem capitalização.
- Comparação com a **taxa média do Banco Central** para o tipo de operação (séries SGS de taxas médias de juros; mapear os códigos por modalidade).

## 5. Pensão alimentícia

- Percentual sobre os rendimentos.
- Atrasados atualizados.
- As **3 últimas parcelas** aparecem destacadas e separadas das antigas, porque permitem pedir prisão (CPC, art. 528, § 7º; Súmula 309 do STJ).

## 6. Penal

Dosimetria em 3 fases e execução (progressão, remição, detração). **Não usa índices**: é um motor próprio de datas e frações, separado do motor do 8A.
