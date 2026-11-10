import { sairDoPortal } from "./actions";

export function BotaoSair() {
  return (
    <form action={sairDoPortal}>
      <button type="submit" className="rounded-full px-4 py-2 text-sm font-medium hover:bg-white/70">
        Sair
      </button>
    </form>
  );
}
