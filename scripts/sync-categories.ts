/**
 * Script CLI de sincronización de categorías.
 * La lógica reside en src/lib/sync-categories.ts.
 *
 * Uso:  pnpm sync:categories
 */
import "dotenv/config";
import { syncCategories } from "../src/lib/sync-categories";
import { prisma } from "../src/lib/prisma";

syncCategories()
  .catch((err) => { console.error("[sync-cat] Error fatal:", err); process.exit(1); })
  .finally(() => prisma.$disconnect());
