"use client";

import { useActionState, useState } from "react";
import { BotaoEnviar, Campo, Mensagem } from "@/components/formulario";
import { Label } from "@/components/ui/label";
import { UFS } from "@/lib/validacao";
import { criarEscritorio, salvarMonitoramento } from "./actions";

const PLANOS = [
  { id: "solo", nome: "Solo", texto: "Só você" },
  { id: "equipe", nome: "Equipe", texto: "Você + 3 pessoas" },
  { id: "escritorio", nome: "Escritório", texto: "Até 51 pessoas" },
  { id: "juridico", nome: "Jurídico", texto: "Empresa (CNPJ)" },
];

export function FormularioEscritorio() {
  const [estado, acao] = useActionState(criarEscritorio, undefined);
  return (
    <form action={acao} className="grid gap-4">
      <Campo rotulo="Nome do escritório" nome="nome" required minLength={2} maxLength={120} placeholder="Prado Advocacia" />
      <Campo rotulo="CNPJ (opcional)" nome="cnpj" inputMode="numeric" placeholder="00.000.000/0000-00" ajuda="Deixe em branco se você advoga como pessoa física." />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Plano</legend>
        <div className="grid grid-cols-2 gap-2">
          {PLANOS.map((p, i) => (
            <label key={p.id} className="flex cursor-pointer items-start gap-2 rounded-xl bg-white p-3 text-sm has-checked:ring-2 has-checked:ring-primary">
              <input type="radio" name="plano" value={p.id} defaultChecked={i === 1} className="mt-1 accent-black" />
              <span>
                <span className="block font-semibold">{p.nome}</span>
                <span className="text-muted-foreground">{p.texto}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Mensagem estado={estado} />
      <BotaoEnviar>Continuar</BotaoEnviar>
    </form>
  );
}

type Oab = { numero: string; uf: string };

export function FormularioMonitoramento() {
  const [estado, acao] = useActionState(salvarMonitoramento, undefined);
  const [modo, setModo] = useState<"oab" | "sociedade">("oab");
  const [oabs, setOabs] = useState<Oab[]>([{ numero: "", uf: "BA" }]);
  const [cnpj, setCnpj] = useState("");
  const [nome, setNome] = useState("");
  const dados = JSON.stringify(modo === "oab" ? { modo, oabs } : { modo, cnpj, nome });

  return (
    <form action={acao} className="grid gap-5">
      <input type="hidden" name="dados" value={dados} />
      <div className="inline-flex w-fit rounded-full bg-white p-1 text-sm font-medium">
        <button type="button" onClick={() => setModo("oab")} className={`rounded-full px-4 py-2 ${modo === "oab" ? "bg-primary text-primary-foreground" : ""}`}>
          Por OAB
        </button>
        <button type="button" onClick={() => setModo("sociedade")} className={`rounded-full px-4 py-2 ${modo === "sociedade" ? "bg-primary text-primary-foreground" : ""}`}>
          Por sociedade (CNPJ ou nome)
        </button>
      </div>

      {modo === "oab" ? (
        <div className="grid gap-3">
          {oabs.map((o, i) => (
            <div key={i} className="grid grid-cols-[1fr_96px_auto] items-end gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor={`oab-${i}`}>Número da OAB</Label>
                <input
                  id={`oab-${i}`}
                  inputMode="numeric"
                  maxLength={7}
                  value={o.numero}
                  onChange={(e) => setOabs(oabs.map((x, j) => (j === i ? { ...x, numero: e.target.value.replace(/\D/g, "") } : x)))}
                  className="h-10 rounded-xl border border-input bg-white px-3"
                  placeholder="54321"
                  required
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`uf-${i}`}>UF</Label>
                <select id={`uf-${i}`} value={o.uf} onChange={(e) => setOabs(oabs.map((x, j) => (j === i ? { ...x, uf: e.target.value } : x)))} className="h-10 rounded-xl border border-input bg-white px-2">
                  {UFS.map((uf) => (
                    <option key={uf}>{uf}</option>
                  ))}
                </select>
              </div>
              <button type="button" disabled={oabs.length === 1} onClick={() => setOabs(oabs.filter((_, j) => j !== i))} className="h-10 rounded-full px-3 text-sm text-muted-foreground disabled:opacity-30" aria-label="Remover OAB">
                Remover
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setOabs([...oabs, { numero: "", uf: "BA" }])} className="w-fit text-sm font-semibold underline" disabled={oabs.length >= 20}>
            + Adicionar outra OAB
          </button>
        </div>
      ) : (
        <div className="grid gap-3">
          <Campo rotulo="CNPJ da sociedade" nome="cnpj-visivel" value={cnpj} onChange={(e) => setCnpj(e.target.value)} inputMode="numeric" placeholder="00.000.000/0000-00" />
          <Campo rotulo="Nome da sociedade" nome="nome-visivel" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Prado Advogados Associados" ajuda="Informe o CNPJ, o nome ou os dois." />
        </div>
      )}
      <Mensagem estado={estado} />
      <BotaoEnviar>Salvar e buscar processos</BotaoEnviar>
    </form>
  );
}
