"""
Gera docs/conferencia/conferencia-trabalhista.xlsx: planilha de conferência do Prompt 8B com FÓRMULAS próprias
(independentes do código do LAW). Aba 1: rescisão sem justa causa de exemplo. Aba 2: uma verba vencida em 2022,
ação ajuizada em 2023, cálculo em 2026 (três fases). Índices: SGS do Banco Central coletados em 09/11/2026.
Uso: python3 docs/conferencia/planilha_trabalhista.py  (depois abra no Excel/LibreOffice: as fórmulas calculam sozinhas)
"""
import calendar, datetime as dt, json, pathlib
from openpyxl import Workbook
from openpyxl.styles import Font

RAIZ = pathlib.Path(__file__).resolve().parents[2]
IDX = json.loads((RAIZ / "tests/fixtures/indices-sgs-2026-11-09.json").read_text())["valores"]
wb = Workbook()
B = Font(bold=True)

# ---------------- Aba 1: rescisão ----------------
ws = wb.active
ws.title = "Rescisao"
entradas = [
    ("Admissão", dt.date(2021, 3, 10)), ("Saída (comunicação da dispensa)", dt.date(2025, 9, 18)),
    ("Tipo", "Dispensa sem justa causa, aviso indenizado"), ("Último salário", 3250.00), ("Médias de variáveis", 412.37),
    ("Férias vencidas (períodos)", 1), ("Desses, em dobro", 0), ("Saldo do FGTS para fins rescisórios", 14380.52),
]
ws["A1"] = "ENTRADAS"; ws["A1"].font = B
for i, (r, v) in enumerate(entradas, start=2):
    ws[f"A{i}"], ws[f"B{i}"] = r, v
    if isinstance(v, dt.date): ws[f"B{i}"].number_format = "DD/MM/YYYY"
ws["A11"] = "APOIO"; ws["A11"].font = B
apoio = [
    ("Remuneração (salário + médias)", "=B5+B6"),
    ("Anos completos de serviço", '=DATEDIF(B2,B3+1,"y")'),
    ("Dias de aviso (30 + 3 por ano, até 90)", "=MIN(30+3*B13,90)"),
    ("Data projetada (saída + dias de aviso)", "=B3+B14"),
    ("Dias trabalhados no mês da saída", "=B3-MAX(B2,DATE(YEAR(B3),MONTH(B3),1))+1"),
    ("Mês da saída inteiro?", "=AND(B2<=DATE(YEAR(B3),MONTH(B3),1),B16=DAY(EOMONTH(B3,0)))"),
    ("Avos de 13º (admissão antes do ano; projeção no mesmo ano)", "=MONTH(B15)-1+IF(DAY(B15)>=15,1,0)"),
    ("Início do período aquisitivo", '=EDATE(B2,12*DATEDIF(B2,B3,"y"))'),
    ("Avos de férias proporcionais", '=DATEDIF(B19,B15+1,"m")+IF((B15+1)-EDATE(B19,DATEDIF(B19,B15+1,"m"))>=15,1,0)'),
]
for i, (r, f) in enumerate(apoio, start=12):
    ws[f"A{i}"], ws[f"B{i}"] = r, f
ws["B15"].number_format = ws["B19"].number_format = "DD/MM/YYYY"
ws["A22"] = "VERBAS"; ws["A22"].font = B
verbas = [
    ("Saldo de salário", "=ROUND(IF(B17,B5,B5/30*B16),2)"),
    ("Aviso prévio indenizado", "=ROUND(B12/30*B14,2)"),
    ("13º salário proporcional", "=ROUND(B12*B18/12,2)"),
    ("Férias vencidas", "=ROUND(B12*(B7-B8+2*B8),2)"),
    ("1/3 sobre férias vencidas", "=ROUND(B12*(B7-B8+2*B8)/3,2)"),
    ("Férias proporcionais", "=ROUND(B12*B20/12,2)"),
    ("1/3 sobre férias proporcionais", "=ROUND(B12*B20/12/3,2)"),
    ("FGTS do mês da rescisão (8% de saldo + aviso + 13º)", "=ROUND(0.08*(B23+B24+B25),2)"),
    ("Multa de 40% do FGTS (saldo + FGTS do mês)", "=ROUND(0.4*(B9+B30),2)"),
]
for i, (r, f) in enumerate(verbas, start=23):
    ws[f"A{i}"], ws[f"B{i}"] = r, f
ws["A32"], ws["B32"] = "TOTAL DAS VERBAS", "=SUM(B23:B31)"
ws["A32"].font = ws["B32"].font = B
ws.column_dimensions["A"].width = 62; ws.column_dimensions["B"].width = 18

