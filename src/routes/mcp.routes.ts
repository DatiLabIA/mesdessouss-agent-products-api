import { Router, type IRouter, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../lib/mcp-instance";

export const mcpRouter: IRouter = Router();

/**
 * MCP over HTTP (Streamable HTTP transport) — stateless mode.
 * Un nuevo McpServer + transport por request: sin gestión de sesiones,
 * compatible con cualquier cliente MCP que soporte HTTP transport.
 *
 * Endpoint: POST /mcp  (el auth Bearer ya está aplicado en server.ts)
 */
mcpRouter.post("/", async (req: Request, res: Response) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no sessions
    });

    // Limpiar recursos cuando el response termina
    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp/http] Error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP server error" });
    }
  }
});

// GET y DELETE requeridos por la spec para notificaciones y terminación de sesión.
// En modo stateless retornamos 405.
mcpRouter.get("/", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Use POST for stateless MCP requests" });
});

mcpRouter.delete("/", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Use POST for stateless MCP requests" });
});
