"use client";

import Link from "next/link";
import { useState } from "react";
import { useFormStatus } from "react-dom";
import { formularioDoRascunho } from "@/lib/assistente/formulario";
import { formatarCentavos, paraCentavos } from "@/lib/dinheiro";
import { dividirEmParcelas, vencimentosMensais } from "@/lib/financeiro/parcelas";
import { CATEGORIAS, TIPOS } from "@/lib/financeiro/rotulos";
import { cn } from "@/lib/utils";

export type RascunhoTela = {
  id: string;
  tipo: "lancamento" | "tarefa" | "prazo" | "minuta";
  dados: Record<string, unknown>;
  resumo: string;
  avisos: string[];
  status: "pendente" | "confirmado" | "descartado";
  vencido: boolean;
  linkResultado: string | null;
};

export type OpcoesCartao = {
  equipe: { id: string; nome: string; prazos: boolean; tarefas: boolean }[];
  colunas: { id: string; nome: string }[];
  clientes: { id: string; nome: string }[];
  processos: { id: string; numero: string }[];
};

const TITULO: Record<RascunhoTela["tipo"], string> = {
  lancamento: "Rascunho de lançamento financeiro",
  tarefa: "Rascunho de tarefa",
  prazo: "Rascunho de prazo",
  minuta: "Rascunho de minuta de contrato",
};

const campo = "w-full rounded-xl border bg-white px-3 py-2 text-sm";
const br = (iso: unknown) => (typeof iso === "string" && iso ? iso.split("-").reverse().join("/") : "—");
const txt = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function Botao({ children, className }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={cn("h-9 rounded-full px-4 text-sm font-medium disabled:opacity-60", className)}>
      {pending ? "Aguarde…" : children}
    </button>
  );
}

function Rotulo({ nome, children }: { nome: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{nome}</span>
      {children}
    </label>
  );
}

function Linha({ nome, valor }: { nome: string; valor: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-40 shrink-0 text-muted-foreground">{nome}</dt>
      <dd className="font-medium">{valor || "—"}</dd>
    </div>
  );
}

/** Valores iniciais do formulário, a partir do que a Lia preparou. */
const iniciais = (r: RascunhoTela) => formularioDoRascunho(r.tipo, r.dados);

