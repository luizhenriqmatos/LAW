import { redirect } from "next/navigation";
import { connection } from "next/server";
import { supabaseConfigurado } from "@/lib/supabase/config";

export default async function LayoutEntrada({ children }: LayoutProps<"/">) {
  await connection();
  if (!supabaseConfigurado()) redirect("/configuracao-pendente");
  return children;
}
