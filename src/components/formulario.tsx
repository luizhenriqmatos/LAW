"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type EstadoFormulario = { erro?: string; ok?: string; link?: string } | undefined;

export function BotaoEnviar({ children, className, variante = "default" }: { children: React.ReactNode; className?: string; variante?: "default" | "outline" | "secondary" | "destructive" | "ghost" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variante} disabled={pending} className={cn("h-10 rounded-full px-5", className)}>
      {pending ? "Aguarde…" : children}
    </Button>
  );
}

export function Campo({ rotulo, nome, ajuda, ...props }: { rotulo: string; nome: string; ajuda?: string } & React.ComponentProps<"input">) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={nome}>{rotulo}</Label>
      <Input id={nome} name={nome} className="h-10 rounded-xl bg-white" {...props} />
      {ajuda ? <p className="text-xs text-muted-foreground">{ajuda}</p> : null}
    </div>
  );
}

export function Mensagem({ estado }: { estado: EstadoFormulario }) {
  if (!estado?.erro && !estado?.ok) return null;
  return (
    <p role={estado.erro ? "alert" : "status"} className={cn("rounded-xl px-3 py-2 text-sm font-medium", estado.erro ? "bg-red-50 text-red-700" : "bg-accent text-accent-foreground")}>
      {estado.erro ?? estado.ok}
    </p>
  );
}
