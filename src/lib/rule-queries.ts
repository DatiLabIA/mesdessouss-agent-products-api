import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { getMany } from "./prestashop-client";
import { normalizeBrandKey } from "./brand-normalize";
import {
  stateGroupSeed,
  brandLeadTimeSeed,
  ruleDecisionSeed,
  ruleTemplateSeed,
  ruleSettingSeed,
  type StateGroupCode,
  type BrandLeadTimeSeed,
  type RuleDecisionSeed,
  type RuleTemplateSeed,
  type RuleSettingSeed,
} from "../data/order-rules-seed";
import {
  buildLoadedRuleSet,
  parseOrThrow,
  ruleSetRowSchemas,
  RuleSetActivationConflictError,
  RuleSetNotFoundError,
  RuleSetStateError,
  RuleSetValidationError,
  type LoadedRuleSet,
} from "./rule-set-validation";

/**
 * Capa de acceso al motor de reglas: carga del conjunto activo (con caché),
 * ciclo de vida de borradores/publicación, y el chequeo de cobertura de marcas.
 *
 * Mismo patrón que `policy-queries.ts`: la lógica vive acá, las tools MCP de
 * `mcp-instance.ts` son una capa fina encima. La validación y conversión de
 * filas crudas vive en `./rule-set-validation` (sin Prisma, para poder
 * testearla sin base de datos); este módulo la reexporta entera para que
 * quien importe `rule-queries.ts` no tenga que saber que la división existe.
 *
 * Regla dura (task doc, Fase 2): NINGUNA función de acá puede modificar un
 * conjunto con `status: "active"`. La única vía para cambiar reglas activas es
 * clonar con `createRuleDraft`, editar el borrador, `simulate_rules` contra
 * pedidos reales, y recién ahí `activateRuleSet`. Se aplica en `assertDraft`,
 * que corren todos los setters antes de tocar una fila.
 */
export * from "./rule-set-validation";

// ─── Caché en memoria del conjunto activo ────────────────────────────────
//
// TTL corto (60s): "nadie quiere seis consultas por cada pregunta de un
// cliente". Toda función de escritura invalida explícitamente la entrada del
// cliente que tocó; el TTL es solo la red de seguridad para una publicación
// hecha desde OTRO proceso (dos réplicas del microservicio, por ejemplo).

const RULE_SET_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: LoadedRuleSet;
  expiresAt: number;
}

const activeRuleSetCache = new Map<string, CacheEntry>();

function getCachedActiveRuleSet(clientId: string): LoadedRuleSet | null {
  const entry = activeRuleSetCache.get(clientId);
  if (entry === undefined) return null;
  if (Date.now() >= entry.expiresAt) {
    activeRuleSetCache.delete(clientId);
    return null;
  }
  return entry.value;
}

function setCachedActiveRuleSet(clientId: string, value: LoadedRuleSet): void {
  activeRuleSetCache.set(clientId, { value, expiresAt: Date.now() + RULE_SET_CACHE_TTL_MS });
}

/** Invalida la caché del conjunto activo de `clientId`. La llama toda función de escritura de este módulo. */
export function invalidateRuleSetCache(clientId: string): void {
  activeRuleSetCache.delete(clientId);
}

// ─── Carga ────────────────────────────────────────────────────────────────

const RULE_SET_INCLUDE = {
  stateGroups: true,
  brandLeadTimes: true,
  decisions: true,
  templates: true,
  settings: true,
} as const;

async function fetchHolidayRows(clientId: string) {
  // Los festivos no cuelgan de un RuleSet (son hechos de calendario, no
  // decisiones de negocio: ver el comentario de `RuleHoliday` en el esquema),
  // así que se leen siempre por `clientId`, nunca por versión.
  return prisma.ruleHoliday.findMany({ where: { clientId } });
}

/**
 * Carga el conjunto de reglas ACTIVO de `clientId`, ya validado y convertido a
 * las formas que esperan `computeOrderFacts`/`evaluateRules`/`buildGuidance`.
 * Cacheado 60s; ver `invalidateRuleSetCache`.
 *
 * Lanza `RuleSetNotFoundError` si no hay ningún conjunto activo, y
 * `RuleSetValidationError` si el conjunto activo (que en teoría ya fue
 * validado al activarse) resultara inválido igual — defensa en profundidad,
 * nunca se confía ciegamente en que lo que hay en base sigue siendo válido.
 */
