import Link from "next/link";
import { Marca } from "./marca";

export function MolduraEntrada({ titulo, subtitulo, children }: { titulo: string; subtitulo?: string; children: React.ReactNode }) {
  return (
    <main className="grid flex-1 place-items-center px-4 py-10">
      <div className="w-full max-w-md rounded-[30px] bg-card p-8 shadow-sm">
        <Marca />
        <h1 className="mt-6 text-4xl font-medium tracking-tight">{titulo}</h1>
        {subtitulo ? <p className="mt-2 text-muted-foreground">{subtitulo}</p> : null}
        <div className="mt-6">{children}</div>
        <p className="mt-6 flex gap-3 text-xs text-muted-foreground">
          <Link href="/termos" className="underline">Termos</Link>
          <Link href="/privacidade" className="underline">Privacidade</Link>
        </p>
      </div>
    </main>
  );
}
