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

// Dirección de entrega por defecto: entrega a domicilio (misma id que `id_address_invoice`,
// alias genérico), para que los tests que no prueban dirección no necesiten pensarla.
const DELIVERY_ADDRESS_ID = 1000;
const DEFAULT_COUNTRY_ID = 8; // FR, igual id verificado contra la API real.

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
  addresses: Record<number, RouteResponse>;
  countries: Record<number, RouteResponse>;
  orderPayments: RouteResponse;
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
      // Por defecto, entrega a domicilio: misma id que `id_address_invoice`.
      id_address_delivery: DELIVERY_ADDRESS_ID,
      id_address_invoice: DELIVERY_ADDRESS_ID,
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
// Alias genérico verificado: entrega a domicilio, nunca punto de recogida.
const DEFAULT_ADDRESS_BODY = JSON.stringify({
  addresses: [
    { id: DELIVERY_ADDRESS_ID, alias: "Mon adresse", company: "", city: "Paris", postcode: "75001", id_country: DEFAULT_COUNTRY_ID },
  ],
});
const DEFAULT_COUNTRY_BODY = JSON.stringify({ countries: [{ id: DEFAULT_COUNTRY_ID, iso_code: "FR" }] });

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
  addresses: { [DELIVERY_ADDRESS_ID]: { body: DEFAULT_ADDRESS_BODY } },
  countries: { [DEFAULT_COUNTRY_ID]: { body: DEFAULT_COUNTRY_BODY } },
  orderPayments: { body: emptyCollection("order_payments") },
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
    addresses: { ...DEFAULTS.addresses, ...(overrides.addresses ?? {}) },
    countries: { ...DEFAULTS.countries, ...(overrides.countries ?? {}) },
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
    if (/\/order_payments\?/.test(url)) return respond(routes.orderPayments, url);

    const addressMatch = url.match(/\/addresses\/(\d+)\?/);
    if (addressMatch) return respond(routes.addresses[Number(addressMatch[1])], url);

    const countryMatch = url.match(/\/countries\/(\d+)\?/);
    if (countryMatch) return respond(routes.countries[Number(countryMatch[1])], url);
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
              id_address_delivery: DELIVERY_ADDRESS_ID,
              id_address_invoice: DELIVERY_ADDRESS_ID,
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
    // Siempre OUTBOUND: es el envío de la tienda al cliente, nunca el de un
    // retorno (el servicio no puede ver order_returns). Ver el fallo real de
    // producción documentado en ConsolidatedShipping.direction.
    assert.equal(result.shipping.direction, "OUTBOUND");

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
              id_address_delivery: DELIVERY_ADDRESS_ID,
              id_address_invoice: DELIVERY_ADDRESS_ID,
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
              id_address_delivery: DELIVERY_ADDRESS_ID,
              id_address_invoice: DELIVERY_ADDRESS_ID,
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
  test("hilo con solo la nota del módulo de pago (private \"1\", como en producción): historyHasInfo false, awaitingShopReply false", async () => {
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
              private: "1",
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

  test("único mensaje público del hilo es un apunte interno (private \"1\"): historyHasInfo false, awaitingShopReply false, lastMessage null", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 993, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-16 10:00:00", date_upd: "2026-09-16 10:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            {
              id: 61,
              id_customer_thread: 993,
              id_employee: 14,
              private: "1",
              message: "je peux plus me la voir cette cliente",
              date_add: "2026-09-16 10:05:00",
            },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.facts.historyHasInfo, false);
    assert.equal(result.conversation.awaitingShopReply, false);
    assert.equal(result.conversation.messages.length, 0);
    assert.equal(result.conversation.lastMessage, null);
    assert.equal(result.conversation.lastMessageDate, null);
  });

  test("último mensaje público es del cliente hace más de 24h: awaitingShopReply true, historyHasInfo null", async () => {
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
              private: "0",
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

  test("id_customer_thread llega como string (forma real de la API): lastMessage se resuelve igual", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 903, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-18 10:00:00", date_upd: "2026-09-18 10:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            { id: 5, id_customer_thread: "903", id_employee: "0", private: "0", message: "Où en est ma commande ?", date_add: "2026-09-18 10:00:00" },
            { id: 6, id_customer_thread: "903", id_employee: "62", private: "0", message: "Bonjour, votre commande part demain.", date_add: "2026-09-18 11:00:00" },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.threadId, 903);
    assert.equal(result.conversation.lastMessage, "Bonjour, votre commande part demain.");
    assert.notEqual(result.conversation.lastMessageDate, null);
  });

  test("el último mensaje público ya fue respondido por un empleado: awaitingShopReply false", async () => {
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
            { id: 3, id_customer_thread: 902, id_employee: null, private: "0", message: "Où en est ma commande ?", date_add: "2026-09-18 10:00:00" },
            { id: 4, id_customer_thread: 902, id_employee: 7, private: "0", message: "Bonjour, votre commande est en préparation.", date_add: "2026-09-18 11:00:00" },
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

// ─── Bloque RETORNO (§3.2): refundIssued y fecha de entrada al grupo R ────
//
// `STATE_GROUPS` (arriba) no mapea 61 a "R" a propósito, para que los tests de "retorno" que ya
// existían (más abajo) prueben el comportamiento SIN esa fila sembrada. Estos tests sí la
// necesitan: usan su propio mapa, igual que hacen los tests de "timeline de estados".

const STATE_GROUPS_WITH_R: Map<number, StateGroup> = new Map([...STATE_GROUPS, [STATE_RETURN, "R"]]);

describe("consolidateOrder — facts.refundIssued y facts.returnEnteredAt", () => {
  test("facts.refundIssued es true cuando hay avoir, false cuando no hay ninguno", async () => {
    stub({
      orderSlip: {
        body: JSON.stringify({
          order_slips: [
            { id: 77, id_order: ORDER_ID, total_products_tax_incl: "20.00", total_shipping_tax_incl: "0.00", date_add: "2026-09-10 12:00:00" },
          ],
        }),
      },
    });
    const conAvoir = await consolidateOrder(buildInput(), STATE_GROUPS);
    assert.equal(conAvoir.facts.refundIssued, true);

    stub({ orderSlip: { body: emptyCollection("order_slips") } });
    const sinAvoir = await consolidateOrder(buildInput(), STATE_GROUPS);
    assert.equal(sinAvoir.facts.refundIssued, false);
  });

  test("facts.returnEnteredAt es la fecha en que el pedido entró más recientemente al grupo R", async () => {
    stub({
      orderHistories: {
        body: JSON.stringify({
          order_histories: [
            // Entró al grupo R dos veces (verificado que ocurre en producción, § hallazgo "State
            // 61 timing" del task doc): se queda con la más reciente, no la primera.
            { id: 1, id_order_state: String(STATE_RETURN), date_add: "2026-09-01 10:00:00" },
            { id: 2, id_order_state: STATE_A, date_add: "2026-09-05 09:00:00" },
            { id: 3, id_order_state: String(STATE_RETURN), date_add: "2026-09-20 08:30:00" },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS_WITH_R);

    assert.equal(result.facts.returnEnteredAt?.toISOString(), new Date("2026-09-20T08:30:00Z").toISOString());
  });

  test("facts.returnEnteredAt es null cuando el pedido nunca entró al grupo R", async () => {
    stub();
    const result = await consolidateOrder(buildInput(), STATE_GROUPS_WITH_R);
    assert.equal(result.facts.returnEnteredAt, null);
  });

  test("extraContext.refund viaja con type/voucherExpiresAt/lineNames cuando hay avoir", async () => {
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

    assert.deepEqual(result.extraContext.refund, {
      type: "VOUCHER",
      voucherExpiresAt: new Date("2026-12-31T00:00:00Z"),
      lineNames: [],
    });
  });

  test("extraContext.refund es null sin ningún avoir", async () => {
    stub({ orderSlip: { body: emptyCollection("order_slips") } });
    const result = await consolidateOrder(buildInput(), STATE_GROUPS);
    assert.equal(result.extraContext.refund, null);
  });
});

// ─── Retorno ──────────────────────────────────────────────────────────────

/**
 * Texto nuevo de `return.reason` (§ fallo real de producción, conversación VJWIRCHVQ): en inglés,
 * dirigido al agente, dice qué puede y qué no puede hacer en vez de explicar el motivo interno en
 * español. Se compara literal porque es exactamente lo que Lia lee para decidir su respuesta.
 */
const RETURN_REASON =
  "Returns in progress are not visible to this service: only a completed return can be detected, " +
  "through the order state. If the customer asks about a return that is under way, say plainly that " +
  "you cannot see its status and answer with guidance.return_inquiry when it is present (it holds the " +
  "approved text on how returns are processed); do not send the customer to customer service by default. " +
  "Never use the shipping tracking number as if it were the return's.";

describe("consolidateOrder — retorno", () => {
  test("estado 61 (Retour Terminé): completed true, dataAvailable siempre false", async () => {
    stub({ orderState: { body: JSON.stringify({ order_states: [{ id: STATE_RETURN, name: "Retour Terminé" }] }) } });

    const result = await consolidateOrder(buildInput({ order: baseOrder({ currentState: STATE_RETURN }) }), STATE_GROUPS);

    assert.equal(result.return.completed, true);
    assert.equal(result.return.dataAvailable, false);
    assert.equal(result.return.reason, RETURN_REASON);
  });

  test("un estado distinto de 61: completed false, dataAvailable sigue en false", async () => {
    stub();

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.return.completed, false);
    assert.equal(result.return.dataAvailable, false);
  });

  test("return.reason es el texto nuevo dirigido al agente, en inglés", async () => {
    stub();

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.return.reason, RETURN_REASON);
  });

  test("extraContext.returnDataAvailable viaja con el mismo valor que return.dataAvailable", async () => {
    stub();

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.extraContext.returnDataAvailable, result.return.dataAvailable);
    assert.equal(result.extraContext.returnDataAvailable, false);
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

// ─── Autoría de mensajes: id_employee dentro del conjunto público ───────

describe("consolidateOrder — autoría de mensajes", () => {
  test("respuesta de la tienda (id_employee > 0, private \"0\"): SHOP, authorCertain true", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 950, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "closed", date_add: "2026-09-11 09:00:00", date_upd: "2026-09-11 09:05:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            {
              id: 12,
              id_customer_thread: 950,
              id_employee: 7,
              private: "0",
              message: "Bonjour, votre commande est en cours de préparation.",
              date_add: "2026-09-11 09:05:00",
            },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.messages[0].author, "SHOP");
    assert.equal(result.conversation.messages[0].authorCertain, true);
  });

  test("mensaje del sitio web (id_employee 0, private \"0\"): CUSTOMER, authorCertain true", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 970, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-15 10:00:00", date_upd: "2026-09-15 10:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            { id: 30, id_customer_thread: 970, id_employee: 0, private: "0", message: "Merci, bonne journée.", date_add: "2026-09-15 10:00:00" },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.messages[0].author, "CUSTOMER");
    assert.equal(result.conversation.messages[0].authorCertain, true);
  });

  test("nota del módulo de pago: SYSTEM, no aparece en los últimos 10 ni afecta awaitingShopReply, aunque llegara private \"0\"", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 960, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-19 10:00:00", date_upd: "2026-09-21 11:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            {
              id: 20,
              id_customer_thread: 960,
              id_employee: 0,
              private: "0",
              message: "Bonjour, je n'ai pas reçu mon colis, merci de vérifier ma commande.",
              date_add: "2026-09-19 10:00:00", // más de 24h antes de TODAY
            },
            {
              id: 21,
              id_customer_thread: 960,
              id_employee: 0,
              // Segunda barrera (`isPaymentModuleNote`): en la muestra real esta nota siempre viene
              // con private = 1, pero aunque llegara pública no debe leerse como conversación real
              // ni "tapar" el mensaje real anterior.
              private: "0",
              message: "Action successfully completed\n3DS: Y\nIPN: OK",
              date_add: "2026-09-21 11:00:00",
            },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.messages.length, 1);
    assert.equal(result.conversation.messages[0].author, "CUSTOMER");
    assert.equal(result.conversation.awaitingShopReply, true);
  });
});

// ─── Privacidad: solo mensajes públicos llegan a Lia ─────────────────────

describe("consolidateOrder — privacidad de mensajes", () => {
  test("apunte interno (id_employee > 0, private \"1\", ej. 'C13FMK 01N - Délai 07/10/26 déjà indiqué'): nunca llega a conversation.messages", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 991, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-15 10:00:00", date_upd: "2026-09-15 10:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            {
              id: 50,
              id_customer_thread: 991,
              id_employee: 14,
              private: "1",
              message: "C13FMK 01N - Délai 07/10/26 déjà indiqué",
              date_add: "2026-09-15 10:05:00",
            },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.messages.length, 0);
    assert.ok(
      !JSON.stringify(result).includes("Délai 07/10/26"),
      "el texto del apunte interno nunca debe viajar en el payload consolidado"
    );
  });

  test("correo de cliente pegado por un empleado (caso real YOGGHZYXI, hilo 185221; private \"1\"): no llega a la conversación", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 185221, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-10 08:00:00", date_upd: "2026-09-10 08:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            {
              id: 10,
              id_customer_thread: 185221,
              // Un empleado (id 28) pegó el correo del cliente dentro del hilo. Antes esto exigía
              // una cascada por contenido para no leerlo como "SHOP"; verificado contra producción,
              // este tipo de mensaje viene con private = 1, así que ya ni siquiera llega a Lia.
              id_employee: 28,
              private: "1",
              message:
                "Bonjour, j'ai passé ma commande il y a 3 semaines et je n'ai pas reçu mon colis. " +
                "Merci de me répondre.\nYamine Priem",
              date_add: "2026-09-10 08:00:00",
            },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.messages.length, 0);
    assert.ok(!JSON.stringify(result).includes("Yamine Priem"), "el correo pegado nunca debe viajar en el payload consolidado");
  });

  test("mensaje sin el campo private (ausente en la respuesta): se descarta, fail closed", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 992, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-16 10:00:00", date_upd: "2026-09-16 10:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            // Sin la clave `private` en absoluto: simula una respuesta inesperada de la API. Un
            // valor ausente o desconocido se trata como privado, nunca como público por defecto.
            { id: 60, id_customer_thread: 992, id_employee: null, message: "Bonjour, une question sur ma commande.", date_add: "2026-09-16 10:05:00" },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.messages.length, 0);
  });

  test("la petición a customer_messages pide 'private' en su whitelist de display", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 994, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-17 10:00:00", date_upd: "2026-09-17 10:00:00" },
          ],
        }),
      },
    });

    let customerMessagesUrl: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (/\/customer_messages\?/.test(url)) customerMessagesUrl = url;
      return originalFetch(input as never);
    }) as typeof fetch;

    await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.ok(customerMessagesUrl, "debe haberse pedido customer_messages (el pedido tiene un hilo)");
    assert.match(customerMessagesUrl!, /display=\[[^\]]*\bprivate\b[^\]]*\]/);
  });
});

