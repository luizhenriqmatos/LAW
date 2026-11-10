import { MolduraEntrada } from "@/components/moldura-entrada";

export default function ConfiguracaoPendente() {
  return (
    <MolduraEntrada titulo="Configuração pendente" subtitulo="O LAW ainda não está ligado ao banco de dados.">
      <p className="text-sm text-muted-foreground">
        Preencha <code>NEXT_PUBLIC_SUPABASE_URL</code> e <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> no arquivo
        <code> .env.local</code> (modelo em <code>.env.example</code>) e reinicie o servidor. Pendência P-015.
      </p>
    </MolduraEntrada>
  );
}