export async function loadActiveRuleSet(clientId: string): Promise<LoadedRuleSet> {
  const cached = getCachedActiveRuleSet(clientId);
  if (cached !== null) return cached;

  const ruleSet = await prisma.ruleSet.findFirst({
    where: { clientId, status: "active" },
    include: RULE_SET_INCLUDE,
  });
  if (ruleSet === null) {
    throw new RuleSetNotFoundError(
      `No hay ningún conjunto de reglas activo para "${clientId}": no se puede evaluar ninguna consulta ` +
        "de pedido sin uno. Sembralo con `pnpm seed:rules` (queda en draft) y activalo con activate_rule_set."
    );
  }

  const holidayRows = await fetchHolidayRows(clientId);
  const loaded = buildLoadedRuleSet(ruleSet, holidayRows);

  setCachedActiveRuleSet(clientId, loaded);
  return loaded;
}

/**
 * Carga cualquier versión de `clientId` (draft, active o archived) ya validada
 * y convertida, o el activo si no se indica versión. A diferencia de
 * `loadActiveRuleSet`, nunca cachea: se usa para `simulate_rules` justo
 * después de editar un borrador, y una respuesta cacheada sería la razón por
 * la que "simulé y no vi mi cambio".
 */
export async function loadRuleSetForSimulation(clientId: string, version?: number): Promise<LoadedRuleSet> {
  if (version === undefined) {
    return loadActiveRuleSet(clientId);
  }

  const ruleSet = await prisma.ruleSet.findUnique({
    where: { clientId_version: { clientId, version } },
    include: RULE_SET_INCLUDE,
  });
  if (ruleSet === null) {
    throw new RuleSetNotFoundError(`No existe ningún conjunto de reglas v${version} para "${clientId}".`);
  }

  const holidayRows = await fetchHolidayRows(clientId);
  return buildLoadedRuleSet(ruleSet, holidayRows);
}

// ─── Lectura para las tools list_rule_sets / get_rules ───────────────────

export interface RuleSetSummary {
  version: number;
  status: string;
  note: string | null;
  createdAt: Date;
  activatedAt: Date | null;
}

/** Lista todos los conjuntos (draft/active/archived) de `clientId`, más recientes primero. */
export async function listRuleSets(clientId: string): Promise<RuleSetSummary[]> {
  return prisma.ruleSet.findMany({
    where: { clientId },
    orderBy: { version: "desc" },
    select: { version: true, status: true, note: true, createdAt: true, activatedAt: true },
  });
}

/**
 * Devuelve el contenido crudo (sin pasar por la validación fail-closed) de un
 * conjunto de reglas, para inspección humana o del modelo: el activo si no se
 * indica versión, o la versión pedida sea cual sea su estado. A propósito NO
 * usa `buildLoadedRuleSet`: `get_rules` tiene que poder mostrar un borrador
 * roto tal cual está, para que el editor vea qué arreglar, en vez de fallar
 * con el mismo error que ya le daría `simulate_rules`/`activate_rule_set`.
 */
export async function getRuleSetDetail(clientId: string, version?: number) {
  const ruleSet =
    version === undefined
      ? await prisma.ruleSet.findFirst({ where: { clientId, status: "active" }, include: RULE_SET_INCLUDE })
      : await prisma.ruleSet.findUnique({
          where: { clientId_version: { clientId, version } },
          include: RULE_SET_INCLUDE,
        });

  if (ruleSet === null) {
    throw new RuleSetNotFoundError(
      version === undefined
        ? `No hay ningún conjunto de reglas activo para "${clientId}".`
        : `No existe ningún conjunto de reglas v${version} para "${clientId}".`
    );
  }

  const holidays = await fetchHolidayRows(clientId);

  return {
    version: ruleSet.version,
    status: ruleSet.status,
    note: ruleSet.note,
    createdAt: ruleSet.createdAt,
    activatedAt: ruleSet.activatedAt,
    stateGroups: [...ruleSet.stateGroups].sort((a, b) => a.orderStateId - b.orderStateId),
    brandLeadTimes: [...ruleSet.brandLeadTimes].sort((a, b) => a.brand.localeCompare(b.brand)),
    decisions: [...ruleSet.decisions].sort((a, b) => a.priority - b.priority),
    templates: ruleSet.templates,
    settings: ruleSet.settings,
    holidays: [...holidays].sort((a, b) => a.day.getTime() - b.day.getTime()),
  };
}

