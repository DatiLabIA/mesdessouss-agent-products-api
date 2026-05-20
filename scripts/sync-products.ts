/**
 * Script CLI de sincronización de productos.
 * La lógica reside en src/lib/sync-products.ts.
 *
 * Uso:  pnpm sync:products
 * Cron: 0 *\/6 * * * cd /app && pnpm sync:products >> /var/log/sync-products.log 2>&1
 */
import "dotenv/config";
import { syncProducts } from "../src/lib/sync-products";
import { prisma } from "../src/lib/prisma";

syncProducts()
  .catch((err) => { console.error("[sync] Error fatal:", err); process.exit(1); })
  .finally(() => prisma.$disconnect());

