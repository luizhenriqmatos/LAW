import Link from "next/link";
import { Marca } from "./marca";

export type Secao = { titulo: string; paragrafos?: string[]; itens?: string[] };

/**
 * Moldura das páginas legais. O aviso "REVISAR COM ADVOGADO" fica no topo de TODA página legal enquanto o texto
 * for rascunho. Para publicar a versão final, tirar o aviso (`rascunho={false}`) só depois da revisão.
 */
export function PaginaLegal({ titulo, vigencia, secoes, rascunho = true }: { titulo: string; vigencia: string; secoes: Secao[]; rascunho?: boolean }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      {rascunho ? (
        <p role="note" className="mb-6 rounded-2xl border-2 border-red-600 bg-red-50 px-4 py-3 text-center text-sm font-bold uppercase tracking-wide text-red-800">
          REVISAR COM ADVOGADO — texto em rascunho, ainda sem validade
        </p>
      ) : null}
      <Marca />
      <h1 className="mt-6 text-4xl font-medium tracking-tight">{titulo}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{vigencia}</p>
      <div className="mt-8 grid gap-8">
        {secoes.map((s, i) => (
          <section key={s.titulo}>
            <h2 className="text-xl font-semibold">{i + 1}. {s.titulo}</h2>
            {s.paragrafos?.map((p) => <p key={p} className="mt-2 leading-relaxed">{p}</p>)}
            {s.itens ? <ul className="mt-2 grid list-disc gap-1 pl-5 leading-relaxed">{s.itens.map((t) => <li key={t}>{t}</li>)}</ul> : null}
          </section>
        ))}
      </div>
      <nav aria-label="Outras páginas" className="mt-12 flex gap-4 border-t pt-4 text-sm">
        <Link href="/termos" className="underline">Termos de uso</Link>
        <Link href="/privacidade" className="underline">Política de privacidade</Link>
        <Link href="/" className="ml-auto underline">Voltar</Link>
      </nav>
    </main>
  );
}
