import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { mesdessousRouter } from "./routes/mesdessous.routes";
import { adminRouter } from "./routes/admin.routes";
import { mcpRouter } from "./routes/mcp.routes";
import { syncProducts } from "./lib/sync-products";

const app = express();

// 1. CORS primero — antes de todo, incluido auth
// El preflight OPTIONS debe pasar sin autenticación
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// 2. Parseo de body
app.use(express.json());

// 3. Health check — sin autenticación
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 4. Autenticación por Bearer token (después de CORS y health)
app.use((req, res, next) => {
  // Dejar pasar preflights OPTIONS — CORS ya los manejó
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    console.error("[auth] API_KEY no está configurada en las variables de entorno");
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  // Permite API key también como query param ?key=... para clientes MCP remotos
  // que no soporten headers personalizados (ej: Claude.ai connector)
  const queryToken = typeof req.query.key === "string" ? req.query.key : null;
  const token = bearerToken ?? queryToken;

  if (token !== apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
});

app.use("/mesdessous", mesdessousRouter);
app.use("/admin", adminRouter);
app.use("/mcp", mcpRouter);

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.listen(PORT, () => {
  console.log(`[server] Catalog Service running on port ${PORT}`);

  if (process.env.NODE_ENV === "production") {
    syncProducts().catch((err) => console.error("[sync] Error en sync inicial:", err));

    cron.schedule("0 0,6,12,18 * * *", () => {
      console.log("[sync] Iniciando sync programado...");
      syncProducts().catch((err) => console.error("[sync] Error en sync programado:", err));
    });
    console.log("[sync] Scheduler activo — cada 6 horas");
  }
});