import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { mesdessousRouter } from "./routes/mesdessous.routes";
import { syncProducts } from "./lib/sync-products";

const app = express();

app.use(express.json());

// Health check — sin autenticación
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Autenticación por Bearer token
app.use((req, res, next) => {
  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    console.error("[auth] API_KEY no está configurada en las variables de entorno");
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (token !== apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
});

app.use("/mesdessous", mesdessousRouter);

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.listen(PORT, () => {
  console.log(`[server] Catalog Service running on port ${PORT}`);

  // Sincronización automática cada 6 horas (solo en producción)
  if (process.env.NODE_ENV === "production") {
    // Ejecutar una vez al arrancar para tener el catálogo fresco
    syncProducts().catch((err) => console.error("[sync] Error en sync inicial:", err));

    // Cada 6 horas: 0 0,6,12,18 * * *
    cron.schedule("0 0,6,12,18 * * *", () => {
      console.log("[sync] Iniciando sync programado...");
      syncProducts().catch((err) => console.error("[sync] Error en sync programado:", err));
    });
    console.log("[sync] Scheduler activo — cada 6 horas");
  }
});
