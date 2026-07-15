import { createMcpHandler } from 'mcp-handler';
import { registerBahnMcpTools } from '@/lib/mcp-tools';

// MCP-Server (Streamable HTTP). Erreichbar unter /api/mcp.
// Das dynamische [transport]-Segment kollidiert nicht mit /api/chat, weil
// statische Routen in Next.js Vorrang vor dynamischen haben.
export const runtime = 'nodejs';
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    registerBahnMcpTools(server);
  },
  {
    serverInfo: {
      name: 'zuegli',
      version: '0.1.0',
    },
  },
  {
    basePath: '/api',
    maxDuration: 60,
  },
);

export { handler as GET, handler as POST };
