import Link from "next/link";
import { exigirDono } from "@/lib/contexto";
import { whatsappConfigurado } from "@/lib/integrations/whatsapp";
import { urlBase } from "@/lib/oauth/config";
import { AvisoAtendimento } from "../comum";
import { salvarConfiguracao, salvarNumero } from "../actions";

export default async function Configurar({ searchParams }: PageProps<"/app/atendimentos/configurar">) {
  const sp = await searchParams;
  const { supabase, vinculo } = await exigirDono();
  const [{ data: cfg }, { data: numeros }, { data: membros }] = await Promise.all([
    supabase.from("recepcao_config").select("ativa, responsavel_id, prazo_resposta_texto, horario_texto, modelo_retomada, modelo_idioma").eq("escritorio_id", vinculo.escritorioId).maybeSingle(),
    supabase.from("whatsapp_numero").select("id, phone_number_id, numero_exibicao, ativo").eq("escritorio_id", vinculo.escritorioId),
    supabase.from("membro").select("usuario_id, nome, email").eq("escritorio_id", vinculo.escritorioId),
  ]);
  const base = urlBase();
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/app/atendimentos" className="text-sm text-muted-foreground hover:underline">← Atendimentos</Link>
      <h1 className="mt-2 text-4xl font-medium tracking-tight">Recepcionista do WhatsApp</h1>
      <AvisoAtendimento codigo={sp.aviso} />

      <section className="mt-5 rounded-[26px] bg-white p-6 text-sm">
        <h2 className="text-lg font-semibold">Ligação com o WhatsApp (Meta)</h2>
        {whatsappConfigurado() ? <p className="mt-2">O servidor está com as chaves da Meta configuradas.</p> : (
          <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-amber-950">O servidor ainda não tem as chaves da Meta. Sem elas, nada é recebido nem enviado. Avise o responsável pelo sistema.</p>
        )}
        <p className="mt-3">No painel da Meta (WhatsApp &gt; Configuração), use este endereço de webhook e assine o campo <strong>messages</strong>:</p>
        <code className="mt-2 block break-all rounded-xl bg-muted px-3 py-2 text-[13px]">{base ? `${base}/api/whatsapp` : "(defina a URL pública do LAW no servidor)"}</code>
        <h3 className="mt-5 font-semibold">Números do escritório</h3>
        <ul className="mt-2 grid gap-1">
          {(numeros ?? []).map((n) => <li key={n.id}>{n.numero_exibicao || "Sem rótulo"} · ID {n.phone_number_id} · {n.ativo ? "ativo" : "desligado"}</li>)}
          {!numeros?.length ? <li className="text-muted-foreground">Nenhum número cadastrado.</li> : null}
        </ul>
        <form action={salvarNumero} className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
          <label className="grid gap-1">ID do número (Meta)<input name="phone_number_id" required pattern="\d{5,24}" className="h-10 rounded-xl border px-3" /></label>
          <label className="grid gap-1">Como mostrar<input name="exibicao" maxLength={30} className="h-10 rounded-xl border px-3" /></label>
          <label className="flex h-10 items-center gap-2"><input type="checkbox" name="ativo" defaultChecked /> Ativo</label>
          <button className="h-10 rounded-full bg-primary px-5 font-medium text-primary-foreground">Salvar número</button>
        </form>
      </section>

      <section className="mt-5 rounded-[26px] bg-white p-6 text-sm">
        <h2 className="text-lg font-semibold">Como a recepcionista atende</h2>
        <p className="mt-2 text-muted-foreground">
          Ela cumprimenta com o nome do escritório, pergunta o motivo, anota, avisa a equipe e para de responder. Só usa frases fixas: nunca dá orientação jurídica,
          opinião sobre o caso, informação de processo nem promete prazo por conta própria.
        </p>
        <form action={salvarConfiguracao} className="mt-4 grid gap-3">
          <label className="flex items-start gap-2"><input type="checkbox" name="ativa" defaultChecked={cfg?.ativa ?? false} className="mt-1" /><span><strong>Ligar a recepcionista.</strong> Desligada, as mensagens recebidas não são respondidas nem guardadas.</span></label>
          <label className="grid gap-1">Quem recebe o aviso de cada atendimento novo
            <select name="responsavel_id" defaultValue={cfg?.responsavel_id ?? ""} className="h-10 rounded-xl border bg-white px-2">
              <option value="">Todos os donos do escritório</option>
              {(membros ?? []).map((m) => <option key={m.usuario_id} value={m.usuario_id}>{m.nome || m.email}</option>)}
            </select>
          </label>
          <label className="grid gap-1">Frase sobre prazo de resposta (opcional)
            <input name="prazo_resposta_texto" maxLength={160} defaultValue={cfg?.prazo_resposta_texto ?? ""} placeholder="Ex.: Retornamos em até 1 dia útil." className="h-10 rounded-xl border px-3" />
            <span className="text-xs text-muted-foreground">Vazio = a recepcionista não fala de prazo. O que você escrever aqui é repetido como está.</span>
          </label>
          <label className="grid gap-1">Frase sobre horário de atendimento (opcional)
            <input name="horario_texto" maxLength={160} defaultValue={cfg?.horario_texto ?? ""} placeholder="Ex.: Atendemos de segunda a sexta, das 9h às 18h." className="h-10 rounded-xl border px-3" />
          </label>
          <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
            <label className="grid gap-1">Modelo de retomada aprovado na Meta
              <input name="modelo_retomada" maxLength={200} pattern="[a-z0-9_]*" defaultValue={cfg?.modelo_retomada ?? ""} placeholder="ex.: retomada_atendimento" className="h-10 rounded-xl border px-3" />
              <span className="text-xs text-muted-foreground">Usado só depois de 24 h sem mensagem da pessoa. Cadastre o modelo sem variáveis.</span>
            </label>
            <label className="grid gap-1">Idioma<input name="modelo_idioma" defaultValue={cfg?.modelo_idioma ?? "pt_BR"} className="h-10 rounded-xl border px-3" /></label>
          </div>
          <button className="h-10 w-fit rounded-full bg-primary px-5 font-medium text-primary-foreground">Salvar</button>
        </form>
      </section>
    </div>
  );
}