// ─── Hilos múltiples y ventana de los últimos 10 mensajes ───────────────

describe("consolidateOrder — hilos múltiples y ventana de mensajes", () => {
  test("mensajes de dos hilos distintos del mismo pedido: fusionados y ordenados por fecha", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 100, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "closed", date_add: "2026-09-01 09:00:00", date_upd: "2026-09-02 09:00:00" },
            { id: 200, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-05 09:00:00", date_upd: "2026-09-05 09:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            { id: 1, id_customer_thread: 100, id_employee: null, private: "0", message: "Bonjour, ma commande n'est pas arrivée.", date_add: "2026-09-01 09:00:00" },
            { id: 2, id_customer_thread: 200, id_employee: null, private: "0", message: "Bonjour, mon colis a un souci.", date_add: "2026-09-05 09:00:00" },
            { id: 3, id_customer_thread: 100, id_employee: 5, private: "0", message: "Voici une mise à jour.\nService client Mesdessous", date_add: "2026-09-02 09:00:00" },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.messages.length, 3);
    assert.deepEqual(
      result.conversation.messages.map((m) => m.threadId),
      [100, 100, 200]
    );
    assert.deepEqual(
      result.conversation.messages.map((m) => m.text),
      [
        "Bonjour, ma commande n'est pas arrivée.",
        "Voici une mise à jour.\nService client Mesdessous",
        "Bonjour, mon colis a un souci.",
      ]
    );
  });

  test("hilo con 15 mensajes reales: se exponen los 10 últimos, en orden cronológico", async () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      id_customer_thread: 500,
      id_employee: i % 2 === 0 ? null : 3,
      private: "0",
      message: `Mensaje numero ${i + 1}`,
      date_add: `2026-09-${String(i + 1).padStart(2, "0")} 10:00:00`,
    }));

    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 500, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-01 10:00:00", date_upd: "2026-09-15 10:00:00" },
          ],
        }),
      },
      customerMessages: { body: JSON.stringify({ customer_messages: messages }) },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.messages.length, 10);
    assert.equal(result.conversation.messages[0].text, "Mensaje numero 6");
    assert.equal(result.conversation.messages[9].text, "Mensaje numero 15");
    for (let i = 1; i < result.conversation.messages.length; i++) {
      assert.ok(result.conversation.messages[i].date.getTime() >= result.conversation.messages[i - 1].date.getTime());
    }
  });
});

