import type { Metadata } from "next";
import { Marca } from "@/components/marca";
import { FormularioVerificar } from "./formulario";

export const metadata: Metadata = { title: "Verificar documento assinado" };

export default function PaginaVerificar() {
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <Marca />
      <h1 className="mt-6 text-4xl font-medium tracking-tight">Verificar documento assinado</h1>
      <p className="mt-2 text-muted-foreground">
        Envie o PDF final que você recebeu. O sistema calcula o SHA-256 do arquivo e confere com o hash registrado quando o envelope foi concluído.
        Se qualquer byte mudou, a verificação falha. Não é preciso entrar nem criar conta, e o arquivo não é guardado.
      </p>
      <div className="mt-6"><FormularioVerificar /></div>
      <p className="mt-6 text-xs text-muted-foreground">Assinatura eletrônica avançada (Lei 14.063/2020, art. 4º, II), não qualificada: não usa certificado ICP-Brasil.</p>
    </main>
  );
}
