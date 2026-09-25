import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { OrderFacts, OrderFactsLine } from "./order-facts";
import {
  buildGuidance,
  checkFailSafe,
  evaluateRules,
  type GuidanceOrderContext,
  type RuleEvaluationResult,
} from "./rule-evaluator";
import { ruleDecisionSeed, ruleTemplateSeed, type RuleDecisionSeed, type RuleTemplateSeed } from "../data/order-rules-seed";

/**
 * Tests del evaluador de la matriz, del fail-safe y del constructor de
 * `guidance` (T8). Runner nativo, mismo estilo que `order-facts.test.ts` y
 * `order-rules-seed.test.ts`: helpers de construcción de datos + `describe`/
 * `test` en español, una idea por caso.
 */

function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function factLine(overrides: Partial<OrderFactsLine> = {}): OrderFactsLine {
  return {
    name: "Producto",
    brand: "Aubade",
    quantity: 1,
    stockQuantity: 3,
    covered: true,
    ...overrides,
  };
}

/**
 * Hechos base válidos: no disparan ningún fail-safe y no matchean ninguna
 * fila salvo que el test los ajuste a propósito. Cada test parte de esto con
 * overrides puntuales, igual que `baseConfig` en `order-facts.test.ts`.
 */
function baseFacts(overrides: Partial<OrderFacts> = {}): OrderFacts {
  return {
    stateGroup: "A",
    stockStatus: "EN_STOCK",
    affectedBrands: [],
    brandCount: null,
    unknownBrands: [],
    leadDays: 2,
    limitDate: utc(2026, 1, 7),
    delayDays: 0,
    delayBucket: "NONE",
    hasTracking: false,
    historyHasInfo: null,
    lines: [factLine()],
    refundIssued: false,
    returnEnteredAt: null,
    returnAgeBusinessDays: null,
    returnRefundStale: false,
    ...overrides,
  };
}

const baseOrder: GuidanceOrderContext = {
  reference: "ABC123XYZ",
  idLang: 1,
  trackingUrl: null,
};

// ─── El fail-safe de stock solo aplica al grupo A ────────────────────────
//
// Los datos de stock solo deciden algo en el grupo A. En el B el pedido ya salió
// (§3.1: "el estado de stock es irrelevante… siempre es mail 3") y en el C manda
// el historial. Escalar un pedido ya expedido, con su enlace de seguimiento en la
// mano, porque una línea no trae marca o no trae fila de stock, es rechazar la
// consulta más frecuente que existe por un dato que nadie va a usar.

describe("alcance del fail-safe de stock", () => {
  test("grupo B con marca desconocida y tracking responde MAIL_3, no escala", () => {
    const r = evaluateRules(
      baseFacts({
        stateGroup: "B",
        stockStatus: "SIN_STOCK",
        unknownBrands: ["Mariner"],
        affectedBrands: ["Mariner"],
        brandCount: "ONE",
        leadDays: null,
        limitDate: null,
        hasTracking: true,
      }),
      ruleDecisionSeed
    );
    assert.equal(r.outcome, "MAIL_3");
  });

  test("grupo B con stock indeterminable y tracking responde MAIL_3", () => {
    const r = evaluateRules(
      baseFacts({
        stateGroup: "B",
        hasTracking: true,
        lines: [factLine({ stockQuantity: null, covered: false })],
      }),
      ruleDecisionSeed
    );
    assert.equal(r.outcome, "MAIL_3");
  });

  test("grupo B sin tracking sigue escalando, por la fila 9 de la matriz", () => {
    const r = evaluateRules(baseFacts({ stateGroup: "B", hasTracking: false }), ruleDecisionSeed);
    assert.equal(r.outcome, "ESCALATE");
  });

  test("grupo C con marca desconocida se reparte por el tracking (T3), no por el stock", () => {
    const r = evaluateRules(
      baseFacts({
        stateGroup: "C",
        stockStatus: "SIN_STOCK",
        unknownBrands: ["Mariner"],
        affectedBrands: ["Mariner"],
        brandCount: "ONE",
        leadDays: null,
        limitDate: null,
        hasTracking: true,
      }),
      ruleDecisionSeed
    );
    assert.equal(r.outcome, "MAIL_7");
  });

  test("en el grupo A la marca desconocida SÍ escala, que es donde el plazo importa", () => {
    const r = evaluateRules(
      baseFacts({
        stateGroup: "A",
        stockStatus: "SIN_STOCK",
        unknownBrands: ["Mariner"],
        affectedBrands: ["Mariner"],
        brandCount: "ONE",
        leadDays: null,
        limitDate: null,
      }),
      ruleDecisionSeed
    );
    assert.equal(r.outcome, "ESCALATE");
  });

  test("el grupo D escala siempre, sea cual sea el stock", () => {
    const r = evaluateRules(baseFacts({ stateGroup: "D", hasTracking: true }), ruleDecisionSeed);
    assert.equal(r.outcome, "ESCALATE");
  });
});

// ─── Fail-safe ───────────────────────────────────────────────────────────

describe("checkFailSafe", () => {
  test("grupo D escala sin mirar ninguna otra condición", () => {
    const facts = baseFacts({ stateGroup: "D" });
    assert.notEqual(checkFailSafe(facts), null);
  });

  test("una marca afectada sin plazo (unknownBrands) escala", () => {
    const facts = baseFacts({ unknownBrands: ["Marca Fantasma"] });
    const reason = checkFailSafe(facts);
    assert.notEqual(reason, null);
    assert.match(reason!, /Marca Fantasma/);
  });

  test("una línea con stockQuantity null (stock indeterminable) escala", () => {
    const facts = baseFacts({
      lines: [factLine({ stockQuantity: null, covered: false })],
    });
    assert.notEqual(checkFailSafe(facts), null);
  });

  test("una línea sin stock y sin marca informada escala (dato faltante)", () => {
    const facts = baseFacts({
      lines: [factLine({ brand: null, stockQuantity: -1, covered: false })],
    });
    assert.notEqual(checkFailSafe(facts), null);
  });

  test("SIN_STOCK con leadDays null escala", () => {
    const facts = baseFacts({
      stockStatus: "SIN_STOCK",
      leadDays: null,
      limitDate: null,
      lines: [factLine({ stockQuantity: -1, covered: false })],
    });
    assert.notEqual(checkFailSafe(facts), null);
  });

  test("hechos válidos y completos no disparan ningún fail-safe", () => {
    assert.equal(checkFailSafe(baseFacts()), null);
  });
});

