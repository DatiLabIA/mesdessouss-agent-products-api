import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { consolidateOrder, type ConsolidateOrderInput } from "./order-consolidation";
import { PrestashopUnavailableError } from "./prestashop-client";
import type { StateGroup } from "./order-facts";
import type { VerifiedCustomerData, VerifiedOrderData } from "../types";

// Mismo patrón que `order-identity.test.ts`: runner nativo, `fetch` stubeado, la clave se lee de
// forma diferida en la primera petición, así que asignarla acá (después del import estático) no
// revienta la carga del módulo.
process.env.PRESTASHOP_API_KEY = "clave-de-prueba";
process.env.PRESTASHOP_API_URL = "https://ps.test/api/";

const ORDER_ID = 705570;
const CUSTOMER_ID = 27794;
const REFERENCE = "LLKVUZDZD";
const CUSTOMER_EMAIL = "marie54140@hotmail.fr";

const STATE_A = 2; // "Paiement validé" — grupo A (no expedido).
const STATE_B = 4; // "En cours de livraison" — grupo B (expedido).
const STATE_RETURN = 61; // "Retour Terminé" — no está en la siembra de grupos: cae en D por defecto.

const STATE_GROUPS: Map<number, StateGroup> = new Map([
  [STATE_A, "A"],
  [STATE_B, "B"],
]);

// `today` fija, nunca `new Date()`: igual convención que `OrderFactsInput.today`.
const TODAY = new Date(Date.UTC(2026, 8, 21, 12, 0, 0));

function baseOrder(overrides: Partial<VerifiedOrderData> = {}): VerifiedOrderData {
  return {
    id: ORDER_ID,
    reference: REFERENCE,
    dateAdd: "2026-08-27 23:42:20",
    currentState: STATE_A,
    valid: true,
    ...overrides,
  };
}

function baseCustomer(overrides: Partial<VerifiedCustomerData> = {}): VerifiedCustomerData {
  return {
    id: CUSTOMER_ID,
    email: CUSTOMER_EMAIL,
    firstname: "Marie France",
    lastname: "Lorgeas",
    idLang: 1,
    ...overrides,
  };
}

function buildInput(overrides: Partial<ConsolidateOrderInput> = {}): ConsolidateOrderInput {
  return {
    order: baseOrder(),
    customer: baseCustomer(),
    today: TODAY,
    ...overrides,
  };
}

// ─── Stub de `fetch` ────────────────────────────────────────────────────
//
// Un router por recurso en vez de una lista de regex ordenada: cada campo de `Routes` es
// independiente, así que un test solo sobreescribe la pieza que le interesa y todo lo demás
// queda en un valor por defecto razonable ("sin resultados", como devuelve la API real).

interface RouteResponse {
  body?: string;
  status?: number;
  /** Simula el `TimeoutError` que lanza `fetch` cuando `AbortSignal.timeout` aborta. */
  timeout?: boolean;
}

interface Routes {
  orderHeader: RouteResponse;
  orderDetails: RouteResponse;
  orderState: RouteResponse;
  products: RouteResponse;
  stock: RouteResponse;
  orderCarriers: RouteResponse;
  carriers: Record<number, RouteResponse>;
  orderHistories: RouteResponse;
  customerThreads: RouteResponse;
  orderSlip: RouteResponse;
  customerMessages: RouteResponse;
  cartRules: RouteResponse;
}

function emptyCollection(key: string): string {
  return JSON.stringify({ [key]: [] });
}

const DEFAULT_ORDER_HEADER_BODY = JSON.stringify({
  orders: [
    {
      id: ORDER_ID,
      reference: REFERENCE,
      date_add: "2026-08-27 23:42:20",
      total_paid: "49.90",
      total_paid_tax_incl: "49.90",
      total_shipping_tax_incl: "4.90",
      shipping_number: null,
    },
  ],
});

const DEFAULT_ORDER_DETAILS_BODY = JSON.stringify({
  order_details: [
    { id: 1, product_id: 100, product_attribute_id: 0, product_name: "Soutien-gorge corbeille", product_quantity: "1" },
  ],
});