// ─── Borradores y publicación ─────────────────────────────────────────────

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Dos `create_rule_draft` concurrentes calcularon el mismo número de versión: la segunda pierde la carrera. */
export class RuleSetVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSetVersionConflictError";
  }
}

export interface RuleDraftCreated {
  version: number;
  /** De dónde se clonó: el activo del cliente, o la siembra en código si todavía no hay ningún activo. */
  clonedFrom: "active" | "seed";
}

/**
 * Crea un borrador nuevo clonando el conjunto ACTIVO del cliente, o la siembra
 * en código (`src/data/order-rules-seed.ts`) si todavía no hay ningún activo
 * (instalación nueva, o el conjunto sembrado por `pnpm seed:rules` sigue en
 * draft sin activar). Nunca clona otro borrador ni un archivado: la Fase 2 del
 * task doc solo habla de "el activo o la siembra".
 *
 * La versión nueva es `max(version) + 1` sobre TODOS los conjuntos del
 * cliente (draft, active y archived), para no repetir nunca un número.
 */
export async function createRuleDraft(clientId: string, note: string): Promise<RuleDraftCreated> {
  const trimmedNote = note.trim();
  if (trimmedNote.length === 0) {
    throw new RuleSetValidationError(
      "`note` es obligatoria: quien edita reglas es un modelo, no una persona con un formulario, y hay que " +
        "poder auditar por qué se creó cada borrador."
    );
  }

  const active = await prisma.ruleSet.findFirst({
    where: { clientId, status: "active" },
    include: RULE_SET_INCLUDE,
  });

  const maxVersion = await prisma.ruleSet.aggregate({ where: { clientId }, _max: { version: true } });
  const nextVersion = (maxVersion._max.version ?? 0) + 1;

  const clonedFrom: "active" | "seed" = active !== null ? "active" : "seed";

  const stateGroupsData = active !== null ? active.stateGroups : stateGroupSeed;
  const brandLeadTimesData = active !== null ? active.brandLeadTimes : brandLeadTimeSeed;
  const decisionsData = active !== null ? active.decisions : ruleDecisionSeed;
  const templatesData =
    active !== null
      ? active.templates.map((t) => ({
          outcome: t.outcome,
          lang: t.lang,
          body: t.body,
          factsToConvey: t.factsToConvey as Prisma.InputJsonValue,
          mustNotClaim: t.mustNotClaim as Prisma.InputJsonValue,
        }))
      : ruleTemplateSeed;
  const settingsData =
    active !== null
      ? active.settings.map((s) => ({ key: s.key, value: s.value as Prisma.InputJsonValue, note: s.note }))
      : ruleSettingSeed;

  try {
    const created = await prisma.ruleSet.create({
      data: {
        clientId,
        version: nextVersion,
        status: "draft",
        note: trimmedNote,
        stateGroups: { createMany: { data: stateGroupsData } },
        brandLeadTimes: { createMany: { data: brandLeadTimesData } },
        decisions: { createMany: { data: decisionsData } },
        templates: { createMany: { data: templatesData } },
        settings: { createMany: { data: settingsData } },
      },
    });

    return { version: created.version, clonedFrom };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new RuleSetVersionConflictError(
        `No se pudo crear el borrador v${nextVersion} para "${clientId}": otra creación ganó la carrera por ` +
          "el mismo número de versión. Reintentá create_rule_draft."
      );
    }
    throw err;
  }
}

