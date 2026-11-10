"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { COOKIE_ESCRITORIO, obterContexto } from "@/lib/contexto";

export async function trocarEscritorio(dados: FormData) {
  const id = z.string().uuid().safeParse(dados.get("escritorio"));
  const { vinculos } = await obterContexto();
  // Só aceita escritório do qual o usuário é membro.
  if (id.success && vinculos.some((v) => v.escritorioId === id.data)) {
    (await cookies()).set(COOKIE_ESCRITORIO, id.data, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  }
  redirect("/app");
}
