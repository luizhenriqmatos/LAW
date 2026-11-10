import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { exigirModulo } from "@/lib/contexto";
import { listarArquivos, type ArquivoLista } from "@/lib/drive/arquivos";
import { depsDriveDoAmbiente, driveConfigurado } from "@/lib/drive/ambiente";
import { servicoIa } from "@/lib/integrations/ia";
import { dataBR, dataHoraBR, tamanhoLegivel } from "@/lib/portal/linguagem";
import { formatarCnj, Selo } from "../../../processos/comum";
import {
  compartilharDocumento, editarResumo, encerrarResumo, gerarResumoIa, liberarCliente, publicarResumo, revogarDocumento, revogarLiberacao,
  salvarResumoManual, visibilidadeCompromisso,
} from "../../actions";
import { AvisoPortal } from "../../avisos";
import { FormularioEnviarAcesso } from "../../comum";

type Liberacao = {
  id: string; ativo: boolean; ver_movimentacoes: boolean; ver_resumo: boolean; ver_compromissos: boolean; ver_documentos: boolean;
  situacao_texto: string | null; titulo_cliente: string | null;
};
type Painel = {
  processo: { id: string; numero_cnj: string; classe?: string | null; tribunal?: string | null; sigiloso: boolean; confirmado: boolean };
  modo?: "revisar" | "direto";
  partes?: { cliente_id: string; nome: string; polo: string; email_mascarado: string | null; liberacao: Liberacao | null }[];
  compromissos?: { id: string; titulo: string; tipo: string; inicio: string; local: string; visivel_portal: boolean }[];
  resumos?: { id: string; texto: string; status: "rascunho" | "publicado"; origem: "ia" | "advogado"; alertas: string[]; criado_em: string; publicado_em: string | null; revisado: boolean }[];
  documentos?: { id: string; nome: string; tamanho: number | null; arquivo_drive_id: string; compartilhado_em: string }[];
};

const botao = "h-9 rounded-full px-4 text-sm font-medium";
const primario = `${botao} bg-primary text-primary-foreground`;
const neutro = `${botao} bg-muted hover:bg-muted/70`;

