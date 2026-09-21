import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeOrderFacts, type OrderFactsConfig, type OrderFactsLineInput } from "./order-facts";
import { normalizeBrandKey } from "./brand-normalize";

function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

const STATE_GROUP_A = 2; // "Commande en cours de traitement", por ejemplo.
const STATE_UNKNOWN = 9999; // No está en `stateGroups`.

const baseConfig: OrderFactsConfig = {
  stateGroups: new Map([[STATE_GROUP_A, "A"]]),
  brandLeadDays: new Map([
    [normalizeBrandKey("Aubade"), 5],
    [normalizeBrandKey("Chantelle"), 5],
    [normalizeBrandKey("Sloggi"), 9],
  ]),
  holidays: new Set<string>(),
  inStockLeadDays: 2,
  shortDelayMaxDays: 3,
};

function line(overrides: Partial<OrderFactsLineInput>): OrderFactsLineInput {
  return {
    name: "Producto",
    brand: null,
    quantity: 1,
    stockQuantity: null,
    ...overrides,
  };
}

const ORDER_DATE = utc(2026, 1, 5); // lunes

describe("computeOrderFacts — grupo de estado", () => {
  test("un stateId que no está en el mapa cae en el grupo D", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_UNKNOWN,
        trackingNumber: null,
        lines: [line({ brand: "Aubade", stockQuantity: 3 })],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.equal(facts.stateGroup, "D");
  });

  test("un stateId mapeado resuelve al grupo correspondiente", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [line({ brand: "Aubade", stockQuantity: 3 })],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.equal(facts.stateGroup, "A");
  });
});

describe("computeOrderFacts — stock por línea", () => {
  test("stockQuantity = 0 cuenta como cubierta (el pedido ya descontó el stock)", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [line({ brand: "Aubade", stockQuantity: 0 })],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.equal(facts.lines[0].covered, true);
    assert.equal(facts.stockStatus, "EN_STOCK");
  });

  test("stockQuantity negativo es una rotura confirmada: no cubierta", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [line({ brand: "Aubade", stockQuantity: -1 })],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.equal(facts.lines[0].covered, false);
    assert.equal(facts.stockStatus, "SIN_STOCK");
  });

  test("stockQuantity = null es indeterminable: tampoco cubierta", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [line({ brand: "Aubade", stockQuantity: null })],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.equal(facts.lines[0].covered, false);
    assert.equal(facts.stockStatus, "SIN_STOCK");
  });

  test("todas las líneas cubiertas → EN_STOCK", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [line({ brand: "Aubade", stockQuantity: 3 }), line({ brand: "Sloggi", stockQuantity: 0 })],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.equal(facts.stockStatus, "EN_STOCK");
  });
});

describe("computeOrderFacts — marcas afectadas (§2.3)", () => {
  test("ejemplo literal del documento: Adidas con stock + Aubade sin stock → solo Aubade, monomarca", () => {
    const config: OrderFactsConfig = {
      ...baseConfig,
      brandLeadDays: new Map([...baseConfig.brandLeadDays, [normalizeBrandKey("Adidas"), 9]]),
    };
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [
          line({ name: "Sujetador Adidas", brand: "Adidas", stockQuantity: 5 }),
          line({ name: "Sujetador Aubade", brand: "Aubade", stockQuantity: null }),
        ],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      config
    );
    assert.deepEqual(facts.affectedBrands, ["Aubade"]);
    assert.equal(facts.brandCount, "ONE");
  });

  test("dos marcas distintas sin stock → multimarca", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [
          line({ brand: "Aubade", stockQuantity: null }),
          line({ brand: "Sloggi", stockQuantity: -1 }),
        ],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.equal(facts.affectedBrands.length, 2);
    assert.equal(facts.brandCount, "MANY");
  });

  test("una línea sin stock y sin marca informada no aporta un nombre, pero queda visible en el detalle", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [line({ name: "Producto sin marca", brand: null, stockQuantity: null })],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.deepEqual(facts.affectedBrands, []);
    assert.equal(facts.brandCount, null);
    assert.equal(facts.lines[0].covered, false);
    assert.equal(facts.lines[0].brand, null);
  });
});

describe("computeOrderFacts — plazo y marca desconocida", () => {
  test("SIN_STOCK con dos marcas afectadas usa el máximo de sus plazos", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [
          line({ brand: "Aubade", stockQuantity: null }), // 5 días
          line({ brand: "Sloggi", stockQuantity: null }), // 9 días
        ],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.equal(facts.leadDays, 9);
  });

  test("una marca afectada sin plazo en el mapa aparece en unknownBrands y el plazo queda indeterminado", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [line({ brand: "Marca Fantasma", stockQuantity: null })],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.deepEqual(facts.unknownBrands, ["Marca Fantasma"]);
    assert.equal(facts.leadDays, null);
    assert.equal(facts.limitDate, null);
  });

  test("EN_STOCK usa siempre inStockLeadDays, sin mirar la tabla de marcas", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [line({ brand: "Aubade", stockQuantity: 3 })],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.equal(facts.leadDays, baseConfig.inStockLeadDays);
  });
});

describe("computeOrderFacts — retraso", () => {
  const zeroLeadConfig: OrderFactsConfig = { ...baseConfig, inStockLeadDays: 0 };

  function factsAtToday(today: Date) {
    return computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [line({ brand: "Aubade", stockQuantity: 3 })],
        historyHasInfo: null,
        today,
      },
      zeroLeadConfig
    );
  }

  test("sin retraso (hoy = fecha límite) → NONE", () => {
    const facts = factsAtToday(ORDER_DATE);
    assert.equal(facts.delayDays, 0);
    assert.equal(facts.delayBucket, "NONE");
  });

  test("retraso corto, dentro de la ventana de shortDelayMaxDays → SHORT", () => {
    // Límite = lunes 2026-01-05. Un día hábil después: martes 2026-01-06.
    const facts = factsAtToday(utc(2026, 1, 6));
    assert.equal(facts.delayDays, 1);
    assert.equal(facts.delayBucket, "SHORT");
  });

  test("retraso largo, por encima de shortDelayMaxDays → LONG", () => {
    // Límite = lunes 2026-01-05. Cinco días hábiles después: lunes 2026-01-12.
    const facts = factsAtToday(utc(2026, 1, 12));
    assert.equal(facts.delayDays, 5);
    assert.equal(facts.delayBucket, "LONG");
  });
});

describe("computeOrderFacts — tracking e historial", () => {
  test("un tracking vacío o solo espacios se trata como ausente", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: "   ",
        lines: [line({ brand: "Aubade", stockQuantity: 3 })],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.equal(facts.hasTracking, false);
  });

  test("un tracking con contenido real cuenta como presente", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: "1Z999AA10123456784",
        lines: [line({ brand: "Aubade", stockQuantity: 3 })],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.equal(facts.hasTracking, true);
  });

  test("historyHasInfo viaja tal cual, incluido null", () => {
    const facts = computeOrderFacts(
      {
        orderDate: ORDER_DATE,
        stateId: STATE_GROUP_A,
        trackingNumber: null,
        lines: [line({ brand: "Aubade", stockQuantity: 3 })],
        historyHasInfo: null,
        today: ORDER_DATE,
      },
      baseConfig
    );
    assert.equal(facts.historyHasInfo, null);
  });
});
