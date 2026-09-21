/**
 * Seed inicial del motor de reglas de pedidos/retornos (T6) desde
 * src/data/order-rules-seed.ts, fuente de la verdad:
 * docs/reglas-lia-pedidos-retornos.md.
 *
 * Crea un RuleSet versión 1 para "mesdessous" en estado "draft" (nunca
 * "active": activar es una decisión deliberada aparte, y el índice único
 * parcial `rule_sets_one_active_per_client` garantiza un solo activo por
 * cliente). Idempotente: si ya existe la versión 1 para ese cliente, no
 * inserta nada de nuevo.
 *
 * Usage:
 *   pnpm seed:rules
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  RULES_SEED_CLIENT_ID,
  RULES_SEED_VERSION,
  stateGroupSeed,
  brandLeadTimeSeed,
  ruleDecisionSeed,
  ruleSettingSeed,
  ruleTemplateSeed,
} from "../src/data/order-rules-seed";

async function main(): Promise<void> {
  const existing = await prisma.ruleSet.findUnique({
    where: {
      clientId_version: {
        clientId: RULES_SEED_CLIENT_ID,
        version: RULES_SEED_VERSION,
      },
    },
  });

  if (existing) {
    console.log(
      `[seed-rules] Ya existe un RuleSet v${RULES_SEED_VERSION} para "${RULES_SEED_CLIENT_ID}" ` +
        `(id=${existing.id}, status=${existing.status}). No se siembra de nuevo.`,
    );
    await prisma.$disconnect();
    return;
  }

  console.log(
    `[seed-rules] Sembrando RuleSet v${RULES_SEED_VERSION} (draft) para "${RULES_SEED_CLIENT_ID}"...\n`,
  );

  const created = await prisma.$transaction(async (tx) => {
    return tx.ruleSet.create({
      data: {
        clientId: RULES_SEED_CLIENT_ID,
        version: RULES_SEED_VERSION,
        status: "draft",
        note: "Siembra inicial desde docs/reglas-lia-pedidos-retornos.md (T6). No activar sin revisión.",
        stateGroups: { createMany: { data: stateGroupSeed } },
        brandLeadTimes: { createMany: { data: brandLeadTimeSeed } },
        decisions: { createMany: { data: ruleDecisionSeed } },
        templates: { createMany: { data: ruleTemplateSeed } },
        settings: { createMany: { data: ruleSettingSeed } },
      },
      include: {
        stateGroups: true,
        brandLeadTimes: true,
        decisions: true,
        templates: true,
        settings: true,
      },
    });
  });

  console.log(`[seed-rules] RuleSet creado: id=${created.id}, status=${created.status}\n`);
  console.log("[seed-rules] Resumen de lo insertado:");
  console.log(`  - Grupos de estado (RuleStateGroup): ${created.stateGroups.length}`);
  console.log(`  - Plazos por marca (RuleBrandLeadTime): ${created.brandLeadTimes.length}`);
  console.log(`  - Filas de la matriz de decisión (RuleDecision): ${created.decisions.length}`);
  console.log(`  - Plantillas (RuleTemplate): ${created.templates.length}`);
  console.log(`  - Ajustes (RuleSetting): ${created.settings.length}`);
  console.log(
    "\n[seed-rules] Conjunto creado en estado 'draft'. Activarlo es una decisión deliberada aparte.",
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[seed-rules] Fatal error:", err);
  await prisma.$disconnect();
  process.exit(1);
});
