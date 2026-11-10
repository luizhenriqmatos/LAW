import Link from "next/link";

export function Marca({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1.5 text-2xl font-bold tracking-tight">
      LAW
      <span aria-hidden className="size-3 rounded-full bg-accent ring-2 ring-primary" />
    </Link>
  );
}
