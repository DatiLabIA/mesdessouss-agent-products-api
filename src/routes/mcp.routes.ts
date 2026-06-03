import { Router, type IRouter, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../lib/mcp-instance";
import { randomUUID } from "crypto";

export const mcpRouter: IRouter = Router();

// Mapa de sesiones activas: sessionId → { server, transport }
// Permite que Claude.ai use SSE (GET) para streaming de respuestas
const sessions = new Map<string, { transport: StreamableHTTPServerTransport }>();

/**
 * POST /mcp — inicia una sesión o procesa una request JSON-RPC.
 * Si el cliente envía Mcp-Session-Id, reutiliza el transport existente.
 * Si no, crea uno nuevo (stateful cuando el cliente lo pide, stateless si no).
 */
mcpRouter.post("/", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && sessions.has(sessionId)) {
      // Reutilizar transport de sesión existente
      transport = sessions.get(sessionId)!.transport;
    } else {
      // Nueva sesión
      const newSessionId = randomUUID();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
      });

      const server = createMcpServer();

      res.on("close", () => {
        sessions.delete(newSessionId);
        transport.close();
        server.close();
      });

      await server.connect(transport);
      sessions.set(newSessionId, { transport });
    }

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
 * Requerido por Claude.ai y otros clientes MCP modernos.
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
 * DELETE /mcp — cierre explícito de sesión por parte del cliente.
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
