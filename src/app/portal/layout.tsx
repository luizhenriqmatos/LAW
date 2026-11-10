import type { Metadata } from "next";
import { Marca } from "@/components/marca";

export const metadata: Metadata = {
  title: "Portal do cliente",
  robots: { index: false, follow: false },
};

export default function LayoutPortal({ children }: LayoutProps<"/portal">) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-5">
        <Marca href="/portal" />
        <span className="text-sm text-muted-foreground">Portal do cliente</span>
      </header>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 pb-10">{children}</div>
      <footer className="mx-auto w-full max-w-3xl px-4 pb-8 text-xs text-muted-foreground">
        As informações vêm do tribunal e do seu advogado e servem para você acompanhar o processo. Elas não substituem a orientação do seu advogado.
      </footer>
    </div>
  );
}
