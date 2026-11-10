import { cn } from "@/lib/utils";

export function SeloPrazo({ situacao, hoje }: { situacao: "aberto" | "cumprido" | "vencido" | "cancelado"; hoje?: boolean }) {
  const estilo = {
    aberto: hoje ? "bg-amber-100 text-amber-900 ring-amber-300" : "bg-sky-50 text-sky-800 ring-sky-200",
    vencido: "bg-red-100 text-red-800 ring-red-300",
    cumprido: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    cancelado: "bg-neutral-100 text-neutral-600 ring-neutral-300",
  }[situacao];
  const rotulo = { aberto: hoje ? "Vence hoje" : "Aberto", vencido: "Vencido", cumprido: "Cumprido", cancelado: "Cancelado" }[situacao];
  return <span className={cn("inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1", estilo)}>{rotulo}</span>;
}
