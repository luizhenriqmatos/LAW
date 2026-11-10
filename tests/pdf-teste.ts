import { PDFDocument } from "pdf-lib";

/** PDF sintético para testes (nenhum dado real). */
export async function pdfDeTeste(paginas = 2, texto = "Contrato de teste") {
  const d = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) d.addPage([595, 842]).drawText(`${texto} - página ${i + 1}`, { x: 50, y: 700, size: 14 });
  return new Uint8Array(await d.save());
}
