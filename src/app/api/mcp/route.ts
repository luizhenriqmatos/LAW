import { atenderMcp } from "@/lib/mcp/http";
import { depsMcpDoAmbiente } from "@/lib/mcp/ambiente";

// Servidor MCP remoto do LAW (Prompt 12). Sem estado: cada POST traz o token e é conferido no banco.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const atender = (req: Request) => atenderMcp(req, depsMcpDoAmbiente());
export { atender as POST, atender as GET, atender as DELETE };
