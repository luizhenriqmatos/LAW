import type { NextConfig } from "next";

// Cache Components desligado: quase todas as telas dependem da sessão do usuário (cookies)
// e de RLS, então são renderizadas a cada requisição. Reavaliar quando houver páginas públicas cacheáveis.
const nextConfig: NextConfig = {
  // Envio de arquivos para o Drive (Documentos): o limite do LAW é 4 MB por arquivo (a Vercel corta em 4,5 MB); sobra margem para o formulário.
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