// ─── checkFailSafe — grupo R (antigüedad sin reembolso) y grupo F (T2) ──

describe("checkFailSafe — grupo R y grupo F", () => {
  test("grupo R sin reembolso, dentro del plazo (returnRefundStale false): no escala, sigue a la matriz", () => {
    const facts = baseFacts({ stateGroup: "R", refundIssued: false, returnRefundStale: false });
    assert.equal(checkFailSafe(facts), null);
  });

  test("grupo R sin reembolso y stale: escala con un motivo legible", () => {
    const facts = baseFacts({
      stateGroup: "R",
      refundIssued: false,
      returnAgeBusinessDays: 9,
      returnRefundStale: true,
    });
    const reason = checkFailSafe(facts);
    assert.notEqual(reason, null);
    assert.match(reason!, /9 día/);
  });

  test("grupo R con reembolso ya emitido: no escala aunque returnRefundStale llegara true por error del llamador", () => {
    // computeOrderFacts nunca produce esta combinación (returnRefundStale exige refundIssued
    // false), pero checkFailSafe no debe depender de esa garantía externa para no escalar de más.
    const facts = baseFacts({ stateGroup: "R", refundIssued: true, returnRefundStale: false });
    assert.equal(checkFailSafe(facts), null);
  });

  test("grupo F no dispara el fail-safe de grupo D: nunca escala en código, la matriz decide", () => {
    // Antes de T2, cualquier estado no sembrado (incluidos los de reembolso) caía en D y
    // `checkFailSafe` escalaba siempre. F es un grupo propio: no debe pisar esa rama.
    const facts = baseFacts({ stateGroup: "F" });
    assert.equal(checkFailSafe(facts), null);
  });

  test("grupo F con stock/marca en un estado que dispararía el fail-safe de A no escala: esas comprobaciones son solo del grupo A", () => {
    const facts = baseFacts({ stateGroup: "F", unknownBrands: ["Marca Fantasma"] });
    assert.equal(checkFailSafe(facts), null);
  });
});

// ─── evaluateRules — las 13 filas del §4, contra la siembra real ────────

describe("evaluateRules — matriz §4 (13 filas, siembra real)", () => {
  // Las prioridades de la siembra ya no son 1-13: las dos filas del grupo R (MAIL_12/MAIL_10, T2)
  // se insertaron al principio (0-1) y la fila del grupo F (MAIL_REFUND, T2) entre el §4 y el
  // grupo D. "fila N" en cada título sigue nombrando la fila del documento (§4), no la prioridad.
  test("fila 1: Grupo A, EN_STOCK, sin retraso → MAIL_1", () => {
    const facts = baseFacts({ stateGroup: "A", stockStatus: "EN_STOCK", delayBucket: "NONE" });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_1");
    assert.equal(result.matchedRule?.priority, 2);
  });

  test("fila 2: Grupo A, EN_STOCK, retraso corto → MAIL_2", () => {
    const facts = baseFacts({ stateGroup: "A", stockStatus: "EN_STOCK", delayBucket: "SHORT", delayDays: 2 });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_2");
    assert.equal(result.matchedRule?.priority, 3);
  });

  test("fila 3: Grupo A, EN_STOCK, retraso largo → MAIL_15", () => {
    const facts = baseFacts({ stateGroup: "A", stockStatus: "EN_STOCK", delayBucket: "LONG", delayDays: 10 });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_15");
    assert.equal(result.matchedRule?.priority, 4);
  });

  test("fila 4: Grupo A, SIN_STOCK monomarca, sin retraso → MAIL_5", () => {
    const facts = baseFacts({
      stateGroup: "A",
      stockStatus: "SIN_STOCK",
      brandCount: "ONE",
      affectedBrands: ["Aubade"],
      delayBucket: "NONE",
      leadDays: 5,
      limitDate: utc(2026, 1, 12),
      lines: [factLine({ stockQuantity: -1, covered: false })],
    });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_5");
    assert.equal(result.matchedRule?.priority, 5);
  });

  test("fila 5: Grupo A, SIN_STOCK multimarca, sin retraso → MAIL_4", () => {
    const facts = baseFacts({
      stateGroup: "A",
      stockStatus: "SIN_STOCK",
      brandCount: "MANY",
      affectedBrands: ["Aubade", "Sloggi"],
      delayBucket: "NONE",
      leadDays: 9,
      limitDate: utc(2026, 1, 20),
      lines: [
        factLine({ name: "Sujetador", brand: "Aubade", stockQuantity: -1, covered: false }),
        factLine({ name: "Culotte", brand: "Sloggi", stockQuantity: -1, covered: false }),
      ],
    });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_4");
    assert.equal(result.matchedRule?.priority, 6);
  });

  test("fila 6: Grupo A, SIN_STOCK monomarca, con retraso (LONG) → MAIL_15, no ESCALATE", () => {
    // Este es el caso concreto de la costura de POSITIVE: los hechos nunca
    // producen POSITIVE, así que si el evaluador comparara por igualdad en
    // vez de usar matchesDelayBucket, esta fila nunca matchearía.
    const facts = baseFacts({
      stateGroup: "A",
      stockStatus: "SIN_STOCK",
      brandCount: "ONE",
      affectedBrands: ["Aubade"],
      delayBucket: "LONG",
      delayDays: 8,
      leadDays: 5,
      limitDate: utc(2026, 1, 12),
      lines: [factLine({ stockQuantity: -1, covered: false })],
    });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_15");
    assert.notEqual(result.outcome, "ESCALATE");
    assert.equal(result.matchedRule?.priority, 7);
  });

  test("fila 7: Grupo A, SIN_STOCK multimarca, con retraso (SHORT) → MAIL_15, no ESCALATE", () => {
    const facts = baseFacts({
      stateGroup: "A",
      stockStatus: "SIN_STOCK",
      brandCount: "MANY",
      affectedBrands: ["Aubade", "Sloggi"],
      delayBucket: "SHORT",
      delayDays: 1,
      leadDays: 9,
      limitDate: utc(2026, 1, 20),
      lines: [
        factLine({ name: "Sujetador", brand: "Aubade", stockQuantity: -1, covered: false }),
        factLine({ name: "Culotte", brand: "Sloggi", stockQuantity: -1, covered: false }),
      ],
    });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_15");
    assert.notEqual(result.outcome, "ESCALATE");
    assert.equal(result.matchedRule?.priority, 8);
  });

  test("fila 8: Grupo B con tracking → MAIL_3", () => {
    const facts = baseFacts({ stateGroup: "B", hasTracking: true });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_3");
    assert.equal(result.matchedRule?.priority, 9);
  });

  test("fila 9: Grupo B sin tracking → ESCALATE", () => {
    const facts = baseFacts({ stateGroup: "B", hasTracking: false });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "ESCALATE");
    assert.equal(result.matchedRule?.priority, 10);
  });

  test("filas 10/11 (T3): Grupo C con tracking → MAIL_7", () => {
    // `historyHasInfo` ya no decide nada para el grupo C (§ hallazgo 3,
    // docs/hallazgos-conversaciones-flow-test.md: `computeHistoryHasInfo` nunca produce `true`, así
    // que las dos filas originales del §4 nunca podían matchear a la vez un pedido real). Se
    // construye a propósito con `historyHasInfo: null`, el valor real más común (hay algún mensaje
    // público), para probar que ya no importa.
    const facts = baseFacts({ stateGroup: "C", hasTracking: true, historyHasInfo: null });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_7");
    assert.equal(result.matchedRule?.priority, 11);
  });

  test("filas 10/11 (T3): Grupo C sin tracking → ESCALATE", () => {
    const facts = baseFacts({ stateGroup: "C", hasTracking: false, historyHasInfo: null });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "ESCALATE");
    assert.equal(result.matchedRule?.priority, 12);
  });

  test("fila 12: Grupo D → ESCALATE (intercepta el fail-safe, no la fila 12)", () => {
    const facts = baseFacts({ stateGroup: "D" });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "ESCALATE");
    // No se consultó ninguna fila: la traza no puede venir de la matriz.
    assert.equal(result.matchedRule, null);
  });

  test("fila 13 (cajón de sastre): matchea cualquier hecho cuando es la única fila disponible", () => {
    // Antes de T3, un grupo C con `historyHasInfo: null` (el valor real más común: hay algún
    // mensaje público) no matcheaba ni la fila 10 (exigía true) ni la 11 (exigía false) y caía
    // acá — era, de hecho, el bug real de esta tarea (§ hallazgo 3,
    // docs/hallazgos-conversaciones-flow-test.md). Tras T3 eso ya no ocurre: A, B, C y F quedan
    // completamente cubiertos por sus propias filas (todas sus condiciones son booleanas, nunca
    // `null`, en `OrderFacts` real) y D/R quedan resueltos por el fail-safe antes de llegar a la
    // matriz — así que con la siembra actual y hechos reales, esta fila es inalcanzable. Sigue
    // siendo una red de seguridad real para un conjunto de reglas cargado desde base que no cubra
    // alguna combinación (edición futura por MCP): se verifica en aislamiento, evaluando solo ella.
    const catchAll = ruleDecisionSeed.find((r) => r.stateGroup === null)!;
    const facts = baseFacts({ stateGroup: "C", hasTracking: true, historyHasInfo: null });
    const result = evaluateRules(facts, [catchAll]);
    assert.equal(result.outcome, "ESCALATE");
    assert.equal(result.matchedRule?.priority, catchAll.priority);
  });
});

