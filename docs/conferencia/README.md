# Conferência dos cálculos (Prompt 8A)

As planilhas de conferência do escritório ainda não existem (PENDENCIA P-003). Enquanto isso, o motor foi conferido de duas formas independentes do código do LAW:

1. **Calculadora do Cidadão do Banco Central**, consultada em 09/11/2026 (respostas reais abaixo).
2. **Script em Python** (`conferir.py`), que refaz as contas com `decimal`, sem usar o motor. Rode `python3 docs/conferencia/conferir.py`.

Os dois resultados estão fixados em `tests/calculos.test.ts` e o teste falha se o motor mudar um centavo.

## Respostas da Calculadora do Cidadão (09/11/2026)

### Correção por índice (aba "Correção de valores", meses inicial e final incluídos)

| Índice | Período | Valor | Fator mostrado | Valor corrigido |
|---|---|---|---|---|
| IPCA | 01/2023 a 12/2023 | 1.000,00 | 1,04621110 | 1.046,21 |
| INPC | 03/2023 a 06/2024 | 12.345,67 | 1,05186860 | 12.986,02 |
| IPCA | 10/2024 a 05/2025 | 50.000,00 | 1,04263250 | 52.131,62 |
| INPC | 05/2023 a 08/2024 | 100.000,00 | 1,04091310 | 104.091,31 |
| IPCA | 09/2024 a 01/2026 | 100.000,00 | 1,06620740 | 106.620,74 |
| INPC | 02/2020 a 07/2024 | 98.765,43 | 1,31122760 | 129.503,96 |
| IGP-M (série 28655) | 01/2022 a 12/2024 | 7.777,77 | 1,08771580 | 8.460,00 |

### Taxa Legal (aba "Taxa Legal", dia inicial conta e dia final não)

| Período | Percentual |
|---|---|
| 30/08/2024 a 31/08/2024 | 0,019526% (exemplo da própria metodologia) |
| 30/08/2024 a 30/09/2024 | 0,692738% |
| 15/01/2025 a 10/06/2025 | 2,403407% |
| 12/11/2024 a 20/06/2025 | 3,344571% |
| 30/08/2024 a 10/02/2026 | 12,231549% |
| 10/03/2025 a 15/05/2025 | 0,603414% |
| 01/03/2025 a 01/04/2025 | 0,000000% (mês com Taxa Legal zero) |

A metodologia oficial (Res. CMN 5.171/2024, como a Calculadora explica) diz quatro coisas:

- Os juros são simples: as taxas mensais são somadas.
- No mês incompleto, a taxa é proporcional: taxa do mês ÷ dias do mês × dias corridos.
- Essa fração proporcional é arredondada em 6 casas decimais.
- O mês cheio usa a taxa inteira.

O motor reproduz os sete percentuais acima exatamente.

## Convenções do motor

| Assunto | Regra | Base |
|---|---|---|
| Período | O dia inicial conta e o dia final não | Calculadora (Taxa Legal) |
| Correção mês a mês | Índices do mês da data-base até o mês anterior ao da data final | Calculadora (meses inclusive) |
| Mês em que muda o regime | O índice do mês é o do regime vigente no 1º dia contado do mês (agosto/2024 ainda pelo INPC; IPCA desde setembro) | TJSP passou ao novo índice "desde set./2024" |
| Juros proporcionais | Taxa ÷ dias do mês × dias, com 6 casas; a troca de regime corta o mês em 30/08/2024 | Res. CMN 5.171/2024 |
| Juros sobre | Valor corrigido × soma das taxas (juros simples sobre o valor atualizado) | Prática judicial; validar (P-047) |
| Fator de correção | Produto sem arredondar; dinheiro arredondado só no fim (meio para cima) | Prompt 8. A Calculadora mostra o fator com 7 casas (P-046) |

## Casos e resultados (em centavos)

| Caso | Corrigido | Juros | Total |
|---|---|---|---|
| A. 12.345,67 de 10/03/2023 a 20/07/2024 (inteiro antes da lei) | 1.298.602 | 211.965 | 1.510.567 |
| B. 50.000,00 de 05/10/2024 a 20/06/2025, juros desde a citação em 12/11/2024 (inteiro depois) | 5.213.162 | 174.358 | 5.387.520 |
| C. 100.000,00 de 15/05/2023 a 10/02/2026 (atravessa a lei: dois trechos, troca em 30/08/2024) | 11.098.292 | 3.075.938 | 14.174.230 |

