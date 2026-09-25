import { z } from "zod";
import { toDateKey } from "./business-days";
import type { StateGroup } from "./order-facts";
import type { RuleDecisionSeed, RuleTemplateSeed } from "../data/order-rules-seed";

/**
 * Validación y conversión de las filas crudas del motor de reglas (columnas
 * `String?`/`Json` de Prisma, ver `prisma/schema.prisma`) a las formas exactas
 * que consume el runtime (`order-facts.ts`, `rule-evaluator.ts`): mapas, sets
 * y enums cerrados.
 *
 * Sin dependencia de Prisma A PROPÓSITO: `src/lib/prisma.ts` lanza al
 * importarse si `DATABASE_URL` no está definida (no hay `.env` en este
 * repositorio), y este módulo tiene que poder testearse sin ninguna base de
 * datos disponible — es justo lo que pide T10 de `odd/tasks/lia-order-lookup.md`.
 * `src/lib/rule-queries.ts` es la capa que sí toca Prisma; importa y reexporta
 * todo lo de acá para que quien consuma `rule-queries.ts` no note la división.
 *
 * Fail-closed real: cada función `parse*` valida TODAS sus filas con zod antes
 * de devolver nada, y ninguna escribe a una variable compartida hasta terminar.
 * Si una fila es inválida, la función lanza de inmediato y no queda ningún
 * mapa a medio construir. Esta costura (columna string genérica -> enum
 * cerrado del runtime) ya mordió tres veces durante T6-T9: `normalizeBrandKey`
 * duplicada y `DelayBucket` con dos vocabularios (`NONE|SHORT|LONG` vs. con
 * `POSITIVE`). Acá se valida con zod para que un desajuste futuro falle fuerte
 * al cargar, no en silencio escalando pedidos contestables.
 */

// ─── Errores tipados ────────────────────────────────────────────────────

/** Una fila del conjunto de reglas no respeta el vocabulario cerrado del runtime, o falta un ajuste obligatorio. */
export class RuleSetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSetValidationError";
  }
}

/** No existe el conjunto de reglas pedido: ni por versión, ni un activo para el cliente. */
export class RuleSetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSetNotFoundError";
  }
}

/**
 * El estado del conjunto (`draft` | `active` | `archived`) no permite la
 * operación pedida: ningún setter puede tocar un conjunto que no sea `draft`
 * (regla dura del task doc), y `rollback` solo puede reactivar uno `archived`.
 */
export class RuleSetStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSetStateError";
  }
}

/**
 * Dos publicaciones (`activateRuleSet`/`rollbackRuleSet`) compitieron por el
 * único hueco de "activo" que garantiza el índice único parcial
 * `rule_sets_one_active_per_client`. La segunda pierde la carrera a propósito:
 * este error es ese caso, con mensaje legible en vez de la excepción cruda de Postgres.
 */
export class RuleSetActivationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSetActivationConflictError";
  }
}

// ─── Vocabulario cerrado ──────────────────────────────────────────────────
//
// Única fuente para: los esquemas zod de este módulo, la validación del
// runtime, y los `z.enum([...])` de los parámetros de las tools MCP en
// `mcp-instance.ts`. Duplicar esta lista allá sería exactamente el error de
// `normalizeBrandKey` de T6/T7: dos copias que hoy coinciden y mañana no.

export const STATE_GROUP_CODES = ["A", "B", "C", "D", "R", "F"] as const;
export const STOCK_STATUSES = ["EN_STOCK", "SIN_STOCK"] as const;
export const BRAND_COUNTS = ["ONE", "MANY"] as const;
export const DELAY_BUCKET_CONDITIONS = ["NONE", "SHORT", "LONG", "POSITIVE"] as const;
export const RULE_OUTCOMES = [
  "MAIL_1",
  "MAIL_2",
  "MAIL_3",
  "MAIL_4",
  "MAIL_5",
  "MAIL_6",
  "MAIL_7",
  "MAIL_10",
  "MAIL_12",
  "MAIL_15",
  "MAIL_REFUND",
  "ESCALATE",
] as const;
/**
 * La siembra actual y el tipo `RuleTemplateSeed.lang` solo admiten `"fr"`,
 * aunque el comentario de `RuleTemplate.lang` en `prisma/schema.prisma` diga
 * "fr | en | es". Es un desajuste real, documentado en el reporte de T10: se
 * deja cerrado a `"fr"` a propósito (ver la nota de `parseTemplates` más abajo).
 */
export const RULE_TEMPLATE_LANGS = ["fr"] as const;

const stateGroupCodeSchema = z.enum(STATE_GROUP_CODES);
const stockStatusSchema = z.enum(STOCK_STATUSES);
const brandCountSchema = z.enum(BRAND_COUNTS);
const delayBucketConditionSchema = z.enum(DELAY_BUCKET_CONDITIONS);
const ruleOutcomeSchema = z.enum(RULE_OUTCOMES);
const ruleTemplateLangSchema = z.enum(RULE_TEMPLATE_LANGS);

function describeZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(raíz)"}: ${issue.message}`).join("; ");
}