/**
 * Confirma que existe la versión pedida y que está en `draft`. Ningún setter
 * puede tocar un conjunto `active` o `archived` (regla dura del task doc): la
 * única vía para editar reglas ya publicadas es clonar con `create_rule_draft`
 * y editar ESE borrador.
 */
async function assertDraft(clientId: string, version: number): Promise<{ id: number }> {
  const ruleSet = await prisma.ruleSet.findUnique({
    where: { clientId_version: { clientId, version } },
    select: { id: true, status: true },
  });
  if (ruleSet === null) {
    throw new RuleSetNotFoundError(`No existe ningún conjunto de reglas v${version} para "${clientId}".`);
  }
  if (ruleSet.status !== "draft") {
    throw new RuleSetStateError(
      `El conjunto v${version} de "${clientId}" está en estado "${ruleSet.status}", no "draft": ningún setter ` +
        "puede modificar un conjunto activo o archivado. Creá un borrador nuevo con create_rule_draft y editá ese."
    );
  }
  return { id: ruleSet.id };
}

/**
 * Entrada de `setStateGroup`. No reusa `OrderStateGroupSeed` (la siembra) a
 * propósito: esa interfaz declara `stateName: string` no-nulo, pero la
 * columna real (`RuleStateGroup.stateName`) es `String?` en el esquema —
 * desajuste documentado en el reporte de T10. Acá se sigue la columna real.
 */
export interface StateGroupInput {
  orderStateId: number;
  stateName: string | null;
  groupCode: StateGroupCode;
}

/** Alta o actualización idempotente (upsert por `orderStateId`) de un mapeo estado→grupo, sobre un borrador. */
export async function setStateGroup(clientId: string, version: number, input: StateGroupInput): Promise<void> {
  const { id: ruleSetId } = await assertDraft(clientId, version);
  const row = parseOrThrow(ruleSetRowSchemas.stateGroup, input, "set_state_group");

  await prisma.ruleStateGroup.upsert({
    where: { ruleSetId_orderStateId: { ruleSetId, orderStateId: row.orderStateId } },
    update: { stateName: row.stateName, groupCode: row.groupCode },
    create: { ruleSetId, orderStateId: row.orderStateId, stateName: row.stateName, groupCode: row.groupCode },
  });

  invalidateRuleSetCache(clientId);
}

/**
 * Alta o actualización idempotente (upsert por `brandKey`) de un plazo de
 * marca, sobre un borrador. `brandKey` se calcula acá con `normalizeBrandKey`
 * — nunca se recibe del llamador — para que no exista forma de sembrar una
 * clave que no sea la que el runtime va a calcular al leer un pedido real.
 */
export async function setBrandLeadTime(
  clientId: string,
  version: number,
  input: Pick<BrandLeadTimeSeed, "brand" | "leadDays">
): Promise<void> {
  const { id: ruleSetId } = await assertDraft(clientId, version);
  const brandKey = normalizeBrandKey(input.brand);
  const row = parseOrThrow(
    ruleSetRowSchemas.brandLeadTime,
    { brand: input.brand, brandKey, leadDays: input.leadDays },
    "set_brand_lead_time"
  );

  await prisma.ruleBrandLeadTime.upsert({
    where: { ruleSetId_brandKey: { ruleSetId, brandKey: row.brandKey } },
    update: { brand: row.brand, leadDays: row.leadDays },
    create: { ruleSetId, brand: row.brand, brandKey: row.brandKey, leadDays: row.leadDays },
  });

  invalidateRuleSetCache(clientId);
}

/** Alta o actualización idempotente (upsert por `priority`) de una fila de la matriz de decisión (§4), sobre un borrador. */
export async function setDecisionRule(clientId: string, version: number, input: RuleDecisionSeed): Promise<void> {
  const { id: ruleSetId } = await assertDraft(clientId, version);
  const row = parseOrThrow(ruleSetRowSchemas.decision, input, "set_decision_rule");

  const data = {
    stateGroup: row.stateGroup,
    stockStatus: row.stockStatus,
    brandCount: row.brandCount,
    delayBucket: row.delayBucket,
    hasTracking: row.hasTracking,
    historyHasInfo: row.historyHasInfo,
    outcome: row.outcome,
    note: row.note,
  };

  await prisma.ruleDecision.upsert({
    where: { ruleSetId_priority: { ruleSetId, priority: row.priority } },
    update: data,
    create: { ruleSetId, priority: row.priority, ...data },
  });

  invalidateRuleSetCache(clientId);
}

