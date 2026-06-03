import { Router, type IRouter, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../lib/mcp-instance";
import { randomUUID } from "crypto";

export const mcpRouter: IRouter = Router();

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const sessions = new Map<string, Session>();

/**
 * POST /mcp — inicializa sesión o procesa una request JSON-RPC.
 */
mcpRouter.post("/", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Reutilizar sesión existente
    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Nueva sesión: generar ID, crear transport y server
    const newSessionId = randomUUID();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
    });

    const server = createMcpServer();

    // Limpiar solo cuando el transport se cierra definitivamente
    transport.onclose = () => {
      sessions.delete(newSessionId);
      server.close();
    };

    await server.connect(transport);

    // Guardar sesión ANTES de handleRequest para que esté disponible
    // en la respuesta si el cliente hace follow-up inmediato
    sessions.set(newSessionId, { server, transport });

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp/http] POST error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP server error" });
    }
  }
});

/**
 * GET /mcp — SSE para streaming de notificaciones servidor → cliente.
 */
mcpRouter.get("/", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing Mcp-Session-Id" });
    return;
  }

  try {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("[mcp/http] GET/SSE error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "SSE error" });
    }
  }
});

/**
 * DELETE /mcp — cierre explícito de sesión.
 */
mcpRouter.delete("/", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    sessions.delete(sessionId);
    try {
      await transport.handleRequest(req, res);
    } catch {
      res.status(200).json({ message: "Session closed" });
    }
  } else {
    res.status(200).json({ message: "No active session" });
  }
});