const DEFAULT_ORDER_STATE_BODY = JSON.stringify({ order_states: [{ id: STATE_A, name: "Paiement validé" }] });
const DEFAULT_PRODUCTS_BODY = JSON.stringify({ products: [{ id: 100, manufacturer_name: "Aubade" }] });
const DEFAULT_STOCK_BODY = JSON.stringify({
  stock_availables: [{ id: 1, id_product: 100, id_product_attribute: 0, quantity: "5" }],
});

const DEFAULTS: Routes = {
  orderHeader: { body: DEFAULT_ORDER_HEADER_BODY },
  orderDetails: { body: DEFAULT_ORDER_DETAILS_BODY },
  orderState: { body: DEFAULT_ORDER_STATE_BODY },
  products: { body: DEFAULT_PRODUCTS_BODY },
  stock: { body: DEFAULT_STOCK_BODY },
  orderCarriers: { body: emptyCollection("order_carriers") },
  carriers: {},
  orderHistories: { body: emptyCollection("order_histories") },
  customerThreads: { body: emptyCollection("customer_threads") },
  // Hallazgo verificado (T1): la clave de la respuesta de `order_slip` es `order_slips`, en plural.
  orderSlip: { body: emptyCollection("order_slips") },
  customerMessages: { body: emptyCollection("customer_messages") },
  cartRules: { body: emptyCollection("cart_rules") },
};

const realFetch = globalThis.fetch;

function respond(route: RouteResponse | undefined, url: string): Response {
  if (route?.timeout) {
    const err = new Error("timeout simulado");
    err.name = "TimeoutError";
    throw err;
  }
  if (route === undefined) {
    throw new Error(`El test no tiene stub para la URL solicitada: ${url}`);
  }
  return new Response(route.body ?? "", { status: route.status ?? 200 });
}

function stub(overrides: Partial<Routes> = {}): void {
  const routes: Routes = {
    ...DEFAULTS,
    ...overrides,
    carriers: { ...DEFAULTS.carriers, ...(overrides.carriers ?? {}) },
  };

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);

    if (/\/orders\/\d+\?/.test(url)) return respond(routes.orderHeader, url);
    if (/\/order_details\?/.test(url)) return respond(routes.orderDetails, url);
    if (/\/order_states\/\d+\?/.test(url)) return respond(routes.orderState, url);
    if (/\/products\?/.test(url)) return respond(routes.products, url);
    if (/\/stock_availables\?/.test(url)) return respond(routes.stock, url);
    if (/\/order_carriers\?/.test(url)) return respond(routes.orderCarriers, url);

    const carrierMatch = url.match(/\/carriers\/(\d+)\?/);
    if (carrierMatch) return respond(routes.carriers[Number(carrierMatch[1])], url);

    if (/\/order_histories\?/.test(url)) return respond(routes.orderHistories, url);
    if (/\/customer_threads\?/.test(url)) return respond(routes.customerThreads, url);
    if (/\/order_slip\?/.test(url)) return respond(routes.orderSlip, url);
    if (/\/customer_messages\?/.test(url)) return respond(routes.customerMessages, url);
    if (/\/cart_rules\?/.test(url)) return respond(routes.cartRules, url);

    throw new Error(`El test no tiene stub para la URL solicitada: ${url}`);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── Camino feliz ─────────────────────────────────────────────────────────