/** Valida `value` contra `schema`; en caso de fallo lanza `RuleSetValidationError` con `context` y el detalle de zod. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RuleSetValidationError(`${context}: ${describeZodError(result.error)}`);
  }
  return result.data;
}

// ─── Formas crudas ──────────────────────────────────────────────────────
//
// Misma forma (nombres y tipos de campo) que devuelven los modelos de Prisma,
// declarada acá en vez de importada, para no arrastrar `@prisma/client` a un
// módulo que tiene que poder cargarse sin base de datos. `rule-queries.ts`
// pasa sus filas de Prisma directamente: son estructuralmente compatibles.

export interface RawStateGroupRow {
  orderStateId: number;
  stateName: string | null;
  groupCode: string;
}

export interface RawBrandLeadTimeRow {
  brand: string;
  brandKey: string;
  leadDays: number;
}

export interface RawDecisionRow {
  priority: number;
  stateGroup: string | null;
  stockStatus: string | null;
  brandCount: string | null;
  delayBucket: string | null;
  hasTracking: boolean | null;
  historyHasInfo: boolean | null;
  refundIssued: boolean | null;
  outcome: string;
  note: string | null;
}

export interface RawTemplateRow {
  outcome: string;
  lang: string;
  body: string;
  factsToConvey: unknown;
  mustNotClaim: unknown;
}

export interface RawSettingRow {
  key: string;
  value: unknown;
  note?: string | null;
}

export interface RawHolidayRow {
  day: Date;
  label?: string | null;
}

// ─── Esquemas zod por fila ────────────────────────────────────────────────

const stateGroupRowSchema = z.object({
  orderStateId: z.number().int(),
  stateName: z.string().nullable(),
  groupCode: stateGroupCodeSchema,
});

const brandLeadTimeRowSchema = z.object({
  brand: z.string().trim().min(1, "la marca no puede estar vacía"),
  brandKey: z.string().trim().min(1, "la clave de marca no puede estar vacía"),
  leadDays: z.number().int().nonnegative("el plazo debe ser un entero >= 0"),
});

const decisionRowSchema = z.object({
  priority: z.number().int(),
  stateGroup: stateGroupCodeSchema.nullable(),
  stockStatus: stockStatusSchema.nullable(),
  brandCount: brandCountSchema.nullable(),
  delayBucket: delayBucketConditionSchema.nullable(),
  hasTracking: z.boolean().nullable(),
  historyHasInfo: z.boolean().nullable(),
  refundIssued: z.boolean().nullable(),
  outcome: ruleOutcomeSchema,
  note: z.string().trim().min(1, "toda fila de la matriz necesita una nota legible (se usa para explicar la decisión)"),
});

const templateRowSchema = z.object({
  outcome: ruleOutcomeSchema,
  lang: ruleTemplateLangSchema,
  body: z.string(),
  factsToConvey: z.array(z.string()),
  mustNotClaim: z.array(z.string()),
});

const settingRowSchema = z.object({
  key: z.string().trim().min(1),
  value: z.unknown(),
  note: z.string().nullable().optional(),
});

const numericSettingValueSchema = z.number();

/** Bolsa de esquemas por fila, reutilizada tanto al cargar en bloque como en cada setter individual de `rule-queries.ts`. */
export const ruleSetRowSchemas = {
  stateGroup: stateGroupRowSchema,
  brandLeadTime: brandLeadTimeRowSchema,
  decision: decisionRowSchema,
  template: templateRowSchema,
  setting: settingRowSchema,
};

// ─── Conversión pura, fila por fila (testable sin Prisma) ────────────────

/** `stateGroups` del runtime: `orderStateId -> grupo`. Un estado sin fila cae en `D` por defecto del código consumidor, no acá. */
export function parseStateGroups(rows: readonly RawStateGroupRow[]): Map<number, StateGroup> {
  const map = new Map<number, StateGroup>();
  rows.forEach((row, index) => {
    const parsed = parseOrThrow(
      stateGroupRowSchema,
      row,
      `rule_state_groups[${index}] (order_state_id=${row.orderStateId})`
    );
    map.set(parsed.orderStateId, parsed.groupCode);
  });
  return map;
}

/** `brandLeadDays` del runtime: `brandKey normalizada -> días hábiles de plazo`. */
export function parseBrandLeadDays(rows: readonly RawBrandLeadTimeRow[]): Map<string, number> {
  const map = new Map<string, number>();
  rows.forEach((row, index) => {
    const parsed = parseOrThrow(
      brandLeadTimeRowSchema,
      row,
      `rule_brand_lead_times[${index}] (brand="${row.brand}")`
    );
    map.set(parsed.brandKey, parsed.leadDays);
  });
  return map;
}

/**
 * `decisions` del runtime: la matriz completa (§4), siempre devuelta ordenada
 * por `priority` ascendente — `evaluateRules` ya vuelve a ordenar por su
 * cuenta, pero un conjunto cargado en el orden correcto es más fácil de leer
 * y de testear, y es exactamente lo que pide el criterio de T10.
 */
