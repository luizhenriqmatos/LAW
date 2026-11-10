"use client";

import { useActionState, useState } from "react";
import { BotaoEnviar, Campo, Mensagem } from "@/components/formulario";
import { INDICES_CORRECAO, NOMES_JUROS, NOMES_SERIE, TIPOS_JUROS } from "@/lib/calculos/base";
import type { RegimeLinha } from "@/lib/calculos/servidor";
import { criarRegime, novaVersaoRegime } from "../actions";

const selecao = "h-10 w-full rounded-xl border border-border bg-white px-3 text-sm";
const MARCOS = { ajuizamento: "ajuizamento", citacao: "citação", transito_em_julgado: "trânsito em julgado", expedicao_requisitorio: "expedição do requisitório" };
const ESCOPOS = { civel: "Cível", trabalhista: "Trabalhista", fazenda_pre_expedicao: "Fazenda Pública (antes da expedição)", fazenda_pos_expedicao: "Fazenda Pública (depois da expedição)" };

/** Cria regime personalizado ou nova versão de um existente (o antigo nunca muda). */
export function FormularioRegime({ base }: { base?: RegimeLinha }) {
  const [estado, acao] = useActionState(base ? novaVersaoRegime : criarRegime, undefined);
  const [juros, setJuros] = useState(base?.juros_tipo ?? "percentual_ao_mes");
  const [indice, setIndice] = useState(base?.correcao_indice ?? "IPCA");
  const precisaValor = juros === "percentual_ao_mes" || juros === "percentual_fixo_ao_ano_simples";
  return (
    <form action={acao} className="grid gap-4">
      {base ? <input type="hidden" name="regime_id" value={base.id} /> : null}
      <Campo rotulo="Nome" nome="nome" required minLength={3} maxLength={120} defaultValue={base?.nome} placeholder="Ex.: Sentença proc. 0001234 — IPCA-E + 0,5% a.m." />
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="grid gap-1.5 text-sm font-medium">Escopo
          <select name="escopo" defaultValue={base?.escopo ?? "civel"} className={selecao}>
            {Object.entries(ESCOPOS).map(([k, r]) => <option key={k} value={k}>{r}</option>)}
          </select>
        </label>
        <Campo rotulo="Vale desde (opcional)" nome="vigencia_inicio" type="date" defaultValue={base?.vigencia_inicio ?? ""} ajuda="Vazio = sem início." />
        <Campo rotulo="Vale até (opcional)" nome="vigencia_fim" type="date" defaultValue={base?.vigencia_fim ?? ""} ajuda="Vazio = até hoje." />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm font-medium">Começa num marco do processo (opcional)
          <select name="inicio_no_marco" defaultValue={base?.inicio_no_marco ?? ""} className={selecao}>
            <option value="">— não —</option>
            {Object.entries(MARCOS).map(([k, r]) => <option key={k} value={k}>A partir do(a) {r}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">Termina num marco do processo (opcional)
          <select name="fim_no_marco" defaultValue={base?.fim_no_marco ?? ""} className={selecao}>
            <option value="">— não —</option>
            {Object.entries(MARCOS).map(([k, r]) => <option key={k} value={k}>Até a véspera do(a) {r}</option>)}
          </select>
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="grid gap-1.5 text-sm font-medium">Correção monetária
          <select name="correcao_indice" value={indice} onChange={(e) => setIndice(e.target.value as typeof indice)} className={selecao}>
            {INDICES_CORRECAO.map((i) => <option key={i} value={i}>{NOMES_SERIE[i]}</option>)}
            <option value="nenhuma">Sem correção</option>
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">Juros de mora
          <select name="juros_tipo" value={juros} onChange={(e) => { setJuros(e.target.value as typeof juros); if (e.target.value === "selic_englobando_correcao_e_juros") setIndice("nenhuma"); }} className={selecao}>
            {TIPOS_JUROS.map((t) => <option key={t} value={t}>{NOMES_JUROS[t]}</option>)}
          </select>
        </label>
        {precisaValor ? (
          <Campo rotulo={juros === "percentual_ao_mes" ? "Taxa (% ao mês)" : "Taxa (% ao ano)"} nome="juros_valor" required inputMode="decimal" defaultValue={base?.juros_valor === null || base?.juros_valor === undefined ? "" : String(base.juros_valor).replace(".", ",")} />
        ) : <input type="hidden" name="juros_valor" value="" />}
      </div>
      {juros === "selic_englobando_correcao_e_juros" && indice !== "nenhuma" ? (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">A Selic já engloba correção e juros: escolha &quot;Sem correção&quot; (Lei 14.905/2024).</p>
      ) : null}
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="juros_pro_rata" defaultChecked={base?.juros_pro_rata ?? true} /> Juros pro rata por dias corridos</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="correcao_pro_rata" defaultChecked={base?.correcao_pro_rata ?? false} /> Correção pro rata</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="indice_editavel" defaultChecked={base?.indice_editavel ?? false} /> Índice pode ser trocado no cálculo</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="teto" value="selic" defaultChecked={base?.teto === "selic"} /> Limitar correção + juros à Selic do período</label>
      </div>
      <label className="grid gap-1.5 text-sm font-medium">Fundamento (lei, contrato ou decisão)
        <textarea name="fundamento" required minLength={3} maxLength={2000} rows={3} defaultValue={base?.fundamento ?? ""} className="rounded-xl border border-border bg-white p-3 text-sm" placeholder="Ex.: Sentença de 12/03/2025, fls. 120: correção pelo IPCA-E desde o vencimento e juros de 0,5% ao mês desde a citação." />
      </label>
      <Mensagem estado={estado} />
      <div><BotaoEnviar>{base ? `Criar versão ${base.versao + 1}` : "Criar regime"}</BotaoEnviar></div>
    </form>
  );
}
