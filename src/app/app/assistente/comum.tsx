import Link from "next/link";
import { segmentarLinha } from "@/lib/assistente/citacoes";
import { NOME_ASSISTENTE } from "@/lib/assistente/nome";
import type { Fonte } from "@/lib/assistente/tipos";
import { mensagemDeErro } from "@/lib/erros";
import { MODULOS } from "@/lib/modulos";
import { cn } from "@/lib/utils";

const OK: Record<string, string> = {
  confirmado: "Pronto: gravado. A ação ficou registrada no histórico de auditoria.",
  descartado: "Rascunho descartado. Nada foi gravado.",
  modelo_salvo: "Modelo salvo.",
  modelo_ativado: "Modelo ativado: a Lia pode usá-lo.",
  modelo_desativado: "Modelo desativado: a Lia não o usa mais.",
  minuta_revisada: "Minuta marcada como revisada.",
};

/** Aviso de resultado (?aviso=...). "confirmado:/app/..." mostra o link para o que foi gravado. */
export function AvisoLia({ codigo }: { codigo?: string | string[] }) {
  const c = typeof codigo === "string" ? codigo : undefined;
  if (!c) return null;
  const link = /^confirmado:(\/app\/[A-Za-z0-9/_-]+)$/.exec(c)?.[1];
  const chave = link ? "confirmado" : c;
  const ok = OK[chave];
  return (
    <p role={ok ? "status" : "alert"} className={cn("mt-4 rounded-xl px-4 py-3 text-sm font-medium", ok ? "bg-accent text-accent-foreground" : "bg-red-50 text-red-700")}>
      {ok ?? mensagemDeErro(c.replace(/^erro_/, ""))}
      {link ? <> <Link href={link} className="underline">Abrir</Link></> : null}
    </p>
  );
}

/** Aviso fixo: o que a Lia faz e o que não faz. */
export function AvisoComoFunciona({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950", className)}>
      <p>
        A {NOME_ASSISTENTE} responde <strong>só com os dados do escritório que você pode ver</strong> e mostra de onde tirou cada informação.
        Ela <strong>não grava nada sozinha</strong>: lançamentos, tarefas, prazos e minutas viram um rascunho que só é salvo quando você clica em <strong>Confirmar</strong>.
      </p>
      <p className="mt-1 text-sky-900/80">
        A IA pode errar: confira sempre. As perguntas e respostas ficam registradas no histórico de auditoria do escritório.
        Processos em segredo de justiça são enviados à IA sem partes e sem texto das publicações.
      </p>
    </div>
  );
}

const rotuloModulo = (id: string) => MODULOS.find((m) => m.id === id)?.rotulo ?? id;

/** Aviso FIXO (não depende do texto da IA) quando alguma ferramenta foi recusada por permissão. */
export function AvisoSemPermissao({ modulos }: { modulos: string[] }) {
  if (!modulos.length) return null;
  return (
    <p role="note" className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      Você não tem permissão para ver: <strong>{[...new Set(modulos)].map(rotuloModulo).join(", ")}</strong>. A {NOME_ASSISTENTE} não consulta essas telas para você.
      Se precisar, peça acesso ao responsável pelo escritório.
    </p>
  );
}

/** Texto da resposta: parágrafos, listas simples e links SÓ para telas que as ferramentas devolveram. */
export function TextoResposta({ texto, fontes }: { texto: string; fontes: Fonte[] }) {
  const linhas = texto.split("\n");
  return (
    <div className="grid gap-1.5 text-[15px] leading-relaxed">
      {linhas.map((linha, i) => {
        if (!linha.trim()) return <div key={i} className="h-1" />;
        const item = /^\s*([-*•]|\d+[.)])\s+/.exec(linha);
        const conteudo = item ? linha.slice(item[0].length) : linha;
        const pedacos = segmentarLinha(conteudo.replace(/\*\*/g, ""), fontes).map((p, j) =>
          p.tipo === "link" ? <Link key={j} href={p.href} className="font-medium text-primary underline underline-offset-2">{p.texto}</Link> : <span key={j}>{p.texto}</span>,
        );
        return item ? <p key={i} className="pl-4 -indent-3">• {pedacos}</p> : <p key={i}>{pedacos}</p>;
      })}
    </div>
  );
}

export function dataHora(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Bahia", dateStyle: "short", timeStyle: "short" });
}

export function linkDoResultado(tipo: string, resultadoId: string | null, confirmados: Record<string, unknown> | null): string | null {
  if (!resultadoId) return null;
  if (tipo === "lancamento") return `/app/financeiro/lancamentos/${resultadoId}`;
  if (tipo === "tarefa") return `/app/tarefas/${resultadoId}`;
  if (tipo === "minuta") return `/app/assistente/minutas/${resultadoId}`;
  const proc = confirmados?.processo_id;
  return typeof proc === "string" ? `/app/processos/${proc}` : null;
}

/** Igual a assistente_validade_rascunho() no banco (o banco é quem recusa; aqui é só para mostrar). */
const VALIDADE_MS = 24 * 3600 * 1000;
export function rascunhoVencido(criadoEm: string, agora = new Date()): boolean {
  return agora.getTime() - new Date(criadoEm).getTime() > VALIDADE_MS;
}