describe("consolidateOrder — camino feliz", () => {
  test("línea con marca y stock, tracking en shipping_number, URL resuelta sustituyendo @", async () => {
    stub({
      orderHeader: {
        body: JSON.stringify({
          orders: [
            {
              id: ORDER_ID,
              reference: REFERENCE,
              date_add: "2026-08-27 23:42:20",
              total_paid: "49.90",
              total_paid_tax_incl: "49.90",
              total_shipping_tax_incl: "4.90",
              shipping_number: "8Q004677948",
            },
          ],
        }),
      },
      orderState: { body: JSON.stringify({ order_states: [{ id: STATE_B, name: "En cours de livraison" }] }) },
      orderCarriers: {
        body: JSON.stringify({
          order_carriers: [{ id: 1, id_order: ORDER_ID, id_carrier: 9, tracking_number: null }],
        }),
      },
      carriers: {
        9: { body: JSON.stringify({ carriers: [{ id: 9, name: "Colissimo", url: "http://www.laposte.fr/suivi/@", delay: "2 à 4 jours" }] }) },
      },
    });

    const result = await consolidateOrder(buildInput({ order: baseOrder({ currentState: STATE_B }) }), STATE_GROUPS);

    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].brand, "Aubade");
    assert.equal(result.lines[0].stockQuantity, 5);
    assert.equal(result.lines[0].covered, true);

    assert.equal(result.shipping.trackingNumber, "8Q004677948");
    assert.equal(result.shipping.trackingUrl, "http://www.laposte.fr/suivi/8Q004677948");
    assert.equal(result.shipping.carrierName, "Colissimo");
    assert.equal(result.shipping.shippedWithoutTracking, false);

    assert.equal(result.order.group, "B");
    assert.equal(result.order.status.id, STATE_B);
    assert.equal(result.order.status.name, "En cours de livraison");
    assert.equal(result.order.totals.totalPaid, 49.9);
    assert.equal(result.order.totals.shippingPaid, 4.9);
    assert.equal(result.order.currency, "EUR");

    // Nunca campos sensibles del cliente.
    assert.deepEqual(Object.keys(result.customer).sort(), ["email", "firstname", "idLang", "lastname"]);

    // `facts` queda listo para `computeOrderFacts` sin transformación adicional.
    assert.equal(result.facts.stateId, STATE_B);
    assert.equal(result.facts.trackingNumber, "8Q004677948");
    assert.equal(result.facts.lines.length, 1);
    assert.equal(result.orderContext.reference, REFERENCE);
    assert.equal(result.orderContext.trackingUrl, "http://www.laposte.fr/suivi/8Q004677948");
  });
});

// ─── Stock: combinación sin fila ────────────────────────────────────────

describe("consolidateOrder — stock", () => {
  test("una combinación sin fila en stock_availables da stockQuantity null, no cero", async () => {
    stub({ stock: { body: emptyCollection("stock_availables") } });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.lines[0].stockQuantity, null);
    assert.equal(result.lines[0].covered, false);
    assert.equal(result.facts.lines[0].stockQuantity, null);
  });
});

// ─── Tracking: las dos fuentes, en los dos órdenes ──────────────────────

