import type { Metadata } from "next";
import { Urbanist } from "next/font/google";
import "./globals.css";

const urbanist = Urbanist({ variable: "--font-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "LAW — Gestão jurídica",
  description: "Publicações, prazos, processos e equipe do escritório num só lugar.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${urbanist.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
