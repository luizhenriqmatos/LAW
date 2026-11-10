import Link from "next/link";
import { MODULOS } from "@/lib/modulos";

export default async function SemAcesso({ searchParams }: PageProps<"/app/sem-acesso">) {
  const { modulo } = await searchParams;
  const nome = modulo === "equipe" ? "Equipe e permissões" : MODULOS.find((m) => m.id === modulo)?.rotulo ?? "esta tela";
  return (
    <div className="mx-auto max-w-xl rounded-[30px] bg-white p-8">
      <h1 className="text-3xl font-medium tracking-tight">Sem acesso</h1>
      <p className="mt-3 text-muted-foreground">
        Você não tem permissão para abrir <strong className="text-foreground">{nome}</strong>. Peça ao dono do escritório para liberar.
      </p>
      <Link href="/app" className="mt-6 inline-flex h-10 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground">
        Voltar ao painel
      </Link>
    </div>
  );
}