describe("consolidateOrder — tracking en dos fuentes", () => {
  test("tracking solo en order_carriers (nada en orders.shipping_number)", async () => {
    stub({
      orderCarriers: {
        body: JSON.stringify({
          order_carriers: [{ id: 1, id_order: ORDER_ID, id_carrier: 5, tracking_number: "AB123FR" }],
        }),
      },
      carriers: {
        5: { body: JSON.stringify({ carriers: [{ id: 5, name: "Chronopost", url: "http://chronopost.fr/@", delay: "24h" }] }) },
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.shipping.trackingNumber, "AB123FR");
    assert.equal(result.shipping.trackingUrl, "http://chronopost.fr/AB123FR");
    assert.equal(result.shipping.carrierName, "Chronopost");
  });

  test("tracking en orders.shipping_number tiene prioridad sobre order_carriers", async () => {
    stub({
      orderHeader: {
        body: JSON.stringify({
          orders: [
            {
              id: ORDER_ID,
              reference: REFERENCE,
              date_add: "2026-08-27 23:42:20",
              total_paid: "49.90",
              total_paid_tax_incl: "49.90",
              total_shipping_tax_incl: "4.90",
              shipping_number: "PRIORITARIO1",
            },
          ],
        }),
      },
      orderCarriers: {
        body: JSON.stringify({
          order_carriers: [{ id: 1, id_order: ORDER_ID, id_carrier: 5, tracking_number: "SECUNDARIO2" }],
        }),
      },
      carriers: {
        5: { body: JSON.stringify({ carriers: [{ id: 5, name: "Chronopost", url: "http://chronopost.fr/@", delay: "24h" }] }) },
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.shipping.trackingNumber, "PRIORITARIO1");
    // El transportista mostrado es el único disponible en `order_carriers`, aunque el número haya
    // salido de `orders.shipping_number`.
    assert.equal(result.shipping.carrierName, "Chronopost");
    assert.equal(result.shipping.trackingUrl, "http://chronopost.fr/PRIORITARIO1");
  });

  test("tracking vacío o con espacios cuenta como ausente, y dispara shippedWithoutTracking si el estado implica expedido", async () => {
    stub({
      orderHeader: {
        body: JSON.stringify({
          orders: [
            {
              id: ORDER_ID,
              reference: REFERENCE,
              date_add: "2026-08-27 23:42:20",
              total_paid: "49.90",
              total_paid_tax_incl: "49.90",
              total_shipping_tax_incl: "4.90",
              shipping_number: "   ",
            },
          ],
        }),
      },
      orderState: { body: JSON.stringify({ order_states: [{ id: STATE_B, name: "En cours de livraison" }] }) },
      orderCarriers: {
        body: JSON.stringify({
          order_carriers: [{ id: 1, id_order: ORDER_ID, id_carrier: 5, tracking_number: "  " }],
        }),
      },
      carriers: {
        5: { body: JSON.stringify({ carriers: [{ id: 5, name: "Chronopost", url: "http://chronopost.fr/@", delay: "24h" }] }) },
      },
    });

    const result = await consolidateOrder(buildInput({ order: baseOrder({ currentState: STATE_B }) }), STATE_GROUPS);

    assert.equal(result.shipping.trackingNumber, null);
    assert.equal(result.shipping.trackingUrl, null);
    assert.equal(result.shipping.shippedWithoutTracking, true);
  });

  test("sin tracking en un pedido no expedido (grupo A), no dispara shippedWithoutTracking", async () => {
    stub();

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.shipping.trackingNumber, null);
    assert.equal(result.shipping.shippedWithoutTracking, false);
  });
});

// ─── Conversación: historyHasInfo y awaitingShopReply ───────────────────

describe("consolidateOrder — conversación", () => {
  test("hilo con solo la nota del módulo de pago: historyHasInfo false, awaitingShopReply false", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 900, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "closed", date_add: "2026-08-27 23:45:00", date_upd: "2026-08-27 23:45:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            {
              id: 1,
              id_customer_thread: 900,
              id_employee: null,
              message: "Action successfully completed\n3DS: Y\nIPN: OK",
              date_add: "2026-08-27 23:45:05",
            },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.facts.historyHasInfo, false);
    assert.equal(result.conversation.threadId, 900);
    assert.equal(result.conversation.awaitingShopReply, false);
  });

  test("último mensaje real es del cliente hace más de 24h: awaitingShopReply true, historyHasInfo null", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 901, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-18 10:00:00", date_upd: "2026-09-18 10:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            {
              id: 2,
              id_customer_thread: 901,
              id_employee: null,
              message: "Bonjour, où en est ma commande ?",
              date_add: "2026-09-18 10:00:00", // más de 24h antes de TODAY (2026-09-21T12:00:00Z)
            },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.facts.historyHasInfo, null);
    assert.equal(result.conversation.awaitingShopReply, true);
    assert.equal(result.conversation.lastMessage, "Bonjour, où en est ma commande ?");
  });

  test("el último mensaje real ya fue respondido por un empleado: awaitingShopReply false", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 902, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-18 10:00:00", date_upd: "2026-09-19 09:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            { id: 3, id_customer_thread: 902, id_employee: null, message: "Où en est ma commande ?", date_add: "2026-09-18 10:00:00" },
            { id: 4, id_customer_thread: 902, id_employee: 7, message: "Bonjour, votre commande est en préparation.", date_add: "2026-09-18 11:00:00" },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.awaitingShopReply, false);
  });
});

// ─── Reembolso: vale o dinero ────────────────────────────────────────────

