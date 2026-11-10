import { z } from "zod";
import type { Demonstrativo } from "@/lib/calculos/calculos";
import { gerarPdf } from "@/lib/calculos/pdf";
import { exigirModulo } from "@/lib/contexto";

/** PDF do demonstrativo (o resultado salvo, sem recalcular). Exige a tela Cálculos; o banco confere de novo (RLS). */
export async function GET(_: Request, { params }: RouteContext<"/app/calculos/[id]/pdf">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return new Response("Não encontrado.", { status: 404 });
  const { supabase, vinculo } = await exigirModulo("calculos");
  const { data } = await supabase.from("calculo").select("titulo, data_calculo, resultado").eq("id", id).maybeSingle();
  if (!data) return new Response("Não encontrado.", { status: 404 });
  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const pdf = await gerarPdf(data.resultado as Demonstrativo, { escritorio: vinculo.escritorioNome, geradoEm: agora });
  const nome = `calculo-${String(data.data_calculo)}.pdf`;
  return new Response(Buffer.from(pdf), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${nome}"`, "cache-control": "no-store" },
  });
}
