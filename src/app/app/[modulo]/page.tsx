import { notFound } from "next/navigation";
import { exigirModulo } from "@/lib/contexto";
import { MODULOS } from "@/lib/modulos";

// Em qual prompt do pacote cada módulo ganha conteúdo.
const PROXIMO: Record<string, string> = {
  configuracoes: "Prompt 14",
};

export default async function PaginaModulo({ params }: PageProps<"/app/[modulo]">) {
  const { modulo: segmento } = await params;
  const modulo = MODULOS.find((m) => m.rota === `/app/${segmento}`);
  if (!modulo || modulo.id === "financeiro" || modulo.id === "processos" || modulo.id === "prazos" || modulo.id === "agenda" || modulo.id === "tarefas" || modulo.id === "documentos" || modulo.id === "portal_cliente" || modulo.id === "assinaturas" || modulo.id === "assistente" || modulo.id === "atendimento") notFound();
  // Camada 2 (rota): sem permissão, não renderiza nada do módulo.
  await exigirModulo(modulo.id);
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-5xl font-medium tracking-tight">{modulo.rotulo}</h1>
      <p className="mt-4 rounded-[26px] bg-white p-6 text-muted-foreground">
        Este módulo ainda está sendo construído ({PROXIMO[modulo.id]}). O acesso já respeita as permissões da equipe.
      </p>
    </div>
  );
}
