import { PGlite, type Transaction } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RAIZ = join(__dirname, "..", "..");

/** Postgres em memória com o "mínimo do Supabase" + todas as migrações em ordem. */
export async function criarBanco(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readFileSync(join(__dirname, "supabase-stub.sql"), "utf8"));
  const pasta = join(RAIZ, "supabase", "migrations");
  for (const arq of readdirSync(pasta).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(pasta, arq), "utf8"));
  }
  return db;
}

/** Cria usuário em auth.users (como o Supabase Auth faria). */
export async function criarUsuario(db: PGlite, id: string, email: string) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
}

/**
 * Roda `fn` como o papel `authenticated` com o JWT do usuário — exatamente o que acontece
 * quando o app chama o Supabase com o token dele. RLS vale integralmente aqui.
 */
export async function comoUsuario<T>(db: PGlite, usuarioId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: usuarioId, role: "authenticated" }),
    ]);
    return fn(tx);
  });
}

/** Igual a comoUsuario, mas sem login (papel anon). */
export async function comoAnonimo<T>(db: PGlite, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("set local role anon");
    return fn(tx);
  });
}

/** RPC como o job faz em produção (papel service_role, sem RLS). Objetos viram JSON; listas de texto vão como array. */
export function rpcComoServico(db: PGlite) {
  return async <T,>(funcao: string, args: Record<string, unknown>): Promise<T> => {
    const nomes = Object.keys(args);
    const valores = nomes.map((n) => {
      const v = args[n];
      // bytea: a API do Supabase recebe "\\x..." (hexadecimal); o PGlite exige bytes.
      if (typeof v === "string" && /^\\x([0-9a-fA-F]{2})+$/.test(v)) return Uint8Array.from(Buffer.from(v.slice(2), "hex"));
      const ehListaDeTexto = Array.isArray(v) && v.every((x) => typeof x === "string");
      return v !== null && typeof v === "object" && !ehListaDeTexto ? JSON.stringify(v) : v;
    });
    const sql = `select public.${funcao}(${nomes.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`;
    return db.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      const res = await tx.query<{ r: T }>(sql, valores);
      return res.rows[0]?.r as T;
    });
  };
}
