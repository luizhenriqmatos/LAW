import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { dataBR, dataHoraBR, rotuloCompromisso, situacaoAtual, tamanhoLegivel, traduzirMovimentacao } from "@/lib/portal/linguagem";
import { carregarProcesso } from "@/lib/portal/servidor";
import { BotaoSair } from "../../sair";

function cnj(n: string) {
  return n.replace(/^(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})$/, "$1-$2.$3.$4.$5.$6");
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[26px] bg-card p-6 shadow-sm">
      <h2 className="text-lg font-medium">{titulo}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default async function PaginaProcessoPortal({ params }: PageProps<"/portal/processos/[id]">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const r = await carregarProcesso(id);
  if (r.estado === "sem_sessao") redirect("/portal/entrar?erro=sessao");
  // Não liberado, em segredo de justiça ou inexistente: mesma página, sem pista de qual deles.
  if (r.estado === "nao_encontrado") notFound();
  const d = r.dados;
  const p = d.processo;
  const situacao = situacaoAtual(p.situacao_texto, d.movimentacoes[0] ?? null);

  return (
    <main className="grid gap-4">
      <div className="flex items-center justify-between gap-4">
        <Link href="/portal" className="rounded-full px-4 py-2 text-sm font-medium hover:bg-white/70">← Meus processos</Link>
        <BotaoSair />
      </div>

      <div>
        <p className="text-sm text-muted-foreground">{p.escritorio}</p>
        <h1 className="text-3xl font-medium tracking-tight">{p.titulo ?? "Processo"}</h1>
        <p className="text-sm text-muted-foreground">
          Nº {cnj(p.numero_cnj)}
          {p.tribunal ? ` · ${p.tribunal}` : ""}
          {p.orgao_julgador ? ` · ${p.orgao_julgador}` : ""}
        </p>
      </div>

      <Secao titulo="Situação atual">
        <p>{situacao.texto}</p>
        {situacao.data ? <p className="mt-1 text-xs text-muted-foreground">Último andamento em {dataBR(situacao.data)}</p> : null}
      </Secao>

      {d.ver_resumo && d.resumo ? (
        <Secao titulo="Resumo em linguagem simples">
          <div className="grid gap-3">
            {d.resumo.texto.split(/\n{2,}/).map((par, i) => (
              <p key={i}>{par}</p>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {d.resumo.revisado ? "Resumo revisado pelo seu advogado" : "Resumo preparado automaticamente com apoio de inteligência artificial"}
            {" · "}publicado em {dataBR(d.resumo.publicado_em)}
          </p>
        </Secao>
      ) : null}

      {d.ver_compromissos ? (
        <Secao titulo="Próximos compromissos">
          {d.compromissos.length === 0 ? (
            <p className="text-muted-foreground">Nenhum compromisso marcado por enquanto.</p>
          ) : (
            <ul className="grid gap-3">
              {d.compromissos.map((c, i) => (
                <li key={i}>
                  <p className="font-medium">{rotuloCompromisso(c.tipo)}: {c.titulo}</p>
                  <p className="text-sm text-muted-foreground">
                    {dataHoraBR(c.inicio)}
                    {c.local ? ` · ${c.local}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Secao>
      ) : null}

      {d.ver_movimentacoes ? (
        <Secao titulo="Últimas movimentações">
          {d.movimentacoes.length === 0 ? (
            <p className="text-muted-foreground">Ainda não há movimentações para mostrar.</p>
          ) : (
            <ol className="grid gap-4">
              {d.movimentacoes.map((m, i) => {
                const t = traduzirMovimentacao(m.nome);
                return (
                  <li key={i} className="border-l-2 border-accent pl-4">
                    <p className="text-xs text-muted-foreground">{dataBR(m.data_hora)}</p>
                    <p>{t.texto}</p>
                    {t.traduzido ? <p className="mt-0.5 text-xs text-muted-foreground">Nome oficial: {t.oficial}</p> : null}
                  </li>
                );
              })}
            </ol>
          )}
        </Secao>
      ) : null}

      {d.ver_documentos ? (
        <Secao titulo="Documentos">
          {d.documentos.length === 0 ? (
            <p className="text-muted-foreground">Nenhum documento compartilhado por enquanto.</p>
          ) : (
            <ul className="grid gap-2">
              {d.documentos.map((doc) => (
                <li key={doc.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{doc.nome}{doc.tamanho != null ? ` (${tamanhoLegivel(doc.tamanho)})` : ""}</span>
                  <a href={`/portal/processos/${p.id}/documentos/${doc.id}`} className="shrink-0 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
                    Baixar
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Secao>
      ) : null}
    </main>
  );
}