/** Alta o actualización idempotente (upsert por `outcome`+`lang`) de una plantilla, sobre un borrador. */
export async function setTemplate(clientId: string, version: number, input: RuleTemplateSeed): Promise<void> {
  const { id: ruleSetId } = await assertDraft(clientId, version);
  const row = parseOrThrow(ruleSetRowSchemas.template, input, "set_template");

  const data = {
    body: row.body,
    factsToConvey: row.factsToConvey as Prisma.InputJsonValue,
    mustNotClaim: row.mustNotClaim as Prisma.InputJsonValue,
  };

  await prisma.ruleTemplate.upsert({
    where: { ruleSetId_outcome_lang: { ruleSetId, outcome: row.outcome, lang: row.lang } },
    update: data,
    create: { ruleSetId, outcome: row.outcome, lang: row.lang, ...data },
  });

  invalidateRuleSetCache(clientId);
}

/** Alta o actualización idempotente (upsert por `key`) de un ajuste configurable, sobre un borrador. */
export async function setRuleSetting(clientId: string, version: number, input: RuleSettingSeed): Promise<void> {
  const { id: ruleSetId } = await assertDraft(clientId, version);
  const row = parseOrThrow(ruleSetRowSchemas.setting, input, "set_rule_setting");
  const note = row.note ?? null;
  const value = row.value as Prisma.InputJsonValue;

  await prisma.ruleSetting.upsert({
    where: { ruleSetId_key: { ruleSetId, key: row.key } },
    update: { value, note },
    create: { ruleSetId, key: row.key, value, note },
  });

  invalidateRuleSetCache(clientId);
}

// ─── Publicación ────────────────────────────────────────────────────────

/**
 * Activa un borrador: lo valida ENTERO antes de tocar nada (misma validación
 * fail-closed que `loadActiveRuleSet`) y, si valida, archiva el activo actual
 * y activa este en una única transacción.
 *
 * Si dos publicaciones compiten, el índice único parcial
 * `rule_sets_one_active_per_client` hace fallar a la segunda con un error de
 * restricción única de Postgres: se traduce acá a `RuleSetActivationConflictError`
 * con mensaje claro, en vez de dejarlo escapar crudo.
 */
export async function activateRuleSet(clientId: string, version: number): Promise<{ version: number; activatedAt: Date }> {
  const draft = await prisma.ruleSet.findUnique({
    where: { clientId_version: { clientId, version } },
    include: RULE_SET_INCLUDE,
  });
  if (draft === null) {
    throw new RuleSetNotFoundError(`No existe ningún conjunto de reglas v${version} para "${clientId}".`);
  }
  if (draft.status !== "draft") {
    throw new RuleSetStateError(
      `El conjunto v${version} de "${clientId}" está en estado "${draft.status}": solo un borrador puede activarse.`
    );
  }

  // Si esto lanza, la función corta acá: nunca se archiva el activo actual a
  // cambio de un borrador que no valida. "No apliques nada parcialmente."
  const holidayRows = await fetchHolidayRows(clientId);
  buildLoadedRuleSet(draft, holidayRows);

  const activatedAt = new Date();
  try {
    await prisma.$transaction([
      prisma.ruleSet.updateMany({ where: { clientId, status: "active" }, data: { status: "archived" } }),
      prisma.ruleSet.update({ where: { id: draft.id }, data: { status: "active", activatedAt } }),
    ]);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new RuleSetActivationConflictError(
        `No se pudo activar v${version} para "${clientId}": otra publicación ganó la carrera y ya hay un ` +
          'conjunto activo (lo garantiza el índice único "rule_sets_one_active_per_client"). Reintentá la activación.'
      );
    }
    throw err;
  }

  invalidateRuleSetCache(clientId);
  return { version, activatedAt };
}

