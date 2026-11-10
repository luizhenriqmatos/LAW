"""
Conferência INDEPENDENTE do motor de cálculo (Prompt 8): refaz as contas em Python (decimal), sem usar o código do LAW.
Uso:  python3 docs/conferencia/conferir.py
Lê os mesmos índices do SGS que o banco recebeu na carga inicial (tests/fixtures/indices-sgs-2026-11-09.json).
Os números que imprime são os esperados em tests/calculos.test.ts.
"""
import calendar, datetime as dt, json, pathlib
from collections import Counter
from decimal import Decimal as D, ROUND_HALF_UP, getcontext

getcontext().prec = 50
RAIZ = pathlib.Path(__file__).resolve().parents[2]
IDX = json.loads((RAIZ / "tests/fixtures/indices-sgs-2026-11-09.json").read_text())["valores"]

def fator(serie, de, ate):  # meses AAAA-MM, inclusive (igual à Calculadora do Cidadão)
    f = D(1)
    for mes, v in IDX[serie].items():
        if de <= mes <= ate:
            f *= 1 + D(v) / 100
    return f

def seis(x): return x.quantize(D("0.000001"), ROUND_HALF_UP)
def cent(x): return int(x.quantize(D(1), ROUND_HALF_UP))

def juros(de, ate, taxa):  # [de, ate): dia inicial conta, final não; pro rata com 6 casas
    a, b = dt.date.fromisoformat(de), dt.date.fromisoformat(ate)
    dias = Counter()
    while a < b:
        dias[(a.year, a.month)] += 1
        a += dt.timedelta(1)
    soma = D(0)
    for (y, m), n in sorted(dias.items()):
        nd = calendar.monthrange(y, m)[1]
        t = taxa(y, m)
        soma += t if n == nd else seis(t * n / nd)
    return soma

um = lambda y, m: D(1)
tl = lambda y, m: D(IDX["TAXA_LEGAL"][f"{y}-{m:02d}"])

def caso(nome, valor, F, J):
    c = valor * F
    print(f"{nome}: fator {F:.10f} | juros {J:.6f}% | corrigido {cent(c)} | juros {cent(c * J / 100)} | total {cent(c) + cent(c * J / 100)} (centavos)")
    return c, c * J / 100

caso("A antes da lei", 1234567, fator("INPC", "2023-03", "2024-06"), juros("2023-03-10", "2024-07-20", um))
caso("B depois da lei", 5000000, fator("IPCA", "2024-10", "2025-05"), juros("2024-11-12", "2025-06-20", tl))
caso("C atravessando", 10000000, fator("INPC", "2023-05", "2024-08") * fator("IPCA", "2024-09", "2026-01"),
     juros("2023-05-15", "2024-08-30", um) + juros("2024-08-30", "2026-02-10", tl))

# Art. 523: R$ 20.000,00 de 01/10/2024 a 02/06/2025; intimação 10/03/2025 → prazo até 31/03/2025 (só fins de semana).
C1, J1 = caso("523 base", 2000000, fator("IPCA", "2024-10", "2025-05"), juros("2024-10-01", "2025-06-02", tl))
print("523 sem pagamento: multa = honorários =", cent((cent(C1) + cent(J1)) * D("0.1")))
for data, no_prazo in [("2025-03-20", True), ("2025-04-15", False)]:
    anterior = (dt.date.fromisoformat(data[:7] + "-01") - dt.timedelta(1)).strftime("%Y-%m")
    devido = 2000000 * fator("IPCA", "2024-10", anterior) * (1 + juros("2024-10-01", data, tl) / 100)
    resto = 1 - D(500000) / devido
    saldo = cent(C1 * resto) + cent(J1 * resto)
    base = saldo if no_prazo else cent(C1) + cent(J1)
    print(f"523 pagamento de R$ 5.000,00 em {data}: saldo {saldo}, multa {cent(base * D('0.1'))}, total {saldo + 2 * cent(base * D('0.1'))}")