describe("consolidateOrder — reembolso", () => {
  test("avoir con cart_rules coincidente: detectado como vale, con caducidad", async () => {
    const ruleId = 55;
    stub({
      orderSlip: {
        body: JSON.stringify({
          order_slips: [
            { id: 77, id_order: ORDER_ID, total_products_tax_incl: "20.00", total_shipping_tax_incl: "0.00", date_add: "2026-09-10 12:00:00" },
          ],
        }),
      },
      cartRules: {
        body: JSON.stringify({
          cart_rules: [
            { id: ruleId, code: `V${ruleId}C${CUSTOMER_ID}O${ORDER_ID}`, date_to: "2026-12-31 00:00:00", active: "1" },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.ok(result.refund);
    assert.equal(result.refund?.amount, 20);
    assert.equal(result.refund?.type, "VOUCHER");
    assert.equal(result.refund?.voucherExpiresAt?.toISOString(), new Date("2026-12-31T00:00:00Z").toISOString());
    assert.equal(result.extraContext.processedDate?.toISOString(), new Date("2026-09-10T12:00:00Z").toISOString());
  });

  test("avoir sin cart_rules coincidente: dinero", async () => {
    stub({
      orderSlip: {
        body: JSON.stringify({
          order_slips: [
            { id: 78, id_order: ORDER_ID, total_products_tax_incl: "15.00", total_shipping_tax_incl: "4.90", date_add: "2026-09-11 09:00:00" },
          ],
        }),
      },
      cartRules: { body: emptyCollection("cart_rules") },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.ok(result.refund);
    assert.equal(result.refund?.type, "MONEY");
    assert.equal(result.refund?.voucherExpiresAt, null);
    assert.equal(result.refund?.amount, 19.9);
  });

  test("sin avoir, refund es null y no se consulta cart_rules", async () => {
    let cartRulesCalled = false;
    stub({
      orderSlip: { body: emptyCollection("order_slips") },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (/\/cart_rules\?/.test(String(input))) cartRulesCalled = true;
      return originalFetch(input as never);
    }) as typeof fetch;

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.refund, null);
    assert.equal(cartRulesCalled, false, "sin avoir no hace falta consultar cart_rules");
  });
});

// ─── Retorno ──────────────────────────────────────────────────────────────

describe("consolidateOrder — retorno", () => {
  test("estado 61 (Retour Terminé): completed true, dataAvailable siempre false", async () => {
    stub({ orderState: { body: JSON.stringify({ order_states: [{ id: STATE_RETURN, name: "Retour Terminé" }] }) } });

    const result = await consolidateOrder(buildInput({ order: baseOrder({ currentState: STATE_RETURN }) }), STATE_GROUPS);

    assert.equal(result.return.completed, true);
    assert.equal(result.return.dataAvailable, false);
    assert.ok(result.return.reason.length > 0);
  });

  test("un estado distinto de 61: completed false, dataAvailable sigue en false", async () => {
    stub();

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.return.completed, false);
    assert.equal(result.return.dataAvailable, false);
  });
});

// ─── Fallos transitorios ────────────────────────────────────────────────

describe("consolidateOrder — fallos transitorios", () => {
  test("un fallo transitorio en una de las olas se propaga como tal, nunca como 'sin datos'", async () => {
    stub({ products: { body: "", status: 503 } });

    await assert.rejects(
      () => consolidateOrder(buildInput(), STATE_GROUPS),
      (err: unknown) => err instanceof PrestashopUnavailableError
    );
  });

  test("un timeout en una de las olas también se propaga, no se resuelve con datos vacíos", async () => {
    stub({ orderCarriers: { timeout: true } });

    await assert.rejects(
      () => consolidateOrder(buildInput(), STATE_GROUPS),
      (err: unknown) => err instanceof PrestashopUnavailableError
    );
  });

  test("un 404 puntual en carriers/{id} degrada a transportista desconocido, no tumba la consolidación", async () => {
    stub({
      orderCarriers: {
        body: JSON.stringify({
          order_carriers: [{ id: 1, id_order: ORDER_ID, id_carrier: 999, tracking_number: "XYZ" }],
        }),
      },
      carriers: { 999: { status: 404 } },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.shipping.trackingNumber, "XYZ");
    assert.equal(result.shipping.carrierName, null);
    assert.equal(result.shipping.trackingUrl, null);
  });
});
