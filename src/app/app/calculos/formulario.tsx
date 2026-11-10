"use client";

import { useActionState, useState } from "react";
import { BotaoEnviar, Campo, Mensagem } from "@/components/formulario";
import { descreverCorrecao, descreverJuros, descreverVigencia, INDICES_CORRECAO, NOMES_SERIE, dataBr } from "@/lib/calculos/base";
import { NOMES_DESLIGAMENTO } from "@/lib/calculos/rescisao";
import type { TipoCalculo } from "@/lib/calculos/calculos";
import type { Valores } from "@/lib/calculos/formulario";
import type { ProcessoOpcao, RegimeLinha } from "@/lib/calculos/servidor";
import { salvarCalculo } from "./actions";

const selecao = "h-10 w-full rounded-xl border border-border bg-white px-3 text-sm";
const partesDe = (p: ProcessoOpcao) => [p.ativo, p.passivo].filter(Boolean).join(" x ");

function SeletorIndice({ regime, valor }: { regime: RegimeLinha; valor: string }) {
  if (!regime.indice_editavel || regime.juros_tipo === "selic_englobando_correcao_e_juros") return null;
  return (
    <label className="mt-2 grid gap-1 text-xs font-medium">
      Índice de correção neste trecho
      <select name={`indice__${regime.id}`} defaultValue={valor} className={selecao}>
        <option value="">{NOMES_SERIE[regime.correcao_indice as keyof typeof NOMES_SERIE] ?? "Sem correção"} (padrão do regime)</option>
        {INDICES_CORRECAO.filter((i) => i !== regime.correcao_indice).map((i) => <option key={i} value={i}>{NOMES_SERIE[i]} (convencionado ou fixado na decisão)</option>)}
        <option value="nenhuma">Sem correção</option>
      </select>
    </label>
  );
}