// ─── Casos explícitamente pedidos, más allá de la batería de §4 ─────────

describe("evaluateRules — casos transversales", () => {
  test("marca desconocida escala aunque la fila 4/5 hubiera matcheado", () => {
    const facts = baseFacts({
      stateGroup: "A",
      stockStatus: "SIN_STOCK",
      brandCount: "ONE",
      affectedBrands: ["Marca Fantasma"],
      unknownBrands: ["Marca Fantasma"],
      delayBucket: "NONE",
      leadDays: null,
      limitDate: null,
      lines: [factLine({ brand: "Marca Fantasma", stockQuantity: -1, covered: false })],
    });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "ESCALATE");
    assert.equal(result.matchedRule, null, "debe escalar por fail-safe, sin llegar a consultar la matriz");
  });

  test("matriz vacía → ESCALATE", () => {
    const facts = baseFacts({ stateGroup: "A", stockStatus: "EN_STOCK", delayBucket: "NONE" });
    const result = evaluateRules(facts, []);
    assert.equal(result.outcome, "ESCALATE");
    assert.equal(result.matchedRule, null);
    assert.notEqual(result.escalateReason, null);
  });

  test("matriz sin ninguna fila que matchee → ESCALATE, nunca un mail parecido", () => {
    const facts = baseFacts({ stateGroup: "A", stockStatus: "EN_STOCK", delayBucket: "NONE" });
    const soloFilaB: RuleDecisionSeed[] = [
      {
        priority: 1,
        stateGroup: "B",
        stockStatus: null,
        brandCount: null,
        delayBucket: null,
        hasTracking: true,
        historyHasInfo: null,
        refundIssued: null,
        outcome: "MAIL_3",
        note: "única fila, no aplica a este pedido",
      },
    ];
    const result = evaluateRules(facts, soloFilaB);
    assert.equal(result.outcome, "ESCALATE");
    assert.equal(result.matchedRule, null);
  });

  test("la traza identifica la fila ganadora (priority y note)", () => {
    const facts = baseFacts({ stateGroup: "A", stockStatus: "EN_STOCK", delayBucket: "NONE" });
    const result = evaluateRules(facts, ruleDecisionSeed);
    const filaEsperada = ruleDecisionSeed.find((r) => r.outcome === "MAIL_1")!;
    assert.deepEqual(result.matchedRule, { priority: filaEsperada.priority, note: filaEsperada.note });
  });

  test("prioridades ascendentes: gana la primera fila que matchea, no otra que también matchearía", () => {
    // La siembra real ya usa las prioridades 0 y 1 para el grupo R (T2), así que la fila ficticia
    // de este test usa -1 para seguir garantizando que gana por tener la prioridad más baja de
    // todas, sin colisionar con ninguna fila real.
    const facts = baseFacts({ stateGroup: "A", stockStatus: "EN_STOCK", delayBucket: "NONE" });
    const filaCero: RuleDecisionSeed = {
      priority: -1,
      stateGroup: "A",
      stockStatus: "EN_STOCK",
      brandCount: null,
      delayBucket: "NONE",
      hasTracking: null,
      historyHasInfo: null,
      refundIssued: null,
      outcome: "MAIL_2",
      note: "fila de prueba con prioridad más alta",
    };
    const result = evaluateRules(facts, [filaCero, ...ruleDecisionSeed]);
    assert.equal(result.outcome, "MAIL_2");
    assert.equal(result.matchedRule?.priority, -1);
  });
});