/**
 * Reactiva una versión archivada (rollback). Solo opera sobre `archived`: un
 * conjunto que llegó a `active` alguna vez ya pasó por la validación de
 * `activateRuleSet`, así que no se revalida acá.
 *
 * Misma protección de carrera que `activateRuleSet` frente al índice único parcial.
 */
export async function rollbackRuleSet(clientId: string, version: number): Promise<{ version: number; activatedAt: Date }> {
  const target = await prisma.ruleSet.findUnique({ where: { clientId_version: { clientId, version } } });
  if (target === null) {
    throw new RuleSetNotFoundError(`No existe ningún conjunto de reglas v${version} para "${clientId}".`);
  }
  if (target.status !== "archived") {
    throw new RuleSetStateError(
      `El conjunto v${version} de "${clientId}" está en estado "${target.status}", no "archived": solo un ` +
        "conjunto archivado puede reactivarse con rollback."
    );
  }

  const activatedAt = new Date();
  try {
    await prisma.$transaction([
      prisma.ruleSet.updateMany({ where: { clientId, status: "active" }, data: { status: "archived" } }),
      prisma.ruleSet.update({ where: { id: target.id }, data: { status: "active", activatedAt } }),
    ]);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new RuleSetActivationConflictError(
        `No se pudo reactivar v${version} para "${clientId}": otra publicación ganó la carrera y ya hay un ` +
          'conjunto activo (lo garantiza el índice único "rule_sets_one_active_per_client"). Reintentá el rollback.'
      );
    }
    throw err;
  }

  invalidateRuleSetCache(clientId);
  return { version, activatedAt };
}

// ─── Cobertura de marcas ──────────────────────────────────────────────────

interface ManufacturerRecord {
  id: number;
  name: string;
}

const MANUFACTURER_FIELDS = ["id", "name"] as const;

export interface BrandCoverageGap {
  brand: string;
  brandKey: string;
  /** Productos activos de esa marca en el catálogo local ya sincronizado (`products`, tabla de `search_products`). */
  activeProductCount: number;
}

/**
 * Compara las marcas reales de PrestaShop (`manufacturers`) contra los
 * `brandKey` del conjunto ACTIVO y devuelve las que no tienen plazo de
 * expedición, con su número de productos activos.
 *
 * Una marca sin plazo (§2.4, §7.4) fuerza escalar cualquier pedido sin stock
 * que la incluya: esta tool existe para encontrar esos huecos ANTES de que los
 * encuentre un cliente real preguntando por su pedido.
 *
 * El conteo de "productos activos" sale del catálogo local ya sincronizado
 * (`products`, la misma tabla que usa `search_products`), no de una consulta
 * en vivo a PrestaShop: es el dato que ya tenemos y evita una llamada extra
 * por marca. Documentado como decisión de diseño en el reporte de T10.
 */
export async function checkBrandCoverage(clientId: string): Promise<BrandCoverageGap[]> {
  const [ruleSet, manufacturers, brandCounts] = await Promise.all([
    loadActiveRuleSet(clientId),
    getMany<ManufacturerRecord>("manufacturers", { display: MANUFACTURER_FIELDS }),
    prisma.product.groupBy({
      by: ["brand"],
      where: { clientId, active: true, brand: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const countByBrandKey = new Map<string, number>();
  for (const row of brandCounts) {
    if (row.brand === null) continue;
    const key = normalizeBrandKey(row.brand);
    countByBrandKey.set(key, (countByBrandKey.get(key) ?? 0) + row._count._all);
  }

  const seenKeys = new Set<string>();
  const gaps: BrandCoverageGap[] = [];
  for (const manufacturer of manufacturers) {
    const brandKey = normalizeBrandKey(manufacturer.name);
    if (seenKeys.has(brandKey)) continue; // PrestaShop no debería repetir un nombre, pero no se confía en eso.
    seenKeys.add(brandKey);
    if (ruleSet.brandLeadDays.has(brandKey)) continue;
    gaps.push({ brand: manufacturer.name, brandKey, activeProductCount: countByBrandKey.get(brandKey) ?? 0 });
  }

  return gaps.sort((a, b) => b.activeProductCount - a.activeProductCount);
}