**Art. 523.** Base: 20.000,00 de 01/10/2024 a 02/06/2025. Intimação em 10/03/2025; o prazo de 15 dias úteis vence em 31/03/2025.

| Situação | Multa | Honorários | Total |
|---|---|---|---|
| Sem pagamento | 216.294 | 216.294 | 2.595.523 |
| Pagou 5.000,00 em 20/03/2025, dentro do prazo (multa e honorários sobre o restante) | 165.188 | 165.188 | 1.982.252 |
| Pagou 5.000,00 em 15/04/2025, fora do prazo (multa sobre o débito integral, P-045) | 216.294 | 216.294 | 2.088.052 |

---

# Conferência trabalhista (Prompt 8B)

A planilha de conferência do escritório para rescisão ainda não existe (PENDENCIA P-004). Enquanto isso:

- **`conferencia-trabalhista.xlsx`**: planilha com fórmulas próprias, sem usar o código do LAW. O gerador é `planilha_trabalhista.py`. Os valores foram recalculados no LibreOffice em 10/11/2026 e batem com o motor centavo a centavo.
- **Calculadora do Cidadão**: IPCA-E de 05/2022 a 02/2023 = 1,02855190 (R$ 10.000,00 → R$ 10.285,52). O IPCA e a Taxa Legal desde 30/08/2024 são os mesmos números da conferência do 8A.

## Aba "Rescisao": dispensa sem justa causa com aviso indenizado

Dados do exemplo:
- Admissão em 10/03/2021 e saída em 18/09/2025.
- Salário de R$ 3.250,00 e médias de R$ 412,37.
- 1 período de férias vencido.
- Saldo do FGTS de R$ 14.380,52.

| Verba | Regra | Valor |
|---|---|---|
| Saldo de salário | 18 dias × 3.250,00 ÷ 30 | 1.950,00 |
| Aviso prévio indenizado | 4 anos → 42 dias; 3.662,37 ÷ 30 × 42; projeção até 30/10/2025 | 5.127,32 |
| 13º proporcional | 10/12 (outubro com 30 dias pela projeção) | 3.051,98 |
| Férias vencidas | 1 período × 3.662,37 | 3.662,37 |
| 1/3 sobre férias vencidas | | 1.220,79 |
| Férias proporcionais | 8/12 (de 10/03/2025 a 30/10/2025) | 2.441,58 |
| 1/3 sobre férias proporcionais | | 813,86 |
| FGTS do mês da rescisão | 8% de (saldo + aviso + 13º) = 8% de 10.129,30 | 810,34 |
| Multa de 40% do FGTS | 40% de (14.380,52 + 810,34) | 6.076,34 |
| **Total** | | **25.154,58** |

## Aba "Tres_fases": verba de R$ 10.000,00 vencida em 05/05/2022

Ação ajuizada em 15/03/2023; cálculo até 10/02/2026.

| Trecho | Período | Regra |
|---|---|---|
| 1 | 05/05/2022 a 14/03/2023 | IPCA-E + juros do art. 39, caput, da Lei 8.177/1991 (TR) |
| 2 | 15/03/2023 a 29/08/2024 | Só a Selic: entra no fator, em soma simples, sem juros à parte |
| 3 | 30/08/2024 a 09/02/2026 | IPCA + Taxa Legal |

Fator de correção = 1,2823843905. Juros = 14,015717% (TR + Taxa Legal). Resultado: principal corrigido de R$ 12.823,84, juros de R$ 1.797,35 e **total de R$ 14.621,19**.

Convenções que a planilha também segue:
- No mês do ajuizamento (março/2023), o mês é repartido por dias: 14/31 do IPCA-E (fator exponencial) e 17/31 da Selic (6 casas).
- Os juros da TR também são proporcionais (14/31).
- Um mês sem Selic segue a regra mensal do 8A: o índice inteiro do regime do 1º dia contado.