export function FormularioCalculo({ tipo, valores, processos, regimes, id, origem, dataFinalSugerida }: {
  tipo: TipoCalculo; valores: Valores; processos: ProcessoOpcao[]; regimes: RegimeLinha[]; id?: string; origem?: string; dataFinalSugerida: string;
}) {
  const [estado, acao] = useActionState(salvarCalculo, undefined);
  const [processo, setProcesso] = useState(valores.processo);
  const [partes, setPartes] = useState(valores.partes);
  const [juros, setJuros] = useState(valores.juros);
  const [modo, setModo] = useState(valores.modo_regimes);
  const [escolhidos, setEscolhidos] = useState<string[]>(valores.regimes);
  const [modalidade, setModalidade] = useState(valores.modalidade);
  const [forma, setForma] = useState(valores.forma);

  const [comRescisao, setComRescisao] = useState(valores.com_rescisao);
  const [desligamento, setDesligamento] = useState(valores.tipo_desligamento);
  const [verbas, setVerbas] = useState(valores.verbas.length ? valores.verbas : tipo === "trabalhista" && !valores.com_rescisao ? [{ descricao: "", valor: "", vencimento: "" }] : []);
  const escopo = tipo === "trabalhista" ? "trabalhista" : "civel";
  const padrao = regimes.filter((r) => r.escritorio_id === null && r.ativo && r.escopo === escopo);
  // Na escolha manual: regimes ativos + os que este cálculo já usa (mesmo que haja versão mais nova).
  const disponiveis = regimes.filter((r) => r.escopo === escopo && (r.ativo || valores.regimes.includes(r.id)));
  const ativos = modo === "padrao" ? padrao : disponiveis.filter((r) => escolhidos.includes(r.id));

  return (
    <form action={acao} className="mt-6 grid gap-4">
      <input type="hidden" name="tipo" value={tipo} />
      {id ? <input type="hidden" name="id" value={id} /> : null}
      {origem ? <input type="hidden" name="origem" value={origem} /> : null}

      <section className="grid gap-4 rounded-[26px] bg-white p-6">
        <Campo rotulo="Título" nome="titulo" required minLength={2} maxLength={160} defaultValue={valores.titulo} placeholder="Ex.: Atualização do débito — contrato de prestação de serviços" />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">Processo (opcional)
            <select name="processo" value={processo} className={selecao} onChange={(e) => {
              setProcesso(e.target.value);
              const p = processos.find((x) => x.id === e.target.value);
              if (p && !partes) setPartes(partesDe(p));
            }}>
              <option value="">— sem processo —</option>
              {processos.map((p) => <option key={p.id} value={p.id}>{p.numero_cnj}{p.titulo ? ` — ${p.titulo}` : ""}</option>)}
            </select>
          </label>
          <Campo rotulo="Partes" nome="partes" maxLength={500} value={partes} onChange={(e) => setPartes(e.target.value)} placeholder="Exequente x Executado" />
        </div>
      </section>

      {tipo === "trabalhista" ? (
        <>
          <section className="grid gap-4 rounded-[26px] bg-white p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Processo</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo rotulo="Ajuizamento da ação (obrigatório)" nome="data_ajuizamento" type="date" required defaultValue={valores.data_ajuizamento} ajuda="Marca onde termina a fase pré-judicial e começa a Selic." />
              <Campo rotulo="Atualizar até" nome="data_final" type="date" required defaultValue={valores.data_final || dataFinalSugerida}
                ajuda={`Com os índices publicados, dá para ir até ${dataBr(dataFinalSugerida)}.`} />
            </div>
          </section>

          <section className="grid gap-4 rounded-[26px] bg-white p-6">
            <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" name="com_rescisao" checked={comRescisao} onChange={(e) => setComRescisao(e.target.checked)} /> Apurar verbas rescisórias</label>
            {comRescisao ? (
              <>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Campo rotulo="Admissão" nome="admissao" type="date" required defaultValue={valores.admissao} />
                  <Campo rotulo="Saída (comunicação da dispensa)" nome="saida" type="date" required defaultValue={valores.saida} />
                  <label className="grid gap-1.5 text-sm font-medium">Tipo de desligamento
                    <select name="tipo_desligamento" value={desligamento} onChange={(e) => setDesligamento(e.target.value as Valores["tipo_desligamento"])} className={selecao}>
                      {Object.entries(NOMES_DESLIGAMENTO).map(([k, r]) => <option key={k} value={k}>{r}</option>)}
                    </select>
                  </label>
                </div>
                {desligamento === "sem_justa_causa" || desligamento === "acordo_484a" ? (
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="aviso_indenizado" defaultChecked={valores.aviso_indenizado} /> Aviso prévio indenizado (desmarque se foi trabalhado)</label>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-3">
                  <Campo rotulo="Último salário (R$)" nome="salario" required inputMode="decimal" defaultValue={valores.salario} />
                  <Campo rotulo="Média de variáveis (R$, opcional)" nome="medias" inputMode="decimal" defaultValue={valores.medias} ajuda="Comissões, horas extras habituais etc. Entra no aviso, 13º e férias." />
                  <Campo rotulo="Saldo do FGTS para fins rescisórios (R$)" nome="saldo_fgts" inputMode="decimal" defaultValue={valores.saldo_fgts} ajuda="Do extrato. Sem ele, a multa usa uma estimativa." />
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Campo rotulo="Férias vencidas (períodos)" nome="ferias_vencidas" type="number" min={0} max={5} defaultValue={valores.ferias_vencidas} />
                  <Campo rotulo="Desses, em dobro (art. 137)" nome="ferias_dobro" type="number" min={0} max={5} defaultValue={valores.ferias_dobro} />
                </div>
                <p className="text-xs text-muted-foreground">As verbas rescisórias vencem 10 dias após a saída (CLT, art. 477, § 6º) e são atualizadas desde essa data.</p>
              </>
            ) : null}
          </section>

          <section className="grid gap-3 rounded-[26px] bg-white p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Outras verbas (cada uma com o seu vencimento)</h2>
            {verbas.map((v, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_10rem_11rem_auto] sm:items-end">
                <Campo rotulo="Descrição" nome="verba_descricao" defaultValue={v.descricao} maxLength={120} placeholder="Ex.: Salário de março/2022" />
                <Campo rotulo="Valor (R$)" nome="verba_valor" inputMode="decimal" defaultValue={v.valor} />
                <Campo rotulo="Vencimento" nome="verba_vencimento" type="date" defaultValue={v.vencimento} />
                <button type="button" onClick={() => setVerbas((x) => x.filter((_, k) => k !== i))} className="h-10 rounded-full px-3 text-sm text-red-700 hover:bg-red-50">Remover</button>
              </div>
            ))}
            <div><button type="button" onClick={() => setVerbas((x) => [...x, { descricao: "", valor: "", vencimento: "" }])} className="h-9 rounded-full bg-muted px-4 text-sm font-medium hover:bg-border">+ Adicionar verba</button></div>
            <p className="text-xs text-muted-foreground">Horas extras com reflexos, adicionais e descontos de INSS e IR ainda não são calculados aqui; informe o valor já apurado, se tiver.</p>
          </section>
        </>
      ) : null}

      {tipo === "atualizacao" || tipo === "art523" ? (
        <>
          <section className="grid gap-4 rounded-[26px] bg-white p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Valores e datas</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <Campo rotulo="Valor (R$)" nome="valor" required inputMode="decimal" defaultValue={valores.valor} placeholder="10.000,00" />
              <Campo rotulo="Data-base (vencimento)" nome="data_base" type="date" required defaultValue={valores.data_base} ajuda="Início da correção monetária." />
              <Campo rotulo="Atualizar até" nome="data_final" type="date" required defaultValue={valores.data_final || dataFinalSugerida}
                ajuda={`Com os índices publicados, dá para ir até ${dataBr(dataFinalSugerida)}.`} />
            </div>
            <fieldset className="grid gap-2 text-sm">
              <legend className="font-medium">Juros de mora desde</legend>
              <div className="flex flex-wrap gap-4">
                {([["vencimento", "o vencimento"], ["citacao", "a citação"], ["sem_juros", "sem juros"]] as const).map(([v, r]) => (
                  <label key={v} className="flex items-center gap-2"><input type="radio" name="juros" value={v} checked={juros === v} onChange={() => setJuros(v)} /> {r}</label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-3">
              <Campo rotulo={`Citação${juros === "citacao" ? " (obrigatória)" : ""}`} nome="data_citacao" type="date" required={juros === "citacao"} defaultValue={valores.data_citacao} />
              <Campo rotulo="Ajuizamento (opcional)" nome="data_ajuizamento" type="date" defaultValue={valores.data_ajuizamento} />
              <Campo rotulo="Trânsito em julgado (opcional)" nome="data_transito" type="date" defaultValue={valores.data_transito} />
            </div>
          </section>

          {tipo === "art523" ? (
            <section className="grid gap-4 rounded-[26px] bg-white p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Cumprimento de sentença (CPC, art. 523)</h2>
              <p className="text-sm text-muted-foreground">Se não houver pagamento em 15 dias úteis da intimação, acrescentam-se multa de 10% e honorários de 10%. Pagamento parcial no prazo: multa e honorários só sobre o restante (§ 2º). O prazo usa o calendário forense do tribunal do processo.</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <Campo rotulo="Intimação para pagamento" nome="data_intimacao" type="date" required defaultValue={valores.data_intimacao} />
                <Campo rotulo="Pagamento parcial (R$, opcional)" nome="pagamento_valor" inputMode="decimal" defaultValue={valores.pagamento_valor} />
                <Campo rotulo="Data do pagamento parcial" nome="pagamento_data" type="date" defaultValue={valores.pagamento_data} />
              </div>
            </section>
          ) : null}

        </>
      ) : null}

      {tipo !== "honorarios" ? (
          <section className="grid gap-4 rounded-[26px] bg-white p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Regras de atualização</h2>
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">{escopo === "trabalhista" ? <>Fases do STF e do TST: antes do ajuizamento, IPCA-E + juros do art. 39 da Lei 8.177/1991; do ajuizamento até 29/08/2024, só a Selic; desde 30/08/2024, IPCA + Taxa Legal. É o padrão; se a decisão fixar outro critério, escolha outro regime.</> : <>O regime padrão é uma <strong>sugestão</strong>. Troque o índice ou escolha outro regime conforme o contrato ou a decisão judicial.</>}</p>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="radio" name="modo_regimes" value="padrao" checked={modo === "padrao"} onChange={() => setModo("padrao")} /> {escopo === "trabalhista" ? "Padrão trabalhista (STF ADC 58 + TST)" : "Padrão cível (Lei 14.905/2024)"}</label>
              <label className="flex items-center gap-2"><input type="radio" name="modo_regimes" value="escolher" checked={modo === "escolher"} onChange={() => setModo("escolher")} /> Escolher regimes (ex.: critério da sentença)</label>
            </div>
            <ul className="grid gap-3">
              {(modo === "padrao" ? padrao : disponiveis).map((r) => (
                <li key={r.id} className="rounded-2xl bg-muted/50 p-4 text-sm">
                  <div className="flex items-start gap-3">
                    {modo === "escolher" ? (
                      <input type="checkbox" name="regimes" value={r.id} className="mt-1" checked={escolhidos.includes(r.id)}
                        onChange={(e) => setEscolhidos((x) => (e.target.checked ? [...x, r.id] : x.filter((y) => y !== r.id)))} />
                    ) : null}
                    <div className="min-w-0">
                      <p className="font-medium">{r.nome} <span className="text-muted-foreground">· versão {r.versao}{!r.ativo ? " (há versão mais nova)" : ""}{r.escritorio_id ? " · personalizado" : ""}</span></p>
                      <p className="text-muted-foreground">Vigência: {descreverVigencia(r)} · Correção: {descreverCorrecao(r.correcao_indice, r.correcao_pro_rata)} · Juros: {descreverJuros(r)}</p>
                    </div>
                  </div>
                  {ativos.some((a) => a.id === r.id) ? <SeletorIndice regime={r} valor={valores.indices[r.id] ?? ""} /> : null}
                </li>
              ))}
            </ul>
            {modo === "escolher" ? <p className="text-xs text-muted-foreground">Os regimes escolhidos não podem valer ao mesmo tempo e precisam cobrir todo o período. Para criar um critério novo, use a aba Regimes.</p> : null}
          </section>
      ) : (
        <section className="grid gap-4 rounded-[26px] bg-white p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Honorários</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">Modalidade
              <select name="modalidade" value={modalidade} onChange={(e) => setModalidade(e.target.value as Valores["modalidade"])} className={selecao}>
                <option value="sucumbencia">Sucumbência (10% a 20%)</option>
                <option value="contratuais">Contratuais</option>
                <option value="exito">Êxito (sobre o valor recebido)</option>
              </select>
            </label>
            {modalidade === "contratuais" ? (
              <label className="grid gap-1.5 text-sm font-medium">Forma
                <select name="forma" value={forma} onChange={(e) => setForma(e.target.value as Valores["forma"])} className={selecao}>
                  <option value="percentual">Percentual sobre uma base</option>
                  <option value="fixo">Valor fixo</option>
                </select>
              </label>
            ) : modalidade === "sucumbencia" ? (
              <label className="grid gap-1.5 text-sm font-medium">Base de cálculo
                <select name="base_tipo" defaultValue={["condenacao", "proveito_economico", "valor_causa"].includes(valores.base_tipo) ? valores.base_tipo : "condenacao"} className={selecao}>
                  <option value="condenacao">Valor da condenação</option>
                  <option value="proveito_economico">Proveito econômico obtido</option>
                  <option value="valor_causa">Valor atualizado da causa</option>
                </select>
              </label>
            ) : <div />}
          </div>
          {modalidade === "contratuais" && forma === "fixo" ? (
            <Campo rotulo="Valor fixo (R$)" nome="valor_fixo" required inputMode="decimal" defaultValue={valores.valor_fixo} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo rotulo={modalidade === "exito" ? "Valor efetivamente recebido (R$)" : "Valor da base (R$)"} nome="base_valor" required inputMode="decimal" defaultValue={valores.base_valor} />
              <Campo rotulo="Percentual (%)" nome="percentual" required inputMode="decimal" defaultValue={valores.percentual} ajuda={modalidade === "sucumbencia" ? "Entre 10% e 20% (CPC, art. 85, § 2º)." : undefined} />
            </div>
          )}
          {modalidade === "contratuais" ? <input type="hidden" name="base_tipo" value="outro" /> : null}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="fazenda_publica" defaultChecked={valores.fazenda_publica} /> Causa contra a Fazenda Pública</label>
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">Contra a Fazenda Pública os percentuais são escalonados por faixa de valor (CPC, art. 85, § 3º). Essa regra entra no Prompt 8C; por ora o cálculo só avisa.</p>
        </section>
      )}

      <Mensagem estado={estado} />
      <div className="flex flex-wrap items-center gap-3">
        <BotaoEnviar>{id ? "Recalcular e salvar" : "Calcular e salvar"}</BotaoEnviar>
        <p className="text-xs text-muted-foreground">O cálculo usa os índices guardados no LAW (Banco Central), nunca a internet na hora.</p>
      </div>
    </form>
  );
}