# ---------------- Aba 2: atualização em três fases ----------------
w2 = wb.create_sheet("Tres_fases")
w2["A1"], w2["B1"] = "Valor da verba", 10000.00
w2["A2"], w2["B2"] = "Vencimento", dt.date(2022, 5, 5)
w2["A3"], w2["B3"] = "Ajuizamento", dt.date(2023, 3, 15)
w2["A4"], w2["B4"] = "Data final (não contada)", dt.date(2026, 2, 10)
w2["A5"], w2["B5"] = "Lei 14.905 (30/08/2024)", dt.date(2024, 8, 30)
for c in ("B2", "B3", "B4", "B5"): w2[c].number_format = "DD/MM/YYYY"
cab = ["Mês (1º dia)", "Dias do mês", "Dias pré-judicial", "Dias Selic", "Dias pós-30/08/2024", "IPCA-E %", "TR %", "Selic %", "IPCA %", "Taxa Legal %",
       "Fator IPCA-E", "Selic do mês (pro rata)", "Fator IPCA", "Juros TR % (pro rata)", "Juros TL % (pro rata)"]
for j, c in enumerate(cab): w2.cell(row=7, column=j + 1, value=c).font = B
mes, linha = dt.date(2022, 5, 1), 8
while mes <= dt.date(2026, 2, 1):
    k = f"{mes.year}-{mes.month:02d}"
    r = linha
    w2[f"A{r}"] = mes; w2[f"A{r}"].number_format = "MM/YYYY"
    w2[f"B{r}"] = f"=DAY(EOMONTH(A{r},0))"
    fim = f"(EOMONTH(A{r},0)+1)"
    # dias do mês dentro de cada fase: interseção de [A, fim) com [ini, fim_fase)
    w2[f"C{r}"] = f"=MAX(0,MIN({fim},$B$3)-MAX(A{r},$B$2))"
    w2[f"D{r}"] = f"=MAX(0,MIN({fim},$B$5,$B$4)-MAX(A{r},$B$3))"
    w2[f"E{r}"] = f"=MAX(0,MIN({fim},$B$4)-MAX(A{r},$B$5,$B$3))"
    for col, s in zip("FGHIJ", ["IPCA_E", "TR", "SELIC", "IPCA", "TAXA_LEGAL"]):
        w2[f"{col}{r}"] = float(IDX[s].get(k, 0))
    # Correção: meses só com índice mensal contam por inteiro, exceto o mês da data final; o mês que tem Selic é repartido por dias.
    w2[f"K{r}"] = f"=IF(D{r}>0,(1+F{r}/100)^(C{r}/B{r}),IF(AND(C{r}>0,A{r}<DATE(YEAR($B$4),MONTH($B$4),1)),1+F{r}/100,1))"
    w2[f"L{r}"] = f"=IF(D{r}=0,0,IF(D{r}=B{r},H{r},ROUND(H{r}*D{r}/B{r},6)))"
    w2[f"M{r}"] = f"=IF(D{r}>0,(1+I{r}/100)^(E{r}/B{r}),IF(AND(E{r}>0,C{r}=0,A{r}<DATE(YEAR($B$4),MONTH($B$4),1)),1+I{r}/100,1))"
    w2[f"N{r}"] = f"=IF(C{r}=0,0,IF(C{r}=B{r},G{r},ROUND(G{r}*C{r}/B{r},6)))"
    w2[f"O{r}"] = f"=IF(E{r}=0,0,IF(E{r}=B{r},J{r},ROUND(J{r}*E{r}/B{r},6)))"
    linha += 1
    mes = (mes.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
u = linha - 1
res = [
    ("Fator de correção = IPCA-E × (1 + Selic somada) × IPCA", f"=PRODUCT(K8:K{u})*(1+SUM(L8:L{u})/100)*PRODUCT(M8:M{u})"),
    ("Juros % = TR + Taxa Legal (somas simples)", f"=SUM(N8:N{u})+SUM(O8:O{u})"),
    ("Principal corrigido", f"=ROUND($B$1*B{u+3},2)"),
    ("Juros de mora", f"=ROUND($B$1*B{u+3}*B{u+4}/100,2)"),
    ("Total", f"=B{u+5}+B{u+6}"),
]
for i, (r, f) in enumerate(res, start=u + 3):
    w2[f"A{i}"], w2[f"B{i}"] = r, f
    w2[f"A{i}"].font = B
w2.column_dimensions["A"].width = 52
wb.save(RAIZ / "docs/conferencia/conferencia-trabalhista.xlsx")
print("ok", u)
