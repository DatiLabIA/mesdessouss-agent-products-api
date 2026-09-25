import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLoadedRuleSet,
  DEFAULT_RETURN_REFUND_MAX_BUSINESS_DAYS,
  parseBrandLeadDays,
  parseDecisions,
  parseHolidays,
  parseRuleSettings,
  parseStateGroups,
  parseTemplates,
  RuleSetValidationError,
  type RawBrandLeadTimeRow,
  type RawDecisionRow,
  type RawHolidayRow,
  type RawRuleSetBundle,
  type RawSettingRow,
  type RawStateGroupRow,
  type RawTemplateRow,
} from "./rule-set-validation";

/**
 * Tests de las funciones puras de validación y conversión del motor de
 * reglas (T10): las que transforman filas crudas (columnas `String?`/`Json`
 * de Prisma) en los mapas/sets/enums que espera el runtime. Runner nativo,
 * mismo estilo que `order-facts.test.ts`/`rule-evaluator.test.ts`: helpers
 * de construcción de datos + `describe`/`test` en español.
 *
 * Importan de `./rule-set-validation`, no de `./rule-queries`: este último
 * importa `./prisma`, que lanza al cargarse si `DATABASE_URL` no está
 * definida (no hay `.env` en este repositorio, y la tarea prohíbe tocar la
 * base). Las funciones puras tienen que poder testearse sin ninguna base de
 * datos disponible, así que se testean donde viven de verdad: el módulo sin
 * dependencia de Prisma. `rule-queries.ts` reexporta todo esto, así que quien
 * lo consuma en producción no nota la división.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────

function stateGroupRow(overrides: Partial<RawStateGroupRow> = {}): RawStateGroupRow {
  return { orderStateId: 2, stateName: "Paiement validé", groupCode: "A", ...overrides };
}

function brandLeadTimeRow(overrides: Partial<RawBrandLeadTimeRow> = {}): RawBrandLeadTimeRow {
  return { brand: "Aubade", brandKey: "aubade", leadDays: 5, ...overrides };
}

function decisionRow(overrides: Partial<RawDecisionRow> = {}): RawDecisionRow {
  return {
    priority: 1,
    stateGroup: "A",
    stockStatus: "EN_STOCK",
    brandCount: null,
    delayBucket: "NONE",
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "MAIL_1",
    note: "Confirmación estándar.",
    ...overrides,
  };
}

function templateRow(overrides: Partial<RawTemplateRow> = {}): RawTemplateRow {
  return {
    outcome: "MAIL_1",
    lang: "fr",
    body: "",
    factsToConvey: ["order_reference"],
    mustNotClaim: ["must not state the order has shipped"],
    ...overrides,
  };
}

function settingRow(overrides: Partial<RawSettingRow> = {}): RawSettingRow {
  return { key: "in_stock_lead_days", value: 2, note: null, ...overrides };
}

const validSettings: RawSettingRow[] = [
  { key: "in_stock_lead_days", value: 2, note: null },
  { key: "short_delay_max_days", value: 3, note: null },
  { key: "return_refund_max_business_days", value: 7, note: null },
];

function utcDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

// ─── parseStateGroups ─────────────────────────────────────────────────────

describe("parseStateGroups", () => {
  test("convierte filas válidas a un Map<number, StateGroup>", () => {
    const map = parseStateGroups([
      stateGroupRow({ orderStateId: 2, groupCode: "A" }),
      stateGroupRow({ orderStateId: 10, groupCode: "B" }),
      stateGroupRow({ orderStateId: 61, groupCode: "R" }),
    ]);
    assert.equal(map.size, 3);
    assert.equal(map.get(2), "A");
    assert.equal(map.get(10), "B");
    assert.equal(map.get(61), "R");
  });

  test("acepta stateName null", () => {
    const map = parseStateGroups([stateGroupRow({ stateName: null })]);
    assert.equal(map.get(2), "A");
  });

  test("acepta el grupo F (reembolso)", () => {
    const map = parseStateGroups([stateGroupRow({ orderStateId: 83, groupCode: "F" })]);
    assert.equal(map.get(83), "F");
  });

  test("groupCode fuera de A|B|C|D|R lanza RuleSetValidationError nombrando la fila", () => {
    assert.throws(
      () => parseStateGroups([stateGroupRow({ orderStateId: 99, groupCode: "Z" })]),
      (err: unknown) => {
        assert.ok(err instanceof RuleSetValidationError);
        assert.match((err as Error).message, /rule_state_groups\[0\]/);
        assert.match((err as Error).message, /order_state_id=99/);
        return true;
      }
    );
  });
});

// ─── parseBrandLeadDays ───────────────────────────────────────────────────

describe("parseBrandLeadDays", () => {
  test("convierte filas válidas a Map<brandKey, leadDays>", () => {
    const map = parseBrandLeadDays([
      brandLeadTimeRow({ brand: "Aubade", brandKey: "aubade", leadDays: 5 }),
      brandLeadTimeRow({ brand: "Sloggi", brandKey: "sloggi", leadDays: 9 }),
    ]);
    assert.equal(map.size, 2);
    assert.equal(map.get("aubade"), 5);
    assert.equal(map.get("sloggi"), 9);
  });

  test("leadDays negativo lanza RuleSetValidationError", () => {
    assert.throws(
      () => parseBrandLeadDays([brandLeadTimeRow({ leadDays: -1 })]),
      RuleSetValidationError
    );
  });

  test("brand vacía lanza RuleSetValidationError", () => {
    assert.throws(() => parseBrandLeadDays([brandLeadTimeRow({ brand: "   " })]), RuleSetValidationError);
  });
});

// ─── parseDecisions ───────────────────────────────────────────────────────

describe("parseDecisions", () => {
  test("convierte filas válidas preservando todos los campos", () => {
    const [row] = parseDecisions([decisionRow()]);
    assert.deepEqual(row, {
      priority: 1,
      stateGroup: "A",
      stockStatus: "EN_STOCK",
      brandCount: null,
      delayBucket: "NONE",
      hasTracking: null,
      historyHasInfo: null,
      refundIssued: null,
      outcome: "MAIL_1",
      note: "Confirmación estándar.",
    });
  });

  test("las decisiones salen ordenadas por priority ascendente, sin importar el orden de entrada", () => {
    const rows = parseDecisions([
      decisionRow({ priority: 12, stateGroup: "D", stockStatus: null, delayBucket: null, outcome: "ESCALATE" }),
      decisionRow({ priority: 0, stateGroup: "R", stockStatus: null, delayBucket: null, outcome: "MAIL_12" }),
      decisionRow({ priority: 5, stateGroup: "A", stockStatus: "SIN_STOCK", brandCount: "MANY", delayBucket: "NONE", outcome: "MAIL_4" }),
    ]);
    assert.deepEqual(rows.map((r) => r.priority), [0, 5, 12]);
  });

  test("delayBucket fuera de NONE|SHORT|LONG|POSITIVE lanza RuleSetValidationError nombrando la fila", () => {
    assert.throws(
      () => parseDecisions([decisionRow({ priority: 7, delayBucket: "MEDIUM" as never })]),
      (err: unknown) => {
        assert.ok(err instanceof RuleSetValidationError);
        assert.match((err as Error).message, /rule_decisions\[0\]/);
        assert.match((err as Error).message, /priority=7/);
        return true;
      }
    );
  });

  test("stateGroup inválido lanza RuleSetValidationError", () => {
    assert.throws(() => parseDecisions([decisionRow({ stateGroup: "Z" as never })]), RuleSetValidationError);
  });

  test("outcome fuera del vocabulario cerrado lanza RuleSetValidationError", () => {
    assert.throws(() => parseDecisions([decisionRow({ outcome: "MAIL_99" as never })]), RuleSetValidationError);
  });

  test("acepta los desenlaces nuevos MAIL_10 y MAIL_REFUND", () => {
    const rows = parseDecisions([
      decisionRow({ priority: 1, outcome: "MAIL_10" }),
      decisionRow({ priority: 2, outcome: "MAIL_REFUND", stateGroup: "F", stockStatus: null, delayBucket: null }),
    ]);
    assert.deepEqual(rows.map((r) => r.outcome), ["MAIL_10", "MAIL_REFUND"]);
  });

  test("refundIssued acepta true, false y null", () => {
    for (const valor of [true, false, null] as const) {
      const [row] = parseDecisions([decisionRow({ refundIssued: valor })]);
      assert.equal(row.refundIssued, valor);
    }
  });

  test("refundIssued no booleano lanza RuleSetValidationError", () => {
    assert.throws(
      () => parseDecisions([decisionRow({ refundIssued: "true" as never })]),
      RuleSetValidationError
    );
  });

  test("nota vacía lanza RuleSetValidationError (toda fila necesita nota legible)", () => {
    assert.throws(() => parseDecisions([decisionRow({ note: "   " })]), RuleSetValidationError);
  });

  test("un conjunto con UNA fila inválida entre varias válidas no produce ningún resultado parcial", () => {
    let thrown: unknown;
    try {
      parseDecisions([
        decisionRow({ priority: 1 }),
        decisionRow({ priority: 2, delayBucket: "NOPE" as never }),
        decisionRow({ priority: 3 }),
      ]);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof RuleSetValidationError, "debe lanzar en vez de devolver algo parcial");
  });
});

// ─── parseTemplates ───────────────────────────────────────────────────────

describe("parseTemplates", () => {
  test("convierte filas válidas preservando factsToConvey/mustNotClaim como string[]", () => {
    const [row] = parseTemplates([templateRow()]);
    assert.deepEqual(row.factsToConvey, ["order_reference"]);
    assert.deepEqual(row.mustNotClaim, ["must not state the order has shipped"]);
    assert.equal(row.outcome, "MAIL_1");
    assert.equal(row.lang, "fr");
  });

  test("body vacío es válido (plantillas pendientes de fuente externa)", () => {
    const [row] = parseTemplates([templateRow({ body: "" })]);
    assert.equal(row.body, "");
  });

  test("factsToConvey que no es un array de strings lanza RuleSetValidationError", () => {
    assert.throws(
      () => parseTemplates([templateRow({ factsToConvey: [1, 2, 3] as never })]),
      RuleSetValidationError
    );
  });

  test("lang distinto de 'fr' lanza RuleSetValidationError (única lengua sembrada hoy)", () => {
    assert.throws(() => parseTemplates([templateRow({ lang: "en" })]), RuleSetValidationError);
  });

  test("outcome fuera del vocabulario cerrado lanza RuleSetValidationError", () => {
    assert.throws(() => parseTemplates([templateRow({ outcome: "MAIL_99" })]), RuleSetValidationError);
  });

  test("acepta los desenlaces nuevos MAIL_10 y MAIL_REFUND", () => {
    const rows = parseTemplates([templateRow({ outcome: "MAIL_10" }), templateRow({ outcome: "MAIL_REFUND" })]);
    assert.deepEqual(rows.map((r) => r.outcome), ["MAIL_10", "MAIL_REFUND"]);
  });

  test("acepta el desenlace nuevo MAIL_8 (T4, plantilla del retorno en curso)", () => {
    const [row] = parseTemplates([templateRow({ outcome: "MAIL_8" })]);
    assert.equal(row.outcome, "MAIL_8");
  });

  // ─── notifyTeam (T4) ────────────────────────────────────────────────────

  test("notifyTeam: se preserva true/false cuando la fila cruda lo trae", () => {
    for (const valor of [true, false] as const) {
      const [row] = parseTemplates([templateRow({ notifyTeam: valor })]);
      assert.equal(row.notifyTeam, valor);
    }
  });

  test("notifyTeam ausente en la fila cruda (conjunto sembrado antes de T4) → false, nunca un dato faltante", () => {
    // `templateRow()` no trae `notifyTeam`: representa exactamente una fila cruda de antes de T4
    // (compatibilidad hacia atrás con el conjunto activo actual, sembrado con el seed viejo).
    const [row] = parseTemplates([templateRow()]);
    assert.equal(row.notifyTeam, false);
  });

  test("notifyTeam no booleano lanza RuleSetValidationError", () => {
    assert.throws(
      () => parseTemplates([templateRow({ notifyTeam: "true" as never })]),
      RuleSetValidationError
    );
  });
});

// ─── parseRuleSettings ────────────────────────────────────────────────────

describe("parseRuleSettings", () => {
  test("convierte los ajustes obligatorios a RuleSettingsConfig", () => {
    const settings = parseRuleSettings(validSettings);
    assert.deepEqual(settings, { inStockLeadDays: 2, shortDelayMaxDays: 3, returnRefundMaxBusinessDays: 7 });
  });

  test("ignora ajustes no reconocidos (p.ej. date_format) sin que afecten el resultado", () => {
    const settings = parseRuleSettings([...validSettings, settingRow({ key: "date_format", value: "DD/MM/YYYY" })]);
    assert.deepEqual(settings, { inStockLeadDays: 2, shortDelayMaxDays: 3, returnRefundMaxBusinessDays: 7 });
  });

  test("falta in_stock_lead_days → RuleSetValidationError", () => {
    const onlyShortDelay = validSettings.filter((s) => s.key !== "in_stock_lead_days");
    assert.throws(
      () => parseRuleSettings(onlyShortDelay),
      (err: unknown) => {
        assert.ok(err instanceof RuleSetValidationError);
        assert.match((err as Error).message, /in_stock_lead_days/);
        return true;
      }
    );
  });

  test("falta short_delay_max_days → RuleSetValidationError", () => {
    const onlyInStock = validSettings.filter((s) => s.key !== "short_delay_max_days");
    assert.throws(() => parseRuleSettings(onlyInStock), RuleSetValidationError);
  });

  test("falta return_refund_max_business_days: usa el valor por defecto (7 días hábiles), no lanza", () => {
    // T2 agregó este ajuste DESPUÉS de que ya hubiera un conjunto activo en producción: exigirlo
    // como los otros dos convertiría "falta un ajuste nuevo" en un 503 para cualquier consulta
    // verificada (ver el JSDoc de DEFAULT_RETURN_REFUND_MAX_BUSINESS_DAYS en rule-set-validation.ts).
    const sinUmbralDeRetorno = validSettings.filter((s) => s.key !== "return_refund_max_business_days");
    const settings = parseRuleSettings(sinUmbralDeRetorno);
    assert.equal(settings.returnRefundMaxBusinessDays, DEFAULT_RETURN_REFUND_MAX_BUSINESS_DAYS);
    assert.deepEqual(settings, { inStockLeadDays: 2, shortDelayMaxDays: 3, returnRefundMaxBusinessDays: 7 });
  });

  test("conjunto de reglas con forma anterior a T2 (solo los dos ajustes originales) carga igual", () => {
    const oldShapeSettings: RawSettingRow[] = [
      { key: "in_stock_lead_days", value: 2, note: null },
      { key: "short_delay_max_days", value: 3, note: null },
    ];
    const settings = parseRuleSettings(oldShapeSettings);
    assert.deepEqual(settings, {
      inStockLeadDays: 2,
      shortDelayMaxDays: 3,
      returnRefundMaxBusinessDays: DEFAULT_RETURN_REFUND_MAX_BUSINESS_DAYS,
    });
  });

  test("in_stock_lead_days no numérico → RuleSetValidationError", () => {
    assert.throws(
      () =>
        parseRuleSettings([
          settingRow({ key: "in_stock_lead_days", value: "dos" }),
          settingRow({ key: "short_delay_max_days", value: 3 }),
          settingRow({ key: "return_refund_max_business_days", value: 7 }),
        ]),
      RuleSetValidationError
    );
  });

  test("return_refund_max_business_days no numérico → RuleSetValidationError", () => {
    assert.throws(
      () =>
        parseRuleSettings([
          settingRow({ key: "in_stock_lead_days", value: 2 }),
          settingRow({ key: "short_delay_max_days", value: 3 }),
          settingRow({ key: "return_refund_max_business_days", value: "siete" }),
        ]),
      RuleSetValidationError
    );
  });
});

// ─── parseHolidays ────────────────────────────────────────────────────────

describe("parseHolidays", () => {
  test("convierte fechas a claves AAAA-MM-DD en un Set", () => {
    const holidays = parseHolidays([{ day: utcDay(2026, 1, 1) }, { day: utcDay(2026, 12, 25) }]);
    assert.ok(holidays.has("2026-01-01"));
    assert.ok(holidays.has("2026-12-25"));
    assert.equal(holidays.size, 2);
  });

  test("sin festivos devuelve un Set vacío", () => {
    assert.equal(parseHolidays([]).size, 0);
  });
});

// ─── buildLoadedRuleSet (ensamblado fail-closed) ─────────────────────────

function validBundle(overrides: Partial<RawRuleSetBundle> = {}): RawRuleSetBundle {
  return {
    version: 1,
    stateGroups: [stateGroupRow()],
    brandLeadTimes: [brandLeadTimeRow()],
    decisions: [decisionRow()],
    templates: [templateRow()],
    settings: validSettings,
    ...overrides,
  };
}

describe("buildLoadedRuleSet", () => {
  test("con un conjunto válido devuelve un LoadedRuleSet completo", () => {
    const loaded = buildLoadedRuleSet(validBundle(), []);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.stateGroups.get(2), "A");
    assert.equal(loaded.brandLeadDays.get("aubade"), 5);
    assert.equal(loaded.decisions.length, 1);
    assert.equal(loaded.templates.length, 1);
    assert.deepEqual(loaded.settings, { inStockLeadDays: 2, shortDelayMaxDays: 3, returnRefundMaxBusinessDays: 7 });
    assert.equal(loaded.holidays.size, 0);
  });

  test("un conjunto inválido (groupCode roto) lanza y no devuelve NADA, ni siquiera parcial", () => {
    const bundle = validBundle({ stateGroups: [stateGroupRow({ groupCode: "X" })] });
    assert.throws(() => buildLoadedRuleSet(bundle, []), RuleSetValidationError);
  });

  test("un conjunto inválido por delayBucket roto en una decisión lanza sin construir nada", () => {
    const bundle = validBundle({ decisions: [decisionRow({ delayBucket: "ALGUNO" as never })] });
    assert.throws(() => buildLoadedRuleSet(bundle, []), RuleSetValidationError);
  });

  test("falta el ajuste obligatorio in_stock_lead_days → todo el conjunto es inválido", () => {
    const bundle = validBundle({ settings: [{ key: "short_delay_max_days", value: 3 }] });
    assert.throws(
      () => buildLoadedRuleSet(bundle, []),
      (err: unknown) => {
        assert.ok(err instanceof RuleSetValidationError);
        assert.match((err as Error).message, /in_stock_lead_days/);
        return true;
      }
    );
  });

  test("las decisiones del LoadedRuleSet salen ordenadas por priority ascendente", () => {
    const bundle = validBundle({
      decisions: [
        decisionRow({ priority: 8, stateGroup: "B", stockStatus: null, delayBucket: null, hasTracking: true, outcome: "MAIL_3" }),
        decisionRow({ priority: 1 }),
        decisionRow({ priority: 4, stateGroup: "A", stockStatus: "SIN_STOCK", brandCount: "ONE", delayBucket: "NONE", outcome: "MAIL_5" }),
      ],
    });
    const loaded = buildLoadedRuleSet(bundle, []);
    assert.deepEqual(loaded.decisions.map((d) => d.priority), [1, 4, 8]);
  });
});
