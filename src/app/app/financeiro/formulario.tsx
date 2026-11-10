"use client";

import { useActionState, useMemo, useState } from "react";
import { BotaoEnviar, Campo, Mensagem } from "@/components/formulario";
import { paraCentavos, formatarCentavos } from "@/lib/dinheiro";
import { dividirEmParcelas, MAX_PARCELAS, vencimentosMensais } from "@/lib/financeiro/parcelas";
import { CATEGORIAS, TIPOS } from "@/lib/financeiro/rotulos";
import { criarLancamento } from "./actions";

type Opcoes = { clientes: { id: string; nome: string }[]; processos: { id: string; numero_cnj: string; titulo: string | null }[] };

const selecao = "h-10 w-full rounded-xl border border-border bg-white px-3 text-sm";
const dataBr = (d: string) => d.split("-").reverse().join("/");

export function FormularioLancamento({ opcoes, hoje }: { opcoes: Opcoes; hoje: string }) {
  const [estado, acao] = useActionState(criarLancamento, undefined);
  const [tipo, setTipo] = useState("receita");
  const [valor, setValor] = useState("");
  const [n, setN] = useState(1);
  const [primeiro, setPrimeiro] = useState(hoje);

  // Prévia: a mesma conta que o banco faz (sobra de centavos na primeira parcela).
  const previa = useMemo(() => {
    const c = paraCentavos(valor);
    if (!c || c <= 0 || !Number.isInteger(n) || n < 1 || n > MAX_PARCELAS || c < n || !/^\d{4}-\d{2}-\d{2}$/.test(primeiro)) return null;
    const v = dividirEmParcelas(c, n);
    const d = vencimentosMensais(primeiro, n);
    return v.map((x, i) => ({ numero: i + 1, valor: x, vencimento: d[i] }));
  }, [valor, n, primeiro]);

  return (
    <form action={acao} className="mt-6 grid gap-4 rounded-[26px] bg-white p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm font-medium">Tipo
          <select name="tipo" value={tipo} onChange={(e) => setTipo(e.target.value)} className={selecao}>
            {Object.entries(TIPOS).map(([k, r]) => <option key={k} value={k}>{r}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">Categoria
          <select name="categoria" defaultValue="honorarios_contratuais" className={selecao}>
            {Object.entries(CATEGORIAS).map(([k, r]) => <option key={k} value={k}>{r}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">Cliente {tipo === "receita" ? "(obrigatório)" : "(opcional)"}
          <select name="cliente" defaultValue="" required={tipo === "receita"} className={selecao}>
            <option value="">— escolha —</option>
            {opcoes.clientes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">Processo (opcional)
          <select name="processo" defaultValue="" className={selecao}>
            <option value="">— nenhum —</option>
            {opcoes.processos.map((p) => <option key={p.id} value={p.id}>{p.numero_cnj}{p.titulo ? ` — ${p.titulo}` : ""}</option>)}
          </select>
        </label>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">Só aparecem clientes e processos já confirmados na triagem.</p>
      <Campo rotulo="Descrição" nome="descricao" required minLength={2} maxLength={200} placeholder="Honorários contratuais — ação de alimentos" />
      <div className="grid gap-4 sm:grid-cols-4">
        <Campo rotulo="Valor total (R$)" nome="valor" required inputMode="decimal" placeholder="1.000,00" value={valor} onChange={(e) => setValor(e.target.value)} />
        <Campo rotulo="Nº de parcelas" nome="parcelas" type="number" min={1} max={MAX_PARCELAS} required value={n} onChange={(e) => setN(Number(e.target.value))} />
        <Campo rotulo="1º vencimento" nome="primeiro_vencimento" type="date" required value={primeiro} onChange={(e) => setPrimeiro(e.target.value)} />
        <Campo rotulo="Competência" nome="competencia" type="date" defaultValue={hoje} ajuda="Mês a que o valor pertence." />
      </div>

      {previa ? (
        <div className="rounded-2xl bg-muted/60 p-4 text-sm" aria-live="polite">
          <p className="font-semibold">Prévia das parcelas</p>
          <ul className="mt-2 grid gap-1">
            {previa.slice(0, 12).map((p) => (
              <li key={p.numero} className="flex justify-between"><span>{p.numero}/{previa.length} — vence {dataBr(p.vencimento)}</span><span className="font-medium">{formatarCentavos(p.valor)}</span></li>
            ))}
            {previa.length > 12 ? <li className="text-muted-foreground">… e mais {previa.length - 12} parcela(s)</li> : null}
          </ul>
          {previa.length > 1 && previa[0].valor !== previa[1].valor ? (
            <p className="mt-2 text-xs text-muted-foreground">O valor não divide exato: a diferença de centavos fica na primeira parcela.</p>
          ) : null}
        </div>
      ) : null}

      <Mensagem estado={estado} />
      <div><BotaoEnviar>Criar lançamento</BotaoEnviar></div>
    </form>
  );
}