// ─── awaitingShopReply con autoría inferida ──────────────────────────────

describe("consolidateOrder — awaitingShopReply con autoría inferida", () => {
  test("último mensaje público es del cliente (id_employee 0) hace más de 24h: awaitingShopReply true", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 980, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-18 10:00:00", date_upd: "2026-09-18 10:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            { id: 40, id_customer_thread: 980, id_employee: 0, private: "0", message: "Bonjour, je n'ai pas reçu ma commande n°980.", date_add: "2026-09-18 10:00:00" },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.awaitingShopReply, true);
  });

  test("último mensaje público es del cliente hace menos de 24h: awaitingShopReply false", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 981, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-21 08:00:00", date_upd: "2026-09-21 08:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            // 4h antes de TODAY (2026-09-21T12:00:00Z).
            { id: 41, id_customer_thread: 981, id_employee: null, private: "0", message: "Bonjour, où en est ma commande ?", date_add: "2026-09-21 08:00:00" },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.awaitingShopReply, false);
  });

  test("un apunte interno privado, más reciente que el último mensaje público: no reabre awaitingShopReply", async () => {
    stub({
      customerThreads: {
        body: JSON.stringify({
          customer_threads: [
            { id: 982, id_order: ORDER_ID, email: CUSTOMER_EMAIL, status: "open", date_add: "2026-09-10 08:00:00", date_upd: "2026-09-20 08:00:00" },
          ],
        }),
      },
      customerMessages: {
        body: JSON.stringify({
          customer_messages: [
            // Público: pregunta del cliente respondida a tiempo por la tienda.
            { id: 42, id_customer_thread: 982, id_employee: 0, private: "0", message: "Bonjour, une question.", date_add: "2026-09-10 08:00:00" },
            { id: 43, id_customer_thread: 982, id_employee: 7, private: "0", message: "Bonjour, voici la réponse.", date_add: "2026-09-10 09:00:00" },
            // Apunte interno privado, mucho más reciente: no debe "reabrir" awaitingShopReply.
            { id: 44, id_customer_thread: 982, id_employee: 14, private: "1", message: "je peux plus me la voir cette cliente", date_add: "2026-09-20 08:00:00" },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.conversation.awaitingShopReply, false);
  });
});

// ─── Timeline de estados ──────────────────────────────────────────────────

describe("consolidateOrder — timeline de estados", () => {
  test("ordenado cronológicamente ascendente, con el grupo correcto; un estado no mapeado cae en D", async () => {
    stub({
      orderHistories: {
        body: JSON.stringify({
          order_histories: [
            // id_order_state como string, el patrón real verificado (T9): prueba que se normaliza
            // con toNumericId antes de resolver el grupo.
            { id: 1, id_order_state: String(STATE_B), date_add: "2026-09-05 10:00:00" },
            { id: 2, id_order_state: STATE_A, date_add: "2026-09-01 09:00:00" },
            { id: 3, id_order_state: 17, date_add: "2026-09-14 12:00:00" }, // no está en STATE_GROUPS
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.order.timeline.length, 3);
    assert.deepEqual(
      result.order.timeline.map((t) => t.stateId),
      [STATE_A, STATE_B, 17]
    );
    assert.deepEqual(
      result.order.timeline.map((t) => t.group),
      ["A", "B", "D"]
    );
    assert.equal(result.order.timeline[0].date.toISOString(), new Date("2026-09-01T09:00:00Z").toISOString());
  });

  test("sin historial, timeline es un array vacío", async () => {
    stub();
    const result = await consolidateOrder(buildInput(), STATE_GROUPS);
    assert.deepEqual(result.order.timeline, []);
  });
});

// ─── Plazo prometido del transportista ────────────────────────────────────

describe("consolidateOrder — carrierDelay", () => {
  test("campo traducible: se resuelve al idioma del cliente", async () => {
    stub({
      orderCarriers: {
        body: JSON.stringify({
          order_carriers: [{ id: 1, id_order: ORDER_ID, id_carrier: 9, tracking_number: "US123456789" }],
        }),
      },
      carriers: {
        9: {
          body: JSON.stringify({
            carriers: [
              {
                id: 9,
                name: "Colissimo International",
                url: "http://www.laposte.fr/suivi/@",
                delay: [
                  { id: "1", value: "2 à 4 jours en France" },
                  { id: "3", value: "5 a 9 días para el resto del mundo" },
                ],
              },
            ],
          }),
        },
      },
    });

    const result = await consolidateOrder(buildInput({ customer: baseCustomer({ idLang: 3 }) }), STATE_GROUPS);

    assert.equal(result.shipping.carrierDelay, "5 a 9 días para el resto del mundo");
  });

  test("sin transportista conocido, carrierDelay es null", async () => {
    stub();
    const result = await consolidateOrder(buildInput(), STATE_GROUPS);
    assert.equal(result.shipping.carrierDelay, null);
  });
});

// ─── Dirección de entrega ────────────────────────────────────────────────

describe("consolidateOrder — dirección de entrega", () => {
  const PICKUP_ADDRESS_ID = 2000;
  const PICKUP_INVOICE_ADDRESS_ID = 2001; // distinta de PICKUP_ADDRESS_ID: candidato a relay.
  const BELGIUM_COUNTRY_ID = 3;

  test("punto de recogida (alias no genérico + entrega distinta de facturación): pickupPointName usa company", async () => {
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
              shipping_number: null,
              id_address_delivery: PICKUP_ADDRESS_ID,
              id_address_invoice: PICKUP_INVOICE_ADDRESS_ID,
            },
          ],
        }),
      },
      addresses: {
        [PICKUP_ADDRESS_ID]: {
          body: JSON.stringify({
            addresses: [
              {
                id: PICKUP_ADDRESS_ID,
                alias: "COLISSIMO POINT PICKUP 24085",
                company: "TOTAL CHANT D'OISEAU",
                city: "WOLUWE SAINT PIERRE",
                postcode: "1150",
                id_country: BELGIUM_COUNTRY_ID,
              },
            ],
          }),
        },
      },
      countries: {
        [BELGIUM_COUNTRY_ID]: { body: JSON.stringify({ countries: [{ id: BELGIUM_COUNTRY_ID, iso_code: "BE" }] }) },
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.order.deliveryAddress.pickupPointName, "TOTAL CHANT D'OISEAU");
    assert.equal(result.order.deliveryAddress.city, "WOLUWE SAINT PIERRE");
    assert.equal(result.order.deliveryAddress.postcode, "1150");
    assert.equal(result.order.deliveryAddress.countryId, BELGIUM_COUNTRY_ID);
    assert.equal(result.order.deliveryAddress.countryIso, "BE");
  });

  test("punto de recogida sin company: pickupPointName cae al alias", async () => {
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
              shipping_number: null,
              id_address_delivery: PICKUP_ADDRESS_ID,
              id_address_invoice: PICKUP_INVOICE_ADDRESS_ID,
            },
          ],
        }),
      },
      addresses: {
        [PICKUP_ADDRESS_ID]: {
          body: JSON.stringify({
            addresses: [
              {
                id: PICKUP_ADDRESS_ID,
                alias: "Point ChronoRelais 130BX",
                company: "",
                city: "LA SEYNE SUR MER",
                postcode: "83500",
                id_country: DEFAULT_COUNTRY_ID,
              },
            ],
          }),
        },
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.order.deliveryAddress.pickupPointName, "Point ChronoRelais 130BX");
  });

  test("entrega a domicilio (alias genérico 'Mon adresse'): pickupPointName null", async () => {
    stub(); // valores por defecto: DELIVERY_ADDRESS_ID, alias "Mon adresse", misma id que invoice.

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.order.deliveryAddress.pickupPointName, null);
    assert.equal(result.order.deliveryAddress.countryIso, "FR");
  });

  test("id_address_delivery distinto de invoice pero alias genérico ('Mi dirección'): sigue siendo domicilio", async () => {
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
              shipping_number: null,
              id_address_delivery: PICKUP_ADDRESS_ID,
              id_address_invoice: PICKUP_INVOICE_ADDRESS_ID,
            },
          ],
        }),
      },
      addresses: {
        [PICKUP_ADDRESS_ID]: {
          body: JSON.stringify({
            addresses: [
              {
                id: PICKUP_ADDRESS_ID,
                alias: "Mi dirección",
                company: "",
                city: "Madrid",
                postcode: "28001",
                id_country: DEFAULT_COUNTRY_ID,
              },
            ],
          }),
        },
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.order.deliveryAddress.pickupPointName, null);
  });

  test("la calle nunca aparece en el payload, ni siquiera si la API la incluyera en la respuesta", async () => {
    const STREET_LEAK = "12 rue de la Fuite Interdite";
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
              shipping_number: null,
              id_address_delivery: PICKUP_ADDRESS_ID,
              id_address_invoice: PICKUP_INVOICE_ADDRESS_ID,
            },
          ],
        }),
      },
      addresses: {
        [PICKUP_ADDRESS_ID]: {
          // La API real nunca debería devolver `address1` porque no se pide en `display`, pero el
          // test simula que lo hiciera igual: el código no debe leerlo ni propagarlo.
          body: JSON.stringify({
            addresses: [
              {
                id: PICKUP_ADDRESS_ID,
                alias: "Point ChronoRelais 130BX",
                company: "Consigne Car Wash Vignelongue",
                city: "LA SEYNE SUR MER",
                postcode: "83500",
                id_country: DEFAULT_COUNTRY_ID,
                address1: STREET_LEAK,
                address2: "",
              },
            ],
          }),
        },
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.deepEqual(Object.keys(result.order.deliveryAddress).sort(), [
      "city",
      "countryId",
      "countryIso",
      "pickupPointName",
      "postcode",
    ]);
    assert.ok(!JSON.stringify(result).includes(STREET_LEAK), "la calle nunca debe viajar en el payload consolidado");
  });
});

