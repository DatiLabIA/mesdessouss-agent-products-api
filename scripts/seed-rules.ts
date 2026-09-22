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
import { frenchPublicHolidays } from "../src/lib/business-days";
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

  // Va ANTES de la guarda de idempotencia a propósito: los festivos son
  // independientes del RuleSet, así que deben sembrarse aunque el conjunto ya
  // exista. Colgarlos detrás del `return` hacía que una resiembra nunca los creara.
  // Festivos: no cuelgan del RuleSet porque son hechos de calendario, no decisiones
  // de negocio. Se siembran aparte y son idempotentes (únicos por cliente+día).
  //
  // Sin esta tabla poblada, el cálculo de días hábiles cuenta el 14 de julio y el 15
  // de agosto como laborables: las fechas límite salen optimistas y un pedido puede
  // marcarse como retrasado antes de tiempo, disparando el mail equivocado.
  const desde = new Date().getUTCFullYear() - 1;
  const festivos = [];
  for (let year = desde; year <= desde + 3; year += 1) {
    for (const h of frenchPublicHolidays(year)) {
      festivos.push({ clientId: RULES_SEED_CLIENT_ID, day: new Date(`${h.day}T00:00:00.000Z`), label: h.label });
    }
  }
  const { count: festivosInsertados } = await prisma.ruleHoliday.createMany({
    data: festivos,
    skipDuplicates: true,
  });
  console.log(`  - Festivos de Francia ${desde}-${desde + 3} (RuleHoliday): ${festivosInsertados} nuevos de ${festivos.length}`);

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