// ─── evaluateRules — bloque RETORNO (grupo R) y grupo F (T2) ───────────

describe("evaluateRules — grupo R: MAIL_12 con reembolso, MAIL_10 sin él", () => {
  test("grupo R con reembolso ya emitido → MAIL_12", () => {
    const facts = baseFacts({ stateGroup: "R", refundIssued: true });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_12");
    assert.equal(result.matchedRule?.priority, 0);
  });

  test("grupo R sin reembolso, dentro del plazo → MAIL_10, no ESCALATE", () => {
    const facts = baseFacts({ stateGroup: "R", refundIssued: false, returnRefundStale: false });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_10");
    assert.equal(result.matchedRule?.priority, 1);
  });

  test("grupo R sin reembolso y stale: el fail-safe de checkFailSafe intercepta antes que la fila MAIL_10", () => {
    const facts = baseFacts({
      stateGroup: "R",
      refundIssued: false,
      returnAgeBusinessDays: 12,
      returnRefundStale: true,
    });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "ESCALATE");
    // Viene del fail-safe en código, no de una fila de la matriz.
    assert.equal(result.matchedRule, null);
    assert.match(result.escalateReason!, /12 día/);
  });
});

describe("evaluateRules — grupo F (estados de reembolso) → MAIL_REFUND", () => {
  test("cualquier pedido del grupo F resuelve a MAIL_REFUND, sin condición de reembolso en la matriz", () => {
    const facts = baseFacts({ stateGroup: "F", refundIssued: true });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_REFUND");
  });

  test("grupo F sin reembolso todavía registrado también resuelve a MAIL_REFUND en la matriz (buildGuidance decide si puede contestar)", () => {
    const facts = baseFacts({ stateGroup: "F", refundIssued: false });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_REFUND");
  });

  test("grupo F no cae en el fail-safe del grupo D", () => {
    const facts = baseFacts({ stateGroup: "F" });
    assert.equal(checkFailSafe(facts), null);
  });
});

// ─── buildGuidance ───────────────────────────────────────────────────────

