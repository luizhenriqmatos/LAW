/**
 * Teste AO VIVO contra o DJEN e o DataJud reais (critério de pronto do Prompt 2).
 * Precisa rodar de uma máquina no Brasil: o DJEN recusa acesso de fora (HTTP 403).
 *
 *   npm run captura:ao-vivo -- --oab 54321 --uf BA --dias 7
 *
 * Faz a busca duas vezes e mostra que a segunda não traz nada novo (mesmo hash de deduplicação do job),
 * depois consulta no DataJud o primeiro processo encontrado. Não grava nada no banco.
 */
import { FonteDjen } from "../src/lib/integrations/fontes/djen";
import { FonteDataJud } from "../src/lib/integrations/fontes/datajud";
import { formatarCnj } from "../src/lib/integrations/fontes/cnj";
import { dataBrasilia, somarDias } from "../src/lib/integrations/fontes/datas";
import { paraLinha } from "../src/lib/captura/job";

function argumento(nome: string, padrao?: string): string {
  const i = process.argv.indexOf(`--${nome}`);
  const v = i >= 0 ? process.argv[i + 1] : padrao;
  if (!v) {
    console.error(`Informe --${nome}. Ex.: npm run captura:ao-vivo -- --oab 54321 --uf BA --dias 7`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const oab = { numero: argumento("oab"), uf: argumento("uf").toUpperCase() };
  const dias = Number(argumento("dias", "7"));
  const hoje = dataBrasilia(new Date());
  const desde = new Date(`${somarDias(hoje, -dias)}T15:00:00Z`);
  const djen = new FonteDjen();

  console.log(`DJEN: OAB ${oab.numero}/${oab.uf}, de ${somarDias(hoje, -dias)} a ${hoje}…`);
  const vistos = new Set<string>();
  for (const rodada of [1, 2]) {
    const pubs = await djen.buscarPublicacoes({ oab, desde });
    let novas = 0;
    for (const p of pubs) {
      const h = paraLinha(p).hash;
      if (!vistos.has(h)) { vistos.add(h); novas++; }
    }
    console.log(`Rodada ${rodada}: ${pubs.length} encontradas, ${novas} novas, ${pubs.length - novas} repetidas.`);
    if (rodada === 1) {
      for (const p of pubs.slice(0, 5)) {
        console.log(`  · ${p.dataDisponibilizacao} ${p.tribunal} ${p.tipoComunicacao ?? ""} ${p.numeroCnj ? formatarCnj(p.numeroCnj) : "(sem nº)"} — ${p.texto.slice(0, 100).replace(/\s+/g, " ")}…`);
      }
      const primeiro = pubs.find((p) => p.numeroCnj)?.numeroCnj;
      if (primeiro) {
        const dj = new FonteDataJud({ apiKey: process.env.DATAJUD_API_KEY });
        try {
          const meta = await dj.buscarProcesso(primeiro);
          console.log(meta
            ? `DataJud ${formatarCnj(primeiro)}: ${meta.classe.nome} · ${meta.orgaoJulgador} · ${meta.movimentos.length} movimentos`
            : `DataJud ${formatarCnj(primeiro)}: não encontrado (pode ser sigiloso ou ainda não enviado pelo tribunal).`);
        } catch (e) {
          console.log(`DataJud falhou (não afeta as publicações): ${(e as Error).message}`);
        }
      }
    }
  }
}

main().catch((e) => {
  console.error(`Falhou: ${(e as Error).message}`);
  process.exit(1);
});
