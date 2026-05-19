/**
 * Registra la migración 0001_init como baseline en la BD de producción.
 * Úsalo cuando la BD ya tiene tablas pero no hay historial de migraciones.
 *
 * Uso: pnpm tsx scripts/baseline-migration.ts
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const MIGRATION_NAME = "0001_init";
const MIGRATION_PATH = join(
  __dirname,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);

async function main() {
  const sql = readFileSync(MIGRATION_PATH, "utf-8");
  const checksum = createHash("sha256").update(sql).digest("hex");

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Crea la tabla de migraciones si aún no existe
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id"                  VARCHAR(36) PRIMARY KEY NOT NULL,
        "checksum"            VARCHAR(64) NOT NULL,
        "finished_at"         TIMESTAMPTZ,
        "migration_name"      VARCHAR(255) NOT NULL,
        "logs"                TEXT,
        "rolled_back_at"      TIMESTAMPTZ,
        "started_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Evita duplicados
    const { rowCount } = await client.query(
      `SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $1`,
      [MIGRATION_NAME]
    );

    if (rowCount && rowCount > 0) {
      console.log(`[baseline] La migración "${MIGRATION_NAME}" ya está registrada. No se hizo nada.`);
      return;
    }

    await client.query(
      `INSERT INTO "_prisma_migrations"
        (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES ($1, $2, now(), $3, NULL, NULL, now(), 1)`,
      [randomUUID(), checksum, MIGRATION_NAME]
    );

    console.log(`[baseline] ✓ Migración "${MIGRATION_NAME}" registrada como baseline.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[baseline] Error:", err.message);
  process.exit(1);
});