function Caixa({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-[26px] bg-white p-6">
      <h2 className="text-lg font-medium">{titulo}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Marca({ nome, rotulo, marcado }: { nome: string; rotulo: string; marcado: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={nome} defaultChecked={marcado} className="size-4" />
      {rotulo}
    </label>
  );
}

export default async function PaginaGerenciarPortal({ params, searchParams }: PageProps<"/app/portal-cliente/processos/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase } = await exigirModulo("portal_cliente");
  const { data, error } = await supabase.rpc("portal_painel_processo", { p_processo: id });
  if (error) notFound();
  const pn = data as Painel;
  const p = pn.processo;
  const cabecalho = (
    <>
      <Link href="/app/portal-cliente" className="text-sm font-semibold underline">← Portal do cliente</Link>
      <h1 className="mt-3 text-4xl font-medium tracking-tight">Portal: {formatarCnj(p.numero_cnj)}</h1>
    </>
  );

  // Segredo de justiça: nada é mostrado nem oferecido. O banco recusa qualquer tentativa de liberar.
  if (p.sigiloso) {
    return (
      <div className="mx-auto max-w-4xl">
        {cabecalho}
        <p role="alert" className="mt-6 rounded-[26px] bg-red-50 p-6 text-red-800 ring-1 ring-red-200">
          <Selo tipo="segredo" /> <span className="ml-2 font-medium">Este processo está em segredo de justiça e nunca aparece no portal do cliente.</span>
          <span className="mt-2 block text-sm">Se havia algo liberado, o acesso foi retirado automaticamente.</span>
        </p>
      </div>
    );
  }
  if (!p.confirmado) {
    return (
      <div className="mx-auto max-w-4xl">
        {cabecalho}
        <p className="mt-6 rounded-[26px] bg-white p-6 text-muted-foreground">Confirme o processo na triagem antes de liberá-lo no portal.</p>
      </div>
    );
  }

  const partes = pn.partes ?? [];
  const resumos = pn.resumos ?? [];
  const publicado = resumos.find((r) => r.status === "publicado");
  const rascunho = resumos.find((r) => r.status === "rascunho");
  const iaPronta = servicoIa() !== null;
  const jaCompartilhados = new Set((pn.documentos ?? []).map((d) => d.arquivo_drive_id));

  // Arquivos da pasta do processo no Drive (para escolher o que compartilhar).
  let arquivos: ArquivoLista[] | null = null;
  let motivoSemArquivos: string | null = null;
  if (!driveConfigurado()) motivoSemArquivos = "O Google Drive ainda não foi ativado neste LAW.";
  else {
    const { data: pasta } = await supabase.rpc("portal_pasta_processo", { p_processo: id });
    const pa = pasta as { escritorio_id: string; drive_id: string } | null;
    if (!pa) motivoSemArquivos = "A pasta deste processo no Drive ainda não existe.";
    else {
      const r = await listarArquivos(depsDriveDoAmbiente(), pa.escritorio_id, pa.drive_id);
      if (r.ok) arquivos = r.dados.filter((a) => !a.pasta);
      else motivoSemArquivos = "Não foi possível listar a pasta agora.";
    }
  }

  return (
    <div className="mx-auto max-w-4xl pb-10">
      {cabecalho}
      <p className="mt-1 text-sm text-muted-foreground">{[p.classe, p.tribunal].filter(Boolean).join(" · ")}</p>
      <AvisoPortal codigo={sp.aviso} />

      <Caixa titulo="Quem vê este processo">
        {partes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum cliente confirmado é parte deste processo. Confirme o cliente na triagem para poder liberar.</p>
        ) : (
          <ul className="grid gap-6">
            {partes.map((pt) => {
              const l = pt.liberacao?.ativo ? pt.liberacao : null;
              return (
                <li key={pt.cliente_id} className="rounded-2xl bg-muted/40 p-4">
                  <p className="font-medium">{pt.nome} <span className="text-xs font-normal text-muted-foreground">({pt.polo})</span></p>
                  <p className="text-xs text-muted-foreground">
                    {pt.email_mascarado ? `E-mail do cliente: ${pt.email_mascarado}` : "Sem e-mail cadastrado: cadastre o e-mail do cliente em Processos antes de liberar."}
                  </p>
                  {pt.email_mascarado ? (
                    <form action={liberarCliente.bind(null, id, pt.cliente_id)} className="mt-3 grid gap-3">
                      <fieldset className="grid gap-1.5">
                        <legend className="text-sm font-medium">O que o cliente vê além da situação atual</legend>
                        <Marca nome="movimentacoes" rotulo="Últimas movimentações em linguagem simples" marcado={l?.ver_movimentacoes ?? false} />
                        <Marca nome="resumo" rotulo="Resumo publicado" marcado={l?.ver_resumo ?? false} />
                        <Marca nome="compromissos" rotulo="Compromissos marcados como visíveis" marcado={l?.ver_compromissos ?? false} />
                        <Marca nome="documentos" rotulo="Documentos compartilhados" marcado={l?.ver_documentos ?? false} />
                      </fieldset>
                      <label className="grid gap-1 text-sm">
                        Situação atual (opcional; se vazio, o cliente vê a última movimentação)
                        <input name="situacao" maxLength={280} defaultValue={l?.situacao_texto ?? ""} className="h-10 rounded-xl border bg-white px-3" />
                      </label>
                      <label className="grid gap-1 text-sm">
                        Nome do processo para o cliente (opcional)
                        <input name="titulo" maxLength={120} defaultValue={l?.titulo_cliente ?? ""} placeholder={p.classe ?? ""} className="h-10 rounded-xl border bg-white px-3" />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <button type="submit" className={primario}>{l ? "Salvar" : "Liberar para este cliente"}</button>
                      </div>
                    </form>
                  ) : null}
                  {l ? (
                    <div className="mt-3 flex flex-wrap items-start gap-3">
                      <form action={revogarLiberacao.bind(null, id, pt.liberacao!.id)}>
                        <button type="submit" className={neutro}>Retirar acesso</button>
                      </form>
                      <FormularioEnviarAcesso clienteId={pt.cliente_id} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Caixa>

      <Caixa titulo="Resumo em linguagem simples">
        <p className="text-sm text-muted-foreground">
          A IA lê só os nomes e as datas das movimentações e escreve um resumo curto, sem opinião jurídica, sem prever resultado e sem inventar fatos.
          {pn.modo === "direto"
            ? " Neste escritório ele é publicado direto, a menos que a verificação automática ache algo estranho."
            : " Neste escritório ele fica como rascunho até você ler e publicar."}
        </p>

        {publicado ? (
          <div className="mt-4 rounded-2xl bg-emerald-50 p-4 ring-1 ring-emerald-200">
            <p className="text-sm font-medium">Publicado no portal ({dataBR(publicado.publicado_em)}) · {publicado.revisado ? "revisado por você" : "gerado por IA, ainda não revisado"}</p>
            <p className="mt-2 whitespace-pre-line text-sm">{publicado.texto}</p>
            <form action={encerrarResumo.bind(null, id, publicado.id)} className="mt-3">
              <button type="submit" className={neutro}>Retirar do portal</button>
            </form>
          </div>
        ) : null}

        {rascunho ? (
          <form action={editarResumo.bind(null, id, rascunho.id)} className="mt-4 grid gap-3 rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200">
            <p className="text-sm font-medium">
              Rascunho {rascunho.origem === "ia" ? "gerado por IA (não revisado)" : "escrito por você"} · {dataHoraBR(rascunho.criado_em)}
            </p>
            {rascunho.alertas.length > 0 ? (
              <ul role="alert" className="list-disc pl-5 text-sm text-red-800">
                {rascunho.alertas.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            ) : null}
            <textarea name="texto" defaultValue={rascunho.texto} rows={9} maxLength={3000} className="rounded-xl border bg-white p-3 text-sm" aria-label="Texto do resumo" />
            <p className="text-xs text-muted-foreground">O texto sempre termina com “Dúvidas? Fale com seu advogado.”.</p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={neutro}>Salvar edição</button>
              <button type="submit" formAction={publicarResumo.bind(null, id, rascunho.id)} className={primario}>Publicar no portal</button>
              <button type="submit" formAction={encerrarResumo.bind(null, id, rascunho.id)} className={neutro}>Descartar rascunho</button>
            </div>
          </form>
        ) : null}

        <div className="mt-4 flex flex-wrap items-start gap-3">
          <form action={gerarResumoIa.bind(null, id)}>
            <button type="submit" className={primario} disabled={!iaPronta}>{publicado || rascunho ? "Gerar de novo com IA" : "Gerar resumo com IA"}</button>
          </form>
          {!iaPronta ? <p className="text-xs text-muted-foreground">A IA ainda não foi configurada neste LAW. Escreva o resumo à mão abaixo.</p> : null}
        </div>
        <form action={salvarResumoManual.bind(null, id)} className="mt-4 grid gap-2">
          <label htmlFor="texto-manual" className="text-sm font-medium">Escrever o resumo à mão</label>
          <textarea id="texto-manual" name="texto" rows={4} maxLength={3000} className="rounded-xl border bg-white p-3 text-sm" />
          <button type="submit" className={`${neutro} w-fit`}>Salvar como rascunho</button>
        </form>
      </Caixa>

      <Caixa titulo="Compromissos">
        <p className="text-sm text-muted-foreground">O cliente vê só o tipo, o título, a data e o local do compromisso marcado como visível. Nunca vê a descrição. Evite dados internos no título.</p>
        {(pn.compromissos ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nenhum compromisso futuro ligado a este processo. Crie na Agenda e ligue ao processo.</p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {pn.compromissos!.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>{dataHoraBR(c.inicio)} · {c.titulo}{c.local ? ` · ${c.local}` : ""}</span>
                <form action={visibilidadeCompromisso.bind(null, id, c.id, !c.visivel_portal)}>
                  <button type="submit" className={c.visivel_portal ? primario : neutro}>{c.visivel_portal ? "Visível ao cliente · ocultar" : "Mostrar ao cliente"}</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Caixa>

      <Caixa titulo="Documentos">
        {(pn.documentos ?? []).length > 0 ? (
          <ul className="grid gap-2">
            {pn.documentos!.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>{d.nome} {d.tamanho != null ? `(${tamanhoLegivel(d.tamanho)})` : ""}</span>
                <form action={revogarDocumento.bind(null, id, d.id)}>
                  <button type="submit" className={neutro}>Deixar de compartilhar</button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nenhum documento compartilhado.</p>
        )}
        {arquivos ? (
          <form action={compartilharDocumento.bind(null, id)} className="mt-4 flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-sm">
              Compartilhar um arquivo da pasta do processo
              <select name="arquivo" required className="h-10 rounded-xl border bg-white px-2">
                <option value="">Escolha…</option>
                {arquivos.filter((a) => !jaCompartilhados.has(a.id)).map((a) => (
                  <option key={a.id} value={a.id}>{a.nome}</option>
                ))}
              </select>
            </label>
            <button type="submit" className={primario}>Compartilhar</button>
          </form>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">{motivoSemArquivos}</p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Só aparecem arquivos que o próprio LAW enviou à pasta do processo. O cliente baixa pelo portal; nada fica público no Drive.</p>
      </Caixa>
    </div>
  );
}