// ─── countryIso: caché en memoria por proceso ─────────────────────────────

describe("consolidateOrder — countryIso cacheado", () => {
  test("dos consultas que resuelven el mismo país solo piden countries una vez", async () => {
    const CACHE_ADDRESS_ID = 4000;
    const CACHE_COUNTRY_ID = 77; // id no usado por ningún otro test del fichero.

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
              shipping_number: null,
              id_address_delivery: CACHE_ADDRESS_ID,
              id_address_invoice: CACHE_ADDRESS_ID,
            },
          ],
        }),
      },
      addresses: {
        [CACHE_ADDRESS_ID]: {
          body: JSON.stringify({
            addresses: [
              { id: CACHE_ADDRESS_ID, alias: "Mon adresse", company: "", city: "Lyon", postcode: "69000", id_country: CACHE_COUNTRY_ID },
            ],
          }),
        },
      },
      countries: {
        [CACHE_COUNTRY_ID]: { body: JSON.stringify({ countries: [{ id: CACHE_COUNTRY_ID, iso_code: "ZZ" }] }) },
      },
    });

    let countryFetchCount = 0;
    const stubbedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (/\/countries\/\d+\?/.test(String(input))) countryFetchCount++;
      return stubbedFetch(input as never);
    }) as typeof fetch;

    const first = await consolidateOrder(buildInput(), STATE_GROUPS);
    const second = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(first.order.deliveryAddress.countryIso, "ZZ");
    assert.equal(second.order.deliveryAddress.countryIso, "ZZ");
    assert.equal(countryFetchCount, 1, "countries/{id} debe consultarse una sola vez por proceso para el mismo país");
  });
});

