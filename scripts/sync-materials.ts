/**
 * Script CLI de enriquecimiento de materiales.
 * La lógica reside en src/lib/sync-materials.ts.
 *
 * Uso:  pnpm sync:materials
 */
import "dotenv/config";
import { syncMaterials } from "../src/lib/sync-materials";
import { prisma } from "../src/lib/prisma";

syncMaterials()
  .catch((err) => { console.error("[sync-mat] Error fatal:", err); process.exit(1); })
  .finally(() => prisma.$disconnect());