export function parseDecisions(rows: readonly RawDecisionRow[]): RuleDecisionSeed[] {
  const parsed = rows.map((row, index) =>
    parseOrThrow(decisionRowSchema, row, `rule_decisions[${index}] (priority=${row.priority})`)
  );
  return [...parsed].sort((a, b) => a.priority - b.priority);
}

/** `templates` del runtime, tal como los consume `buildGuidance`. */
export function parseTemplates(rows: readonly RawTemplateRow[]): RuleTemplateSeed[] {
  return rows.map((row, index) =>
    parseOrThrow(templateRowSchema, row, `rule_templates[${index}] (outcome=${row.outcome}, lang=${row.lang})`)
  );
}

/** Ajustes obligatorios que `OrderFactsConfig` necesita para calcular plazos (§2.4, §2.5) y para el fail-safe del grupo R. */
export interface RuleSettingsConfig {
  inStockLeadDays: number;
  shortDelayMaxDays: number;
  returnRefundMaxBusinessDays: number;
}

const REQUIRED_NUMERIC_SETTINGS = [
  { key: "in_stock_lead_days", field: "inStockLeadDays" },
  { key: "short_delay_max_days", field: "shortDelayMaxDays" },
  { key: "return_refund_max_business_days", field: "returnRefundMaxBusinessDays" },
] as const;

/**
 * Resuelve `RuleSettingsConfig` a partir de las filas de `rule_settings`.
 * Ajustes no reconocidos (p.ej. `date_format`) se leen y se validan por forma,
 * pero no producen ninguna clave de salida: hoy ningún módulo del runtime los
 * consume (ver la nota de `date_format` en `order-rules-seed.ts`).
 */
export function parseRuleSettings(rows: readonly RawSettingRow[]): RuleSettingsConfig {
  const byKey = new Map<string, unknown>();
  rows.forEach((row, index) => {
    const parsed = parseOrThrow(settingRowSchema, row, `rule_settings[${index}] (key="${row.key}")`);
    byKey.set(parsed.key, parsed.value);
  });

  const result = {} as RuleSettingsConfig;
  for (const { key, field } of REQUIRED_NUMERIC_SETTINGS) {
    if (!byKey.has(key)) {
      throw new RuleSetValidationError(
        `Falta el ajuste obligatorio "${key}" en rule_settings: sin él el runtime no puede calcular el ` +
          "plazo del pedido. Un conjunto sin este ajuste nunca se carga, ni parcialmente."
      );
    }
    const numeric = numericSettingValueSchema.safeParse(byKey.get(key));
    if (!numeric.success) {
      throw new RuleSetValidationError(
        `El ajuste "${key}" debe ser numérico; se recibió ${JSON.stringify(byKey.get(key))}.`
      );
    }
    result[field] = numeric.data;
  }
  return result;
}

/** `holidays` del runtime: fechas `AAAA-MM-DD`, la misma forma que exigen `business-days.ts` y `OrderFactsConfig`. */
export function parseHolidays(rows: readonly RawHolidayRow[]): Set<string> {
  return new Set(rows.map((row) => toDateKey(row.day)));
}

// ─── Ensamblado fail-closed ───────────────────────────────────────────────

export interface RawRuleSetBundle {
  version: number;
  stateGroups: readonly RawStateGroupRow[];
  brandLeadTimes: readonly RawBrandLeadTimeRow[];
  decisions: readonly RawDecisionRow[];
  templates: readonly RawTemplateRow[];
  settings: readonly RawSettingRow[];
}

/** Todo lo que el runtime necesita para responder una consulta de pedido, ya en sus formas exactas. */
export interface LoadedRuleSet {
  version: number;
  stateGroups: Map<number, StateGroup>;
  brandLeadDays: Map<string, number>;
  holidays: Set<string>;
  decisions: RuleDecisionSeed[];
  templates: RuleTemplateSeed[];
  settings: RuleSettingsConfig;
}

/**
 * Convierte un conjunto de reglas crudo (Prisma) al `LoadedRuleSet` que
 * consumen `computeOrderFacts`/`evaluateRules`/`buildGuidance`.
 *
 * Fail-closed real, no solo declarado: cada `parse*` corre en orden y lanza en
 * la primera fila inválida que encuentra. Como ninguno asigna a una variable
 * compartida hasta terminar, un fallo a mitad de camino no deja nada a medio
 * construir — la función entera no devuelve, y el llamador (`loadActiveRuleSet`,
 * `activateRuleSet`) nunca llega a cachear ni a publicar un conjunto parcial.
 */
export function buildLoadedRuleSet(bundle: RawRuleSetBundle, holidayRows: readonly RawHolidayRow[]): LoadedRuleSet {
  const stateGroups = parseStateGroups(bundle.stateGroups);
  const brandLeadDays = parseBrandLeadDays(bundle.brandLeadTimes);
  const decisions = parseDecisions(bundle.decisions);
  const templates = parseTemplates(bundle.templates);
  const settings = parseRuleSettings(bundle.settings);
  const holidays = parseHolidays(holidayRows);

  return { version: bundle.version, stateGroups, brandLeadDays, holidays, decisions, templates, settings };
}