// ─── Reembolso: qué líneas cubrió ─────────────────────────────────────────

describe("consolidateOrder — refund.lines", () => {
  test("cruza id_order_detail (string) con el nombre real de la línea del pedido", async () => {
    stub({
      orderDetails: {
        body: JSON.stringify({
          order_details: [
            { id: 1, product_id: 100, product_attribute_id: 0, product_name: "Soutien-gorge corbeille", product_quantity: "1" },
            { id: 2, product_id: 200, product_attribute_id: 0, product_name: "Culotte assortie", product_quantity: "1" },
          ],
        }),
      },
      orderSlip: {
        body: JSON.stringify({
          order_slips: [
            {
              id: 90,
              id_order: ORDER_ID,
              total_products_tax_incl: "45.00",
              total_shipping_tax_incl: "0.00",
              date_add: "2026-09-10 12:00:00",
              associations: {
                order_slip_details: [
                  { id_order_detail: 1, product_quantity: "1", amount_tax_incl: "30.00" },
                  // `id_order_detail` como string: mismo patrón verificado id_* de toda la API.
                  { id_order_detail: "2", product_quantity: "1", amount_tax_incl: "15.00" },
                ],
              },
            },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.ok(result.refund);
    assert.equal(result.refund?.lines.length, 2);
    assert.deepEqual(
      result.refund?.lines.map((l) => l.name),
      ["Soutien-gorge corbeille", "Culotte assortie"]
    );
    assert.equal(result.refund?.lines[0].quantity, 1);
    assert.equal(result.refund?.lines[0].amount, 30);
    assert.equal(result.refund?.lines[1].amount, 15);
  });

  test("un id_order_detail que no aparece entre las líneas del pedido se incluye con name: null, no se descarta", async () => {
    stub({
      orderSlip: {
        body: JSON.stringify({
          order_slips: [
            {
              id: 91,
              id_order: ORDER_ID,
              total_products_tax_incl: "20.00",
              total_shipping_tax_incl: "0.00",
              date_add: "2026-09-10 12:00:00",
              associations: {
                order_slip_details: [{ id_order_detail: 9999, product_quantity: "1", amount_tax_incl: "20.00" }],
              },
            },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.ok(result.refund);
    assert.equal(result.refund?.lines.length, 1);
    assert.equal(result.refund?.lines[0].name, null);
    assert.equal(result.refund?.lines[0].amount, 20);
  });

  test("un avoir 100% de envío (sin associations en la respuesta) no aporta ninguna línea", async () => {
    stub({
      orderSlip: {
        body: JSON.stringify({
          order_slips: [
            {
              id: 92,
              id_order: ORDER_ID,
              total_products_tax_incl: "0.00",
              total_shipping_tax_incl: "4.90",
              date_add: "2026-09-16 12:00:00",
              // Sin `associations`: verificado contra la API real (pedido 705570, avoir 72384).
            },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.ok(result.refund);
    assert.deepEqual(result.refund?.lines, []);
  });
});

// ─── Pago ──────────────────────────────────────────────────────────────────

describe("consolidateOrder — payment", () => {
  test("pago con tarjeta: cardLast4 son los últimos 4, la cadena enmascarada completa nunca viaja en el payload", async () => {
    stub({
      orderPayments: {
        body: JSON.stringify({
          order_payments: [
            {
              id: 753062,
              amount: "352.920000",
              payment_method: "Paiement CB",
              card_number: "497355XXXXXX8929",
              date_add: "2026-08-27 23:41:40",
            },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.ok(result.payment);
    assert.equal(result.payment?.method, "Paiement CB");
    assert.equal(result.payment?.cardLast4, "8929");
    assert.equal(result.payment?.amount, 352.92);
    assert.equal(result.payment?.date?.toISOString(), new Date("2026-08-27T23:41:40Z").toISOString());

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("497355XXXXXX8929"), "el número enmascarado completo nunca debe viajar en el payload");
    assert.ok(!serialized.includes("XXXXXX"), "ninguna forma enmascarada del número debe aparecer en el payload");
  });

  test("pago sin tarjeta (PayPal, card_number vacío): cardLast4 null", async () => {
    stub({
      orderPayments: {
        body: JSON.stringify({
          order_payments: [
            { id: 1, amount: "50.00", payment_method: "PayPal", card_number: "", date_add: "2026-09-01 10:00:00" },
          ],
        }),
      },
    });

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.ok(result.payment);
    assert.equal(result.payment?.cardLast4, null);
    assert.equal(result.payment?.method, "PayPal");
  });

  test("sin ningún pago registrado, payment es null", async () => {
    stub();

    const result = await consolidateOrder(buildInput(), STATE_GROUPS);

    assert.equal(result.payment, null);
  });
});