describe("buildGuidance", () => {
  test("ESCALATE: must_escalate true, can_answer false, sin facts_to_convey ni plantilla", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "ESCALATE",
      matchedRule: null,
      escalateReason: "motivo de prueba",
    };
    const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed);
    assert.equal(guidance.situation, "ESCALATE");
    assert.equal(guidance.must_escalate, true);
    assert.equal(guidance.can_answer, false);
    assert.equal(guidance.escalate_reason, "motivo de prueba");
    assert.deepEqual(guidance.facts_to_convey, []);
    assert.equal(guidance.reference_template, null);
    assert.equal(guidance.template_text, null);
  });

  test("MAIL_1 resuelto: can_answer true, must_escalate false, sin datos faltantes", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_1",
      matchedRule: { priority: 1, note: "nota" },
      escalateReason: null,
    };
    const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed);
    assert.equal(guidance.can_answer, true);
    assert.equal(guidance.must_escalate, false);
    assert.equal(guidance.escalate_reason, null);
    assert.deepEqual(guidance.missing_facts, []);
    assert.deepEqual(guidance.facts_to_convey, [{ key: "order_reference", value: baseOrder.reference }]);
  });

  test("MAIL_3 con tracking disponible: tracking_url se resuelve", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_3",
      matchedRule: { priority: 8, note: "nota" },
      escalateReason: null,
    };
    const order: GuidanceOrderContext = { ...baseOrder, trackingUrl: "https://exemple.test/suivi/ABC" };
    const guidance = buildGuidance(evaluation, baseFacts({ hasTracking: true }), order, ruleTemplateSeed);
    assert.equal(guidance.must_escalate, false);
    assert.ok(guidance.facts_to_convey.some((f) => f.key === "tracking_url" && f.value === order.trackingUrl));
  });

  test("MAIL_3 sin tracking disponible: missing_facts lo lista y must_escalate es true", () => {
    // Caso explícito del prompt: una plantilla que exige tracking_url sin
    // tracking disponible en el contexto del pedido, más allá de lo que ya
    // filtra la fila 8/9 de la matriz.
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_3",
      matchedRule: { priority: 8, note: "nota" },
      escalateReason: null,
    };
    const order: GuidanceOrderContext = { ...baseOrder, trackingUrl: null };
    const guidance = buildGuidance(evaluation, baseFacts({ hasTracking: true }), order, ruleTemplateSeed);
    assert.equal(guidance.must_escalate, true);
    assert.equal(guidance.can_answer, false);
    assert.ok(guidance.missing_facts.includes("tracking_url"));
    assert.notEqual(guidance.escalate_reason, null);
  });

  test("MAIL_5 con limit_date resuelto: formato francés DD/MM/AAAA", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_5",
      matchedRule: { priority: 4, note: "nota" },
      escalateReason: null,
    };
    const facts = baseFacts({
      stateGroup: "A",
      stockStatus: "SIN_STOCK",
      brandCount: "ONE",
      limitDate: utc(2026, 3, 7),
    });
    const guidance = buildGuidance(evaluation, facts, baseOrder, ruleTemplateSeed);
    assert.ok(guidance.facts_to_convey.some((f) => f.key === "limit_date" && f.value === "07/03/2026"));
  });

  test("MAIL_5 sin limit_date calculable: dato faltante, se escala", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_5",
      matchedRule: { priority: 4, note: "nota" },
      escalateReason: null,
    };
    const facts = baseFacts({ limitDate: null });
    const guidance = buildGuidance(evaluation, facts, baseOrder, ruleTemplateSeed);
    assert.ok(guidance.missing_facts.includes("limit_date"));
    assert.equal(guidance.must_escalate, true);
  });

  test("MAIL_4 resuelve out_of_stock_products como 'nombre — marca'", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_4",
      matchedRule: { priority: 5, note: "nota" },
      escalateReason: null,
    };
    const facts = baseFacts({
      limitDate: utc(2026, 1, 20),
      lines: [
        factLine({ name: "Sujetador corbeille", brand: "Aubade", stockQuantity: -1, covered: false }),
        factLine({ name: "Culotte", brand: "Sloggi", stockQuantity: 3, covered: true }),
      ],
    });
    const guidance = buildGuidance(evaluation, facts, baseOrder, ruleTemplateSeed);
    const fact = guidance.facts_to_convey.find((f) => f.key === "out_of_stock_products");
    assert.ok(fact);
    assert.equal(fact!.value, "Sujetador corbeille — Aubade");
  });

  // MAIL_6 ya no tiene plantilla sembrada (T3: su fila de la matriz se quitó, ver
  // order-rules-seed.ts). `resolveFactValue` sigue resolviendo `pending_products`/`additional_delay`
  // de forma genérica (no depende de qué plantilla los pida), así que estos dos tests siguen
  // probando esa lógica con una plantilla local, sin depender de la siembra real.
  const mail6TemplateFixture: RuleTemplateSeed[] = [
    {
      outcome: "MAIL_6",
      lang: "fr",
      body: "",
      factsToConvey: ["pending_products", "tracking_url", "additional_delay"],
      mustNotClaim: [],
    },
  ];

  test("MAIL_6 (plantilla local, no sembrada) resuelve pending_products, tracking_url y additional_delay cuando todo el contexto llega", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_6",
      matchedRule: { priority: 10, note: "nota" },
      escalateReason: null,
    };
    const order: GuidanceOrderContext = { ...baseOrder, trackingUrl: "https://exemple.test/suivi/ABC" };
    const guidance = buildGuidance(evaluation, baseFacts({ hasTracking: true }), order, mail6TemplateFixture, {
      pendingProducts: "Sujetador Aubade talla 90B",
      additionalDelay: "5 días hábiles adicionales",
    });
    assert.equal(guidance.must_escalate, false);
    assert.deepEqual(
      guidance.facts_to_convey.sort((a, b) => a.key.localeCompare(b.key)),
      [
        { key: "additional_delay", value: "5 días hábiles adicionales" },
        { key: "pending_products", value: "Sujetador Aubade talla 90B" },
        { key: "tracking_url", value: order.trackingUrl },
      ]
    );
  });

  test("MAIL_6 (plantilla local, no sembrada) sin contexto extra: pending_products y additional_delay son datos faltantes", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_6",
      matchedRule: { priority: 10, note: "nota" },
      escalateReason: null,
    };
    const order: GuidanceOrderContext = { ...baseOrder, trackingUrl: "https://exemple.test/suivi/ABC" };
    const guidance = buildGuidance(evaluation, baseFacts(), order, mail6TemplateFixture);
    assert.ok(guidance.missing_facts.includes("pending_products"));
    assert.ok(guidance.missing_facts.includes("additional_delay"));
    assert.equal(guidance.must_escalate, true);
  });

  test("MAIL_6 contra la siembra real: sin plantilla sembrada, escala por missingTemplate (T3)", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_6",
      matchedRule: { priority: 10, note: "nota" },
      escalateReason: null,
    };
    const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed);
    assert.equal(guidance.must_escalate, true);
    assert.equal(guidance.reference_template, null);
    assert.match(guidance.escalate_reason!, /No hay ninguna plantilla sembrada/);
  });

  test("MAIL_12 resuelve processed_date en formato francés y refund_method desde el contexto extra (T2)", () => {
    // La plantilla de MAIL_12 pasó a exigir también refund_method (§ user requirement: "la info del
    // pedido tiene que decir si una devolución se reembolsó como vale en vez de dinero"): sin
    // `extra.refund`, este desenlace ahora escalaría por dato faltante.
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_12",
      matchedRule: null,
      escalateReason: null,
    };
    const guidance = buildGuidance(evaluation, baseFacts({ stateGroup: "R", refundIssued: true }), baseOrder, ruleTemplateSeed, {
      processedDate: utc(2026, 5, 1),
      refund: { type: "MONEY", voucherExpiresAt: null, lineNames: [] },
    });
    assert.deepEqual(
      guidance.facts_to_convey.sort((a, b) => a.key.localeCompare(b.key)),
      [
        { key: "processed_date", value: "01/05/2026" },
        { key: "refund_method", value: "remboursement sur le moyen de paiement utilisé pour la commande" },
      ]
    );
    assert.equal(guidance.must_escalate, false);
  });

  test("MAIL_12 sin extra.refund: refund_method es un dato faltante y se escala", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_12",
      matchedRule: null,
      escalateReason: null,
    };
    const guidance = buildGuidance(evaluation, baseFacts({ stateGroup: "R", refundIssued: true }), baseOrder, ruleTemplateSeed, {
      processedDate: utc(2026, 5, 1),
    });
    assert.ok(guidance.missing_facts.includes("refund_method"));
    assert.equal(guidance.must_escalate, true);
  });

  test("must_not_claim viaja tal cual desde la plantilla del desenlace", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_1",
      matchedRule: { priority: 1, note: "nota" },
      escalateReason: null,
    };
    const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed);
    const plantilla = ruleTemplateSeed.find((t) => t.outcome === "MAIL_1")!;
    assert.deepEqual(guidance.must_not_claim, plantilla.mustNotClaim);
  });

  // ─── returnDataAvailable: prohibición de confundir tracking de ida con retorno ──
  //
  // Fallo real de producción (conversación VJWIRCHVQ): la clienta preguntó por su
  // retorno, la tool devolvió `tracking_url`/`order_reference` (el envío DE IDA) y
  // nada en `must_not_claim` prohibía presentarlo como el seguimiento del retorno.
  // El agente lo hizo, dos veces. Estos tests verifican que, mientras el servicio
  // no pueda ver `order_returns`, la prohibición se agrega SIEMPRE, sin importar
  // qué plantilla ganó ni si el pedido termina escalando.

  const RETURN_TRACKING_PROHIBITION =
    "must not present the outbound tracking number as tracking for the customer's return";
  const RETURN_STATUS_PROHIBITION =
    "must not state the status of a return in progress: this service cannot see returns that have not " +
    "been completed, so hand over to a human instead";

  describe("buildGuidance — prohibición de retorno (returnDataAvailable)", () => {
    test("MAIL_3 con returnDataAvailable false: must_not_claim agrega las dos prohibiciones a las de la plantilla", () => {
      const evaluation: RuleEvaluationResult = {
        outcome: "MAIL_3",
        matchedRule: { priority: 8, note: "nota" },
        escalateReason: null,
      };
      const order: GuidanceOrderContext = { ...baseOrder, trackingUrl: "https://exemple.test/suivi/ABC" };
      const guidance = buildGuidance(evaluation, baseFacts({ hasTracking: true }), order, ruleTemplateSeed, {
        returnDataAvailable: false,
      });
      const plantilla = ruleTemplateSeed.find((t) => t.outcome === "MAIL_3")!;
      assert.deepEqual(guidance.must_not_claim, [
        ...plantilla.mustNotClaim,
        RETURN_TRACKING_PROHIBITION,
        RETURN_STATUS_PROHIBITION,
      ]);
      // No es un efecto secundario de escalar: MAIL_3 sigue resuelto normalmente.
      assert.equal(guidance.must_escalate, false);
    });

    test("MAIL_1 con returnDataAvailable false: must_not_claim agrega las dos prohibiciones", () => {
      const evaluation: RuleEvaluationResult = {
        outcome: "MAIL_1",
        matchedRule: { priority: 1, note: "nota" },
        escalateReason: null,
      };
      const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed, {
        returnDataAvailable: false,
      });
      const plantilla = ruleTemplateSeed.find((t) => t.outcome === "MAIL_1")!;
      assert.deepEqual(guidance.must_not_claim, [
        ...plantilla.mustNotClaim,
        RETURN_TRACKING_PROHIBITION,
        RETURN_STATUS_PROHIBITION,
      ]);
    });

    test("MAIL_12 con returnDataAvailable false: must_not_claim agrega las dos prohibiciones a las propias del reembolso", () => {
      const evaluation: RuleEvaluationResult = {
        outcome: "MAIL_12",
        matchedRule: null,
        escalateReason: null,
      };
      const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed, {
        processedDate: utc(2026, 5, 1),
        returnDataAvailable: false,
      });
      const plantilla = ruleTemplateSeed.find((t) => t.outcome === "MAIL_12")!;
      assert.deepEqual(guidance.must_not_claim, [
        ...plantilla.mustNotClaim,
        RETURN_TRACKING_PROHIBITION,
        RETURN_STATUS_PROHIBITION,
      ]);
    });

    test("ESCALATE con returnDataAvailable false: las dos prohibiciones llegan igual, aunque no haya plantilla", () => {
      const evaluation: RuleEvaluationResult = {
        outcome: "ESCALATE",
        matchedRule: null,
        escalateReason: "motivo de prueba",
      };
      const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed, {
        returnDataAvailable: false,
      });
      assert.equal(guidance.must_escalate, true);
      assert.deepEqual(guidance.must_not_claim, [RETURN_TRACKING_PROHIBITION, RETURN_STATUS_PROHIBITION]);
    });

    test("must_escalate true por datos faltantes (no por ESCALATE de la matriz) con returnDataAvailable false: mismo comportamiento", () => {
      // MAIL_3 sin tracking_url resuelto: escala por dato faltante (§7.4), no porque
      // la matriz haya dicho ESCALATE. La prohibición de retorno se agrega igual.
      const evaluation: RuleEvaluationResult = {
        outcome: "MAIL_3",
        matchedRule: { priority: 8, note: "nota" },
        escalateReason: null,
      };
      const order: GuidanceOrderContext = { ...baseOrder, trackingUrl: null };
      const guidance = buildGuidance(evaluation, baseFacts({ hasTracking: true }), order, ruleTemplateSeed, {
        returnDataAvailable: false,
      });
      assert.equal(guidance.must_escalate, true);
      assert.ok(guidance.must_not_claim.includes(RETURN_TRACKING_PROHIBITION));
      assert.ok(guidance.must_not_claim.includes(RETURN_STATUS_PROHIBITION));
    });

    test("returnDataAvailable true: no agrega ninguna prohibición de retorno", () => {
      const evaluation: RuleEvaluationResult = {
        outcome: "MAIL_1",
        matchedRule: { priority: 1, note: "nota" },
        escalateReason: null,
      };
      const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed, {
        returnDataAvailable: true,
      });
      const plantilla = ruleTemplateSeed.find((t) => t.outcome === "MAIL_1")!;
      assert.deepEqual(guidance.must_not_claim, plantilla.mustNotClaim);
      assert.ok(!guidance.must_not_claim.includes(RETURN_TRACKING_PROHIBITION));
      assert.ok(!guidance.must_not_claim.includes(RETURN_STATUS_PROHIBITION));
    });

    test("returnDataAvailable ausente (default): no agrega ninguna prohibición de retorno", () => {
      const evaluation: RuleEvaluationResult = {
        outcome: "MAIL_1",
        matchedRule: { priority: 1, note: "nota" },
        escalateReason: null,
      };
      const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed);
      assert.ok(!guidance.must_not_claim.includes(RETURN_TRACKING_PROHIBITION));
      assert.ok(!guidance.must_not_claim.includes(RETURN_STATUS_PROHIBITION));
    });
  });

  // ─── refund_method / refunded_products / return_received_date (T2) ────
  //
  // Fact nuevo pedido por el usuario: "la info del pedido tiene que decir si una devolución se
  // reembolsó como vale en vez de dinero". `extra.refund` alimenta tres cosas: el fact
  // `refund_method` (VOUCHER/MONEY en francés), el fact `refunded_products`, y la prohibición
  // dinámica de `must_not_claim` — igual patrón que `returnDataAvailable`.

  const VOUCHER_REFUND_PROHIBITION =
    "must not say the money was refunded to the customer's bank or card: this refund was issued as a " +
    "store credit (avoir)";
  const MONEY_REFUND_PROHIBITION = "must not describe this refund as a voucher or store credit (avoir)";

  describe("buildGuidance — refund_method", () => {
    test("VOUCHER sin voucherExpiresAt conocido: 'avoir', sin fecha", () => {
      const evaluation: RuleEvaluationResult = { outcome: "MAIL_12", matchedRule: null, escalateReason: null };
      const guidance = buildGuidance(evaluation, baseFacts({ stateGroup: "R", refundIssued: true }), baseOrder, ruleTemplateSeed, {
        processedDate: utc(2026, 5, 1),
        refund: { type: "VOUCHER", voucherExpiresAt: null, lineNames: [] },
      });
      const fact = guidance.facts_to_convey.find((f) => f.key === "refund_method");
      assert.equal(fact?.value, "avoir");
    });

    test("VOUCHER con voucherExpiresAt conocido: agrega la caducidad en formato francés", () => {
      const evaluation: RuleEvaluationResult = { outcome: "MAIL_12", matchedRule: null, escalateReason: null };
      const guidance = buildGuidance(evaluation, baseFacts({ stateGroup: "R", refundIssued: true }), baseOrder, ruleTemplateSeed, {
        processedDate: utc(2026, 5, 1),
        refund: { type: "VOUCHER", voucherExpiresAt: utc(2026, 12, 31), lineNames: [] },
      });
      const fact = guidance.facts_to_convey.find((f) => f.key === "refund_method");
      assert.equal(fact?.value, "avoir valable jusqu'au 31/12/2026");
    });

    test("MONEY: reembolso sobre el medio de pago original, sin caducidad", () => {
      const evaluation: RuleEvaluationResult = { outcome: "MAIL_12", matchedRule: null, escalateReason: null };
      const guidance = buildGuidance(evaluation, baseFacts({ stateGroup: "R", refundIssued: true }), baseOrder, ruleTemplateSeed, {
        processedDate: utc(2026, 5, 1),
        refund: { type: "MONEY", voucherExpiresAt: null, lineNames: [] },
      });
      const fact = guidance.facts_to_convey.find((f) => f.key === "refund_method");
      assert.equal(fact?.value, "remboursement sur le moyen de paiement utilisé pour la commande");
    });

    test("sin extra.refund: refund_method es null (dato faltante), nunca se inventa", () => {
      const evaluation: RuleEvaluationResult = { outcome: "MAIL_12", matchedRule: null, escalateReason: null };
      const guidance = buildGuidance(evaluation, baseFacts({ stateGroup: "R", refundIssued: true }), baseOrder, ruleTemplateSeed, {
        processedDate: utc(2026, 5, 1),
      });
      assert.ok(guidance.missing_facts.includes("refund_method"));
    });
  });

  describe("buildGuidance — prohibición dinámica vale/dinero", () => {
    test("VOUCHER: agrega VOUCHER_REFUND_PROHIBITION, sea cual sea el desenlace", () => {
      const evaluation: RuleEvaluationResult = { outcome: "MAIL_12", matchedRule: null, escalateReason: null };
      const guidance = buildGuidance(evaluation, baseFacts({ stateGroup: "R", refundIssued: true }), baseOrder, ruleTemplateSeed, {
        processedDate: utc(2026, 5, 1),
        refund: { type: "VOUCHER", voucherExpiresAt: null, lineNames: [] },
      });
      assert.ok(guidance.must_not_claim.includes(VOUCHER_REFUND_PROHIBITION));
      assert.ok(!guidance.must_not_claim.includes(MONEY_REFUND_PROHIBITION));
    });

    test("MONEY: agrega MONEY_REFUND_PROHIBITION", () => {
      const evaluation: RuleEvaluationResult = { outcome: "MAIL_12", matchedRule: null, escalateReason: null };
      const guidance = buildGuidance(evaluation, baseFacts({ stateGroup: "R", refundIssued: true }), baseOrder, ruleTemplateSeed, {
        processedDate: utc(2026, 5, 1),
        refund: { type: "MONEY", voucherExpiresAt: null, lineNames: [] },
      });
      assert.ok(guidance.must_not_claim.includes(MONEY_REFUND_PROHIBITION));
      assert.ok(!guidance.must_not_claim.includes(VOUCHER_REFUND_PROHIBITION));
    });

    test("sin extra.refund: no agrega ninguna de las dos", () => {
      const evaluation: RuleEvaluationResult = {
        outcome: "MAIL_1",
        matchedRule: { priority: 1, note: "nota" },
        escalateReason: null,
      };
      const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed);
      assert.ok(!guidance.must_not_claim.includes(VOUCHER_REFUND_PROHIBITION));
      assert.ok(!guidance.must_not_claim.includes(MONEY_REFUND_PROHIBITION));
    });

    test("se agrega aunque el desenlace escale (mismo patrón que returnDataAvailable)", () => {
      const evaluation: RuleEvaluationResult = { outcome: "ESCALATE", matchedRule: null, escalateReason: "motivo" };
      const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed, {
        refund: { type: "VOUCHER", voucherExpiresAt: null, lineNames: [] },
      });
      assert.equal(guidance.must_escalate, true);
      assert.ok(guidance.must_not_claim.includes(VOUCHER_REFUND_PROHIBITION));
    });
  });

  // ─── MAIL_10 (retorno sin reembolso, A.6) y MAIL_REFUND (grupo F) — T2 ──

  describe("buildGuidance — MAIL_10 (return_received_date)", () => {
    test("resuelve order_reference y return_received_date en formato francés", () => {
      const evaluation: RuleEvaluationResult = { outcome: "MAIL_10", matchedRule: { priority: 1, note: "nota" }, escalateReason: null };
      const facts = baseFacts({ stateGroup: "R", refundIssued: false, returnEnteredAt: utc(2026, 9, 20) });
      const guidance = buildGuidance(evaluation, facts, baseOrder, ruleTemplateSeed);
      assert.equal(guidance.must_escalate, false);
      assert.deepEqual(
        guidance.facts_to_convey.sort((a, b) => a.key.localeCompare(b.key)),
        [
          { key: "order_reference", value: baseOrder.reference },
          { key: "return_received_date", value: "20/09/2026" },
        ]
      );
    });

    test("sin returnEnteredAt: return_received_date es un dato faltante, se escala", () => {
      const evaluation: RuleEvaluationResult = { outcome: "MAIL_10", matchedRule: { priority: 1, note: "nota" }, escalateReason: null };
      const facts = baseFacts({ stateGroup: "R", refundIssued: false, returnEnteredAt: null });
      const guidance = buildGuidance(evaluation, facts, baseOrder, ruleTemplateSeed);
      assert.ok(guidance.missing_facts.includes("return_received_date"));
      assert.equal(guidance.must_escalate, true);
    });

    test("el body de la plantilla es el texto A.6 transcrito", () => {
      const evaluation: RuleEvaluationResult = { outcome: "MAIL_10", matchedRule: { priority: 1, note: "nota" }, escalateReason: null };
      const facts = baseFacts({ stateGroup: "R", refundIssued: false, returnEnteredAt: utc(2026, 9, 20) });
      const guidance = buildGuidance(evaluation, facts, baseOrder, ruleTemplateSeed);
      assert.match(guidance.template_text!, /bien été reçu le \[Date\]/);
    });
  });

  describe("buildGuidance — MAIL_REFUND (grupo F, T2)", () => {
    test("con avoir disponible: resuelve las cuatro claves (order_reference, processed_date, refund_method, refunded_products)", () => {
      const evaluation: RuleEvaluationResult = { outcome: "MAIL_REFUND", matchedRule: { priority: 13, note: "nota" }, escalateReason: null };
      const facts = baseFacts({ stateGroup: "F" });
      const guidance = buildGuidance(evaluation, facts, baseOrder, ruleTemplateSeed, {
        processedDate: utc(2026, 9, 18),
        refund: { type: "MONEY", voucherExpiresAt: null, lineNames: ["Soutien-gorge corbeille", "Culotte"] },
      });
      assert.equal(guidance.must_escalate, false);
      assert.deepEqual(
        guidance.facts_to_convey.sort((a, b) => a.key.localeCompare(b.key)),
        [
          { key: "order_reference", value: baseOrder.reference },
          { key: "processed_date", value: "18/09/2026" },
          { key: "refund_method", value: "remboursement sur le moyen de paiement utilisé pour la commande" },
          { key: "refunded_products", value: "Soutien-gorge corbeille, Culotte" },
        ]
      );
    });

    test("sin ningún avoir todavía: las cuatro claves relacionadas con el reembolso faltan, se escala", () => {
      const evaluation: RuleEvaluationResult = { outcome: "MAIL_REFUND", matchedRule: { priority: 13, note: "nota" }, escalateReason: null };
      const facts = baseFacts({ stateGroup: "F" });
      const guidance = buildGuidance(evaluation, facts, baseOrder, ruleTemplateSeed);
      assert.ok(guidance.missing_facts.includes("processed_date"));
      assert.ok(guidance.missing_facts.includes("refund_method"));
      assert.ok(guidance.missing_facts.includes("refunded_products"));
      assert.equal(guidance.must_escalate, true);
      assert.equal(guidance.can_answer, false);
    });

    test("avoir sin líneas cruzadas (ej. 100% envío): refunded_products falta, se escala igual", () => {
      const evaluation: RuleEvaluationResult = { outcome: "MAIL_REFUND", matchedRule: { priority: 13, note: "nota" }, escalateReason: null };
      const facts = baseFacts({ stateGroup: "F" });
      const guidance = buildGuidance(evaluation, facts, baseOrder, ruleTemplateSeed, {
        processedDate: utc(2026, 9, 18),
        refund: { type: "MONEY", voucherExpiresAt: null, lineNames: [] },
      });
      assert.ok(guidance.missing_facts.includes("refunded_products"));
      assert.equal(guidance.must_escalate, true);
    });
  });

  test("reply_language: id_lang 1/2/3 resuelven a fr/en/es", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_1",
      matchedRule: { priority: 1, note: "nota" },
      escalateReason: null,
    };
    for (const [idLang, esperado] of [
      [1, "fr"],
      [2, "en"],
      [3, "es"],
    ] as const) {
      const guidance = buildGuidance(evaluation, baseFacts(), { ...baseOrder, idLang }, ruleTemplateSeed);
      assert.equal(guidance.reply_language, esperado);
    }
  });

  test("reply_language: un id_lang fuera de {1,2,3} usa fr por defecto", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_1",
      matchedRule: { priority: 1, note: "nota" },
      escalateReason: null,
    };
    const guidance = buildGuidance(evaluation, baseFacts(), { ...baseOrder, idLang: 99 }, ruleTemplateSeed);
    assert.equal(guidance.reply_language, "fr");
  });

  test("outcome resuelto sin plantilla sembrada para él: se escala igual", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_2",
      matchedRule: { priority: 2, note: "nota" },
      escalateReason: null,
    };
    // Se le pasa un catálogo de plantillas que no incluye MAIL_2.
    const templatesSinMail2 = ruleTemplateSeed.filter((t) => t.outcome !== "MAIL_2");
    const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, templatesSinMail2);
    assert.equal(guidance.must_escalate, true);
    assert.equal(guidance.can_answer, false);
    assert.notEqual(guidance.escalate_reason, null);
  });

  test("template_text es null cuando el body sembrado está vacío (pendiente de fuente externa)", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_1",
      matchedRule: { priority: 1, note: "nota" },
      escalateReason: null,
    };
    const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed);
    assert.equal(guidance.template_text, null);
  });

  test("template_text trae el body cuando existe (mail 4, el único redactado en el documento)", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_4",
      matchedRule: { priority: 5, note: "nota" },
      escalateReason: null,
    };
    const facts = baseFacts({
      limitDate: utc(2026, 1, 20),
      lines: [factLine({ name: "Sujetador", brand: "Aubade", stockQuantity: -1, covered: false })],
    });
    const guidance = buildGuidance(evaluation, facts, baseOrder, ruleTemplateSeed);
    assert.notEqual(guidance.template_text, null);
    assert.match(guidance.template_text!, /Nous vous remercions pour votre commande/);
  });

  test("reference_template identifica la plantilla usada; null cuando se escala", () => {
    const resuelto: RuleEvaluationResult = {
      outcome: "MAIL_1",
      matchedRule: { priority: 1, note: "nota" },
      escalateReason: null,
    };
    const guidanceResuelto = buildGuidance(resuelto, baseFacts(), baseOrder, ruleTemplateSeed);
    assert.equal(guidanceResuelto.reference_template, "MAIL_1");

    const escalado: RuleEvaluationResult = { outcome: "ESCALATE", matchedRule: null, escalateReason: "motivo" };
    const guidanceEscalado = buildGuidance(escalado, baseFacts(), baseOrder, ruleTemplateSeed);
    assert.equal(guidanceEscalado.reference_template, null);
  });
});