// PENDENCIA P-070: dias/data do prazo e processo/cliente da tarefa não são editáveis no cartão (descartar e pedir de novo).
/** Campos que o cartão mostra como editáveis em cada tipo (o resto vai escondido, igual ao rascunho). */
function Editor({ r, v, mudar, opcoes }: { r: RascunhoTela; v: Record<string, string>; mudar: (k: string, x: string) => void; opcoes: OpcoesCartao }) {
  const ex = (r.dados._exibir ?? {}) as Record<string, unknown>;
  const input = (k: string, props: React.ComponentProps<"input"> = {}) => (
    <input name={k} value={v[k] ?? ""} onChange={(e) => mudar(k, e.target.value)} className={campo} {...props} />
  );
  if (r.tipo === "lancamento") {
    const candidatos = (ex.candidatos_cliente ?? []) as { id: string; nome: string }[];
    const clientes = [...candidatos, ...opcoes.clientes.filter((c) => !candidatos.some((x) => x.id === c.id))];
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Rotulo nome="Tipo"><select name="tipo" value={v.tipo} onChange={(e) => mudar("tipo", e.target.value)} className={campo}>{Object.entries(TIPOS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Rotulo>
        <Rotulo nome="Categoria"><select name="categoria" value={v.categoria} onChange={(e) => mudar("categoria", e.target.value)} className={campo}>{Object.entries(CATEGORIAS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Rotulo>
        <div className="sm:col-span-2"><Rotulo nome="Descrição">{input("descricao", { maxLength: 200 })}</Rotulo></div>
        <Rotulo nome="Cliente">
          <select name="cliente_id" value={v.cliente_id} onChange={(e) => mudar("cliente_id", e.target.value)} className={campo}>
            <option value="">Escolha o cliente</option>
            {clientes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </Rotulo>
        <Rotulo nome="Processo (opcional)">
          <select name="processo_id" value={v.processo_id} onChange={(e) => mudar("processo_id", e.target.value)} className={campo}>
            <option value="">Nenhum</option>
            {opcoes.processos.map((p) => <option key={p.id} value={p.id}>{p.numero}</option>)}
          </select>
        </Rotulo>
        <Rotulo nome="Valor TOTAL (R$)">{input("valor_total", { inputMode: "decimal" })}</Rotulo>
        <Rotulo nome="Parcelas">{input("parcelas", { type: "number", min: 1, max: 120 })}</Rotulo>
        <Rotulo nome="1º vencimento">{input("primeiro_vencimento", { type: "date" })}</Rotulo>
        <Rotulo nome="Competência (opcional)">{input("data_competencia", { type: "date" })}</Rotulo>
      </div>
    );
  }
  if (r.tipo === "tarefa") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Rotulo nome="Título">{input("titulo", { maxLength: 160 })}</Rotulo></div>
        <div className="sm:col-span-2"><Rotulo nome="Descrição"><textarea name="descricao" value={v.descricao} onChange={(e) => mudar("descricao", e.target.value)} rows={3} className={campo} /></Rotulo></div>
        <Rotulo nome="Data">{input("data", { type: "date" })}</Rotulo>
        <Rotulo nome="Responsável"><select name="responsavel_id" value={v.responsavel_id} onChange={(e) => mudar("responsavel_id", e.target.value)} className={campo}><option value="">Ninguém</option>{opcoes.equipe.filter((m) => m.tarefas).map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}</select></Rotulo>
        <Rotulo nome="Coluna"><select name="coluna_id" value={v.coluna_id} onChange={(e) => mudar("coluna_id", e.target.value)} className={campo}>{opcoes.colunas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Rotulo>
        <Rotulo nome="Etiquetas (separe por vírgula)">{input("etiquetas", { maxLength: 400 })}</Rotulo>
        <input type="hidden" name="processo_id" value={v.processo_id} />
        <input type="hidden" name="cliente_id" value={v.cliente_id} />
      </div>
    );
  }
  if (r.tipo === "prazo") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Rotulo nome="Descrição">{input("descricao", { maxLength: 200 })}</Rotulo></div>
        <Rotulo nome="Responsável"><select name="responsavel_id" value={v.responsavel_id} onChange={(e) => mudar("responsavel_id", e.target.value)} className={campo}>{opcoes.equipe.filter((m) => m.prazos).map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}</select></Rotulo>
        <input type="hidden" name="esperada" value={v.esperada} />
        <p className="text-xs text-muted-foreground sm:col-span-2">Dias, tipo de contagem e data da publicação não mudam aqui (mudam a data final). Para mudá-los, descarte e peça de novo, ou use a tela Prazos.</p>
      </div>
    );
  }
  const manuais = (ex.campos_manuais ?? []) as string[];
  return (
    <div className="grid gap-3">
      <Rotulo nome="Título da minuta">{input("titulo", { maxLength: 200 })}</Rotulo>
      {manuais.map((c) => <Rotulo key={c} nome={`Campo {{${c}}}`}>{input(`campo_${c}`, { maxLength: 2000 })}</Rotulo>)}
      <p className="text-xs text-muted-foreground">O texto final é montado pelo LAW a partir do modelo quando você confirma. Dados do cliente e do processo vêm do cadastro.</p>
    </div>
  );
}

function Visao({ r, v, opcoes }: { r: RascunhoTela; v: Record<string, string>; opcoes: OpcoesCartao }) {
  const ex = (r.dados._exibir ?? {}) as Record<string, unknown>;
  const membro = (id: string) => opcoes.equipe.find((m) => m.id === id)?.nome;
  if (r.tipo === "lancamento") {
    const total = paraCentavos(v.valor_total ?? "") ?? 0;
    const n = Number(v.parcelas);
    let parcelas: { valor: number; venc: string }[] = [];
    try {
      const valores = dividirEmParcelas(total, n);
      const venc = vencimentosMensais(v.primeiro_vencimento, n);
      parcelas = valores.map((valor, i) => ({ valor, venc: venc[i] }));
    } catch { /* valores inválidos: o servidor recusa no Confirmar */ }
    const candidatos = (ex.candidatos_cliente ?? []) as { id: string; nome: string }[];
    const nomeCliente = [...candidatos, ...opcoes.clientes].find((c) => c.id === v.cliente_id)?.nome ?? (v.cliente_id ? String(ex.cliente_nome ?? "") : "");
    return (
      <dl className="grid gap-1">
        <Linha nome="Tipo" valor={`${TIPOS[v.tipo as keyof typeof TIPOS] ?? v.tipo} · ${CATEGORIAS[v.categoria as keyof typeof CATEGORIAS] ?? v.categoria}`} />
        <Linha nome="Descrição" valor={v.descricao} />
        <Linha nome="Cliente" valor={nomeCliente || <span className="text-red-700">escolha em Editar</span>} />
        <Linha nome="Processo" valor={opcoes.processos.find((p) => p.id === v.processo_id)?.numero ?? (v.processo_id ? String(ex.processo_numero ?? "") : "")} />
        <Linha nome="Total" valor={formatarCentavos(total)} />
        <div className="mt-2 overflow-hidden rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left"><tr><th className="px-3 py-1.5">Parcela</th><th className="px-3 py-1.5">Vencimento</th><th className="px-3 py-1.5 text-right">Valor</th></tr></thead>
            <tbody>{parcelas.map((p, i) => <tr key={i} className="border-t"><td className="px-3 py-1.5">{i + 1}ª</td><td className="px-3 py-1.5">{br(p.venc)}</td><td className="px-3 py-1.5 text-right">{formatarCentavos(p.valor)}</td></tr>)}</tbody>
          </table>
        </div>
      </dl>
    );
  }
  if (r.tipo === "tarefa") {
    return (
      <dl className="grid gap-1">
        <Linha nome="Título" valor={v.titulo} />
        {v.descricao ? <Linha nome="Descrição" valor={v.descricao} /> : null}
        <Linha nome="Data" valor={br(v.data)} />
        <Linha nome="Responsável" valor={membro(v.responsavel_id) ?? String(ex.responsavel_nome ?? "")} />
        <Linha nome="Coluna" valor={opcoes.colunas.find((c) => c.id === v.coluna_id)?.nome ?? String(ex.coluna_nome ?? "")} />
        {ex.processo_numero ? <Linha nome="Processo" valor={String(ex.processo_numero)} /> : null}
        {ex.cliente_nome ? <Linha nome="Cliente" valor={String(ex.cliente_nome)} /> : null}
        {v.etiquetas ? <Linha nome="Etiquetas" valor={v.etiquetas} /> : null}
      </dl>
    );
  }
  if (r.tipo === "prazo") {
    const passos = (ex.passos ?? []) as { rotulo: string; data: string | null; explicacao: string }[];
    return (
      <dl className="grid gap-1">
        <Linha nome="Processo" valor={String(ex.processo_numero ?? "")} />
        <Linha nome="Descrição" valor={v.descricao} />
        <Linha nome="Contagem" valor={`${txt(r.dados.dias)} dias ${r.dados.tipo_contagem === "corrido" ? "corridos" : "úteis"}`} />
        <Linha nome="Vence em" valor={<span className="text-base">{br(r.dados.data_final)}</span>} />
        <Linha nome="Responsável" valor={membro(v.responsavel_id) ?? String(ex.responsavel_nome ?? "")} />
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-muted-foreground">Passo a passo da contagem (feita pelo LAW, não pela IA)</summary>
          <ol className="mt-2 grid gap-1 pl-4">{passos.map((p, i) => <li key={i}><strong>{p.rotulo}</strong>{p.data ? ` — ${br(p.data)}` : ""}: {p.explicacao}</li>)}</ol>
        </details>
      </dl>
    );
  }
  return (
    <dl className="grid gap-1">
      <Linha nome="Modelo" valor={String(ex.modelo_nome ?? "")} />
      <Linha nome="Título" valor={v.titulo} />
      {ex.cliente_nome ? <Linha nome="Cliente" valor={String(ex.cliente_nome)} /> : null}
      {ex.processo_numero ? <Linha nome="Processo" valor={String(ex.processo_numero)} /> : null}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Prévia do texto</summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-muted/50 p-3 font-sans text-[13px]">{String(ex.previa ?? "")}</pre>
      </details>
    </dl>
  );
}

export function CartaoRascunho({ r, opcoes, confirmar, descartar }: { r: RascunhoTela; opcoes: OpcoesCartao; confirmar: (f: FormData) => void; descartar: () => void }) {
  const [editando, setEditando] = useState(false);
  const [v, setV] = useState<Record<string, string>>(() => iniciais(r));
  const mudar = (k: string, x: string) => setV((a) => ({ ...a, [k]: x }));
  const aberto = r.status === "pendente" && !r.vencido;

  return (
    <section className={cn("rounded-2xl border-2 p-4", aberto ? "border-primary/40 bg-white" : "border-transparent bg-white/60")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{TITULO[r.tipo]}</h3>
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium",
          r.status === "confirmado" ? "bg-emerald-50 text-emerald-800" : r.status === "descartado" || r.vencido ? "bg-neutral-100 text-neutral-600" : "bg-amber-100 text-amber-900")}>
          {r.status === "confirmado" ? "Confirmado e gravado" : r.status === "descartado" ? "Descartado" : r.vencido ? "Vencido (peça de novo)" : "Aguardando você — nada foi gravado"}
        </span>
      </div>
      {r.avisos.length ? <ul className="mt-2 grid gap-1 text-sm text-amber-900">{r.avisos.map((a, i) => <li key={i}>⚠ {a}</li>)}</ul> : null}

      <form action={confirmar} className="mt-3 grid gap-3">
        {editando && aberto ? <Editor r={r} v={v} mudar={mudar} opcoes={opcoes} /> : (
          <>
            <Visao r={r} v={v} opcoes={opcoes} />
            {Object.entries(v).map(([k, x]) => <input key={k} type="hidden" name={k} value={x} />)}
          </>
        )}
        {aberto ? (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            <Botao className="bg-primary text-primary-foreground">Confirmar e gravar</Botao>
            <button type="button" onClick={() => setEditando((e) => !e)} className="h-9 rounded-full bg-muted px-4 text-sm font-medium hover:bg-muted/70">
              {editando ? "Ver resumo" : "Editar"}
            </button>
            <button type="submit" formAction={descartar} formNoValidate className="h-9 rounded-full px-4 text-sm font-medium text-red-700 hover:bg-red-50">Descartar</button>
          </div>
        ) : r.status === "confirmado" && r.linkResultado ? (
          <p className="text-sm"><Link href={r.linkResultado} className="font-medium text-primary underline">Abrir o que foi gravado</Link></p>
        ) : null}
      </form>
    </section>
  );
}
