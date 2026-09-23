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
import { ruleDecisionSeed, ruleTemplateSeed, type RuleDecisionSeed } from "../data/order-rules-seed";

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

  test("grupo C con marca desconocida se reparte por el historial, no por el stock", () => {
    const r = evaluateRules(
      baseFacts({
        stateGroup: "C",
        stockStatus: "SIN_STOCK",
        unknownBrands: ["Mariner"],
        affectedBrands: ["Mariner"],
        brandCount: "ONE",
        leadDays: null,
        limitDate: null,
        historyHasInfo: true,
      }),
      ruleDecisionSeed
    );
    assert.equal(r.outcome, "MAIL_6");
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

// ─── evaluateRules — las 13 filas del §4, contra la siembra real ────────

describe("evaluateRules — matriz §4 (13 filas, siembra real)", () => {
  test("fila 1: Grupo A, EN_STOCK, sin retraso → MAIL_1", () => {
    const facts = baseFacts({ stateGroup: "A", stockStatus: "EN_STOCK", delayBucket: "NONE" });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_1");
    assert.equal(result.matchedRule?.priority, 1);
  });

  test("fila 2: Grupo A, EN_STOCK, retraso corto → MAIL_2", () => {
    const facts = baseFacts({ stateGroup: "A", stockStatus: "EN_STOCK", delayBucket: "SHORT", delayDays: 2 });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_2");
    assert.equal(result.matchedRule?.priority, 2);
  });

  test("fila 3: Grupo A, EN_STOCK, retraso largo → MAIL_15", () => {
    const facts = baseFacts({ stateGroup: "A", stockStatus: "EN_STOCK", delayBucket: "LONG", delayDays: 10 });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_15");
    assert.equal(result.matchedRule?.priority, 3);
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
    assert.equal(result.matchedRule?.priority, 4);
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
    assert.equal(result.matchedRule?.priority, 5);
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
    assert.equal(result.matchedRule?.priority, 6);
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
    assert.equal(result.matchedRule?.priority, 7);
  });

  test("fila 8: Grupo B con tracking → MAIL_3", () => {
    const facts = baseFacts({ stateGroup: "B", hasTracking: true });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_3");
    assert.equal(result.matchedRule?.priority, 8);
  });

  test("fila 9: Grupo B sin tracking → ESCALATE", () => {
    const facts = baseFacts({ stateGroup: "B", hasTracking: false });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "ESCALATE");
    assert.equal(result.matchedRule?.priority, 9);
  });

  test("fila 10: Grupo C con historial con información → MAIL_6", () => {
    const facts = baseFacts({ stateGroup: "C", historyHasInfo: true });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_6");
    assert.equal(result.matchedRule?.priority, 10);
  });

  test("fila 11: Grupo C sin información en el historial → MAIL_7", () => {
    const facts = baseFacts({ stateGroup: "C", historyHasInfo: false });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "MAIL_7");
    assert.equal(result.matchedRule?.priority, 11);
  });

  test("fila 12: Grupo D → ESCALATE (intercepta el fail-safe, no la fila 12)", () => {
    const facts = baseFacts({ stateGroup: "D" });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "ESCALATE");
    // No se consultó ninguna fila: la traza no puede venir de la matriz.
    assert.equal(result.matchedRule, null);
  });

  test("fila 13: cajón de sastre — combinación no capturada por ninguna fila anterior → ESCALATE", () => {
    // Grupo C con historyHasInfo = null no matchea ni la fila 10 (exige true)
    // ni la 11 (exige false): cae en el cajón de sastre.
    const facts = baseFacts({ stateGroup: "C", historyHasInfo: null });
    const result = evaluateRules(facts, ruleDecisionSeed);
    assert.equal(result.outcome, "ESCALATE");
    assert.equal(result.matchedRule?.priority, 13);
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
    const filaEsperada = ruleDecisionSeed.find((r) => r.priority === 1)!;
    assert.deepEqual(result.matchedRule, { priority: filaEsperada.priority, note: filaEsperada.note });
  });

  test("prioridades ascendentes: gana la primera fila que matchea, no otra que también matchearía", () => {
    // Filas 8 y 9 solo difieren en hasTracking, así que nunca compiten. Pero
    // una fila 0 ficticia con la misma forma que la fila 1 y outcome distinto
    // debe ganar por tener menor priority.
    const facts = baseFacts({ stateGroup: "A", stockStatus: "EN_STOCK", delayBucket: "NONE" });
    const filaCero: RuleDecisionSeed = {
      priority: 0,
      stateGroup: "A",
      stockStatus: "EN_STOCK",
      brandCount: null,
      delayBucket: "NONE",
      hasTracking: null,
      historyHasInfo: null,
      outcome: "MAIL_2",
      note: "fila de prueba con prioridad más alta",
    };
    const result = evaluateRules(facts, [filaCero, ...ruleDecisionSeed]);
    assert.equal(result.outcome, "MAIL_2");
    assert.equal(result.matchedRule?.priority, 0);
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

  test("MAIL_6 resuelve pending_products, tracking_url y additional_delay cuando todo el contexto llega", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_6",
      matchedRule: { priority: 10, note: "nota" },
      escalateReason: null,
    };
    const order: GuidanceOrderContext = { ...baseOrder, trackingUrl: "https://exemple.test/suivi/ABC" };
    const guidance = buildGuidance(evaluation, baseFacts({ hasTracking: true }), order, ruleTemplateSeed, {
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

  test("MAIL_6 sin contexto extra: pending_products y additional_delay son datos faltantes", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_6",
      matchedRule: { priority: 10, note: "nota" },
      escalateReason: null,
    };
    const order: GuidanceOrderContext = { ...baseOrder, trackingUrl: "https://exemple.test/suivi/ABC" };
    const guidance = buildGuidance(evaluation, baseFacts(), order, ruleTemplateSeed);
    assert.ok(guidance.missing_facts.includes("pending_products"));
    assert.ok(guidance.missing_facts.includes("additional_delay"));
    assert.equal(guidance.must_escalate, true);
  });

  test("MAIL_12 resuelve processed_date en formato francés desde el contexto extra", () => {
    const evaluation: RuleEvaluationResult = {
      outcome: "MAIL_12",
      matchedRule: null,
      escalateReason: null,
    };
    const guidance = buildGuidance(evaluation, baseFacts(), baseOrder, ruleTemplateSeed, {
      processedDate: utc(2026, 5, 1),
    });
    assert.deepEqual(guidance.facts_to_convey, [{ key: "processed_date", value: "01/05/2026" }]);
    assert.equal(guidance.must_escalate, false);
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
