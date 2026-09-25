import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createOrderLookupHandler,
  ORDER_LOOKUP_RATE_LIMIT_MAX_FAILURES,
  type OrderLookupDeps,
} from "./order-lookup";
import { RuleSetNotFoundError } from "../lib/rule-set-validation";
import type { LoadedRuleSet } from "../lib/rule-set-validation";

/**
 * Tests del handler HTTP de `POST /order_lookup` (T11). Mismo patrón de
 * `fetch` stubeado que `order-identity.test.ts`/`order-consolidation.test.ts`:
 * runner nativo, sin levantar Express (objetos `req`/`res` falsos).
 *
 * `loadActiveRuleSet` y `logQuery` (los dos únicos puntos de `order-lookup.ts`
 * que tocan Prisma) se inyectan como dobles de prueba vía
 * `createOrderLookupHandler`: así ningún test de este fichero toca la base de
 * datos, ni siquiera para fallar rápido — cumple la restricción de la tarea
 * de no ejecutar nada contra la base.
 */
process.env.PRESTASHOP_API_KEY = "clave-de-prueba";
process.env.PRESTASHOP_API_URL = "https://ps.test/api/";

// ─── Datos base ─────────────────────────────────────────────────────────────

const ORDER_ID = 705570;
const CUSTOMER_ID = 27794;
const REFERENCE = "LLKVUZDZD";
const ACCOUNT_EMAIL = "marie54140@hotmail.fr";
const STATE_A = 2; // "Paiement validé" — grupo A en la siembra fake de este fichero.

const ORDERS_BODY = JSON.stringify({
  orders: [
    {
      id: ORDER_ID,
      reference: REFERENCE,
      id_customer: CUSTOMER_ID,
      date_add: "2026-08-27 23:42:20",
      current_state: STATE_A,
      valid: "1",
    },
  ],
});

const CUSTOMER_BODY = JSON.stringify({
  customers: [{ id: CUSTOMER_ID, email: ACCOUNT_EMAIL, firstname: "Marie France", lastname: "Lorgeas", id_lang: 1 }],
});

const EMPTY_THREADS_BODY = JSON.stringify({ customer_threads: [] });

const DELIVERY_ADDRESS_ID = 1000;
const DEFAULT_COUNTRY_ID = 8; // FR, igual id verificado contra la API real.

const ORDER_HEADER_BODY = JSON.stringify({
  orders: [
    {
      id: ORDER_ID,
      reference: REFERENCE,
      date_add: "2026-08-27 23:42:20",
      total_paid: "49.90",
      total_paid_tax_incl: "49.90",
      total_shipping_tax_incl: "4.90",
      shipping_number: null,
      id_address_delivery: DELIVERY_ADDRESS_ID,
      id_address_invoice: DELIVERY_ADDRESS_ID,
    },
  ],
});

const ORDER_DETAILS_BODY = JSON.stringify({
  order_details: [
    { id: 1, product_id: 100, product_attribute_id: 0, product_name: "Soutien-gorge corbeille", product_quantity: "1" },
  ],
});

const ORDER_STATE_BODY = JSON.stringify({ order_states: [{ id: STATE_A, name: "Paiement validé" }] });
const PRODUCTS_BODY = JSON.stringify({ products: [{ id: 100, manufacturer_name: "Aubade" }] });
const STOCK_BODY = JSON.stringify({
  stock_availables: [{ id: 1, id_product: 100, id_product_attribute: 0, quantity: "5" }],
});
const ADDRESS_BODY = JSON.stringify({
  addresses: [
    { id: DELIVERY_ADDRESS_ID, alias: "Mon adresse", company: "", city: "Paris", postcode: "75001", id_country: DEFAULT_COUNTRY_ID },
  ],
});
const COUNTRY_BODY = JSON.stringify({ countries: [{ id: DEFAULT_COUNTRY_ID, iso_code: "FR" }] });

function emptyCollection(key: string): string {
  return JSON.stringify({ [key]: [] });
}

// ─── Stub de `fetch` ────────────────────────────────────────────────────────

interface StubRoute {
  when: RegExp;
  body?: string;
  status?: number;
}

const realFetch = globalThis.fetch;

/** Router por resource, cubre tanto la identidad como la consolidación. */
function stubFetch(routes: StubRoute[]): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const route = routes.find((r) => r.when.test(url));
    if (route === undefined) {
      throw new Error(`El test no tiene stub para la URL solicitada: ${url}`);
    }
    return new Response(route.body ?? "", { status: route.status ?? 200 });
  }) as typeof fetch;
}

/** Identidad válida + consolidación mínima: una línea con marca y stock, sin tracking, sin avoir. */
function stubHappyPath(): void {
  stubFetch([
    { when: /\/orders\?/, body: ORDERS_BODY },
    { when: /\/orders\/\d+\?/, body: ORDER_HEADER_BODY },
    { when: /\/order_details\?/, body: ORDER_DETAILS_BODY },
    { when: /\/order_states\/\d+\?/, body: ORDER_STATE_BODY },
    { when: /\/products\?/, body: PRODUCTS_BODY },
    { when: /\/stock_availables\?/, body: STOCK_BODY },
    { when: /\/order_carriers\?/, body: emptyCollection("order_carriers") },
    { when: /\/order_histories\?/, body: emptyCollection("order_histories") },
    { when: /\/customers\//, body: CUSTOMER_BODY },
    { when: /\/customer_threads\?/, body: EMPTY_THREADS_BODY },
    { when: /\/order_slip\?/, body: emptyCollection("order_slips") },
    { when: /\/customer_messages\?/, body: emptyCollection("customer_messages") },
    { when: /\/cart_rules\?/, body: emptyCollection("cart_rules") },
    { when: /\/addresses\/\d+\?/, body: ADDRESS_BODY },
    { when: /\/countries\/\d+\?/, body: COUNTRY_BODY },
    { when: /\/order_payments\?/, body: emptyCollection("order_payments") },
  ]);
}

/** Solo identidad: para tests que nunca deberían llegar a consolidar (negativo, sin reglas, etc.). */
function stubIdentityOnly(): void {
  stubFetch([
    { when: /\/orders\?/, body: ORDERS_BODY },
    { when: /\/customers\//, body: CUSTOMER_BODY },
    { when: /\/customer_threads\?/, body: EMPTY_THREADS_BODY },
  ]);
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── Conjunto de reglas fake (inyectado, nunca toca Prisma) ────────────────

function fakeRuleSet(): LoadedRuleSet {
  return {
    version: 1,
    stateGroups: new Map([[STATE_A, "A"]]),
    brandLeadDays: new Map([["aubade", 5]]),
    holidays: new Set(),
    decisions: [
      {
        priority: 1,
        stateGroup: "A",
        stockStatus: "EN_STOCK",
        brandCount: null,
        delayBucket: null,
        hasTracking: null,
        historyHasInfo: null,
        refundIssued: null,
        outcome: "MAIL_1",
        note: "Confirmación estándar de pedido en stock.",
      },
      {
        priority: 99,
        stateGroup: null,
        stockStatus: null,
        brandCount: null,
        delayBucket: null,
        hasTracking: null,
        historyHasInfo: null,
        refundIssued: null,
        outcome: "ESCALATE",
        note: "Cajón de sastre: ninguna otra fila matcheó.",
      },
    ],
    templates: [
      {
        outcome: "MAIL_1",
        lang: "fr",
        body: "Merci pour votre commande, elle est en cours de préparation.",
        factsToConvey: ["order_reference"],
        mustNotClaim: ["no afirmar que el pedido ya fue expedido"],
      },
    ],
    settings: { inStockLeadDays: 2, shortDelayMaxDays: 3, returnRefundMaxBusinessDays: 7 },
  };
}

// ─── Dobles de prueba (deps) ────────────────────────────────────────────────

function fakeDeps(overrides: Partial<OrderLookupDeps> = {}): OrderLookupDeps {
  return {
    loadActiveRuleSet: async () => fakeRuleSet(),
    logQuery: () => {},
    ...overrides,
  };
}

// ─── req/res falsos ─────────────────────────────────────────────────────────

interface FakeResponse {
  statusCode: number;
  body: unknown;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
}

function fakeRes(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

interface FakeRequestInit {
  body?: unknown;
  ip?: string;
}

function fakeReq(init: FakeRequestInit = {}) {
  return {
    body: init.body,
    ip: init.ip ?? "127.0.0.1",
    socket: { remoteAddress: init.ip ?? "127.0.0.1" },
  };
}

// Cada test usa su propia IP: el limitador de intentos es un `Map` en memoria
// compartido por todo el proceso de test, y los tests corren en el mismo
// fichero/proceso — sin IPs distintas, un test contaminaría el contador de otro.
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.0.0.${ipCounter}`;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /order_lookup — validación de entrada", () => {
  test("falta 'reference' → 400", async () => {
    const handler = createOrderLookupHandler(fakeDeps());
    const res = fakeRes();
    await handler(fakeReq({ body: { email: ACCOUNT_EMAIL }, ip: uniqueIp() }) as never, res as never);
    assert.equal(res.statusCode, 400);
    assert.ok((res.body as { error?: string }).error);
  });

  test("falta 'email' → 400", async () => {
    const handler = createOrderLookupHandler(fakeDeps());
    const res = fakeRes();
    await handler(fakeReq({ body: { reference: REFERENCE }, ip: uniqueIp() }) as never, res as never);
    assert.equal(res.statusCode, 400);
    assert.ok((res.body as { error?: string }).error);
  });

  test("cuerpo vacío → 400", async () => {
    const handler = createOrderLookupHandler(fakeDeps());
    const res = fakeRes();
    await handler(fakeReq({ body: {}, ip: uniqueIp() }) as never, res as never);
    assert.equal(res.statusCode, 400);
  });
});

describe("POST /order_lookup — negativo uniforme de identidad", () => {
  test("email ajeno → 200 con exactamente las tres claves del negativo uniforme", async () => {
    stubIdentityOnly();
    const handler = createOrderLookupHandler(fakeDeps());
    const res = fakeRes();
    await handler(
      fakeReq({ body: { reference: REFERENCE, email: "intruso@example.com" }, ip: uniqueIp() }) as never,
      res as never
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.body as object).sort(), ["found", "identity_verified", "outcome"]);
    assert.deepEqual(res.body, { found: false, identity_verified: false, outcome: "IDENTITY_NOT_VERIFIED" });
  });

  test("referencia inexistente → respuesta idéntica, byte a byte, a la del email ajeno", async () => {
    stubFetch([{ when: /\/orders\?/, body: JSON.stringify({ orders: [] }) }]);
    const handlerInexistente = createOrderLookupHandler(fakeDeps());
    const resInexistente = fakeRes();
    await handlerInexistente(
      fakeReq({ body: { reference: "ZZZZZZZZZ", email: ACCOUNT_EMAIL }, ip: uniqueIp() }) as never,
      resInexistente as never
    );

    stubIdentityOnly();
    const handlerAjeno = createOrderLookupHandler(fakeDeps());
    const resAjeno = fakeRes();
    await handlerAjeno(
      fakeReq({ body: { reference: REFERENCE, email: "otro-intruso@example.com" }, ip: uniqueIp() }) as never,
      resAjeno as never
    );

    assert.equal(resInexistente.statusCode, resAjeno.statusCode);
    assert.deepEqual(resInexistente.body, resAjeno.body);
    assert.deepEqual(JSON.stringify(resInexistente.body), JSON.stringify(resAjeno.body));
  });

  test("más de un pedido con la misma referencia → 200, escalado con motivo, no el negativo uniforme", async () => {
    const dos = JSON.stringify({
      orders: [
        { id: 1, reference: REFERENCE, id_customer: 10, date_add: "", current_state: 2, valid: "1" },
        { id: 2, reference: REFERENCE, id_customer: 20, date_add: "", current_state: 2, valid: "1" },
      ],
    });
    stubFetch([{ when: /\/orders\?/, body: dos }]);
    const handler = createOrderLookupHandler(fakeDeps());
    const res = fakeRes();
    await handler(
      fakeReq({ body: { reference: REFERENCE, email: ACCOUNT_EMAIL }, ip: uniqueIp() }) as never,
      res as never
    );
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal(body.found, false);
    assert.equal(body.identity_verified, false);
    assert.equal(body.outcome, "AMBIGUOUS_REFERENCE");
    assert.equal(body.must_escalate, true);
    assert.ok(typeof body.escalate_reason === "string" && body.escalate_reason.length > 0);
  });
});

describe("POST /order_lookup — fallos de servicio", () => {
  test("fallo transitorio de PrestaShop → 503, nunca el cuerpo del negativo de identidad", async () => {
    // Un 200 con cuerpo vacío repetido agota los reintentos de `verifyOrderIdentity`
    // y se resuelve a SERVICE_UNAVAILABLE (ver order-identity.test.ts).
    stubFetch([{ when: /\/orders\?/, body: "" }]);
    const handler = createOrderLookupHandler(fakeDeps());
    const res = fakeRes();
    await handler(
      fakeReq({ body: { reference: REFERENCE, email: ACCOUNT_EMAIL }, ip: uniqueIp() }) as never,
      res as never
    );
    assert.equal(res.statusCode, 503);
    assert.notDeepEqual(res.body, { found: false, identity_verified: false, outcome: "IDENTITY_NOT_VERIFIED" });
    assert.ok((res.body as { error?: string }).error);
  });

  test("PrestaShop cae durante la consolidación (identidad ya verificada) → 503, no 500", async () => {
    stubFetch([
      { when: /\/orders\?/, body: ORDERS_BODY },
      { when: /\/customers\//, body: CUSTOMER_BODY },
      { when: /\/customer_threads\?/, body: EMPTY_THREADS_BODY },
      { when: /\/orders\/\d+\?/, status: 503 },
      { when: /\/order_details\?/, body: ORDER_DETAILS_BODY },
      { when: /\/order_states\/\d+\?/, body: ORDER_STATE_BODY },
    ]);
    const handler = createOrderLookupHandler(fakeDeps());
    const res = fakeRes();
    await handler(
      fakeReq({ body: { reference: REFERENCE, email: ACCOUNT_EMAIL }, ip: uniqueIp() }) as never,
      res as never
    );
    assert.equal(res.statusCode, 503);
  });

  test("sin conjunto de reglas activo → 503, nunca 500", async () => {
    stubIdentityOnly();
    const handler = createOrderLookupHandler(
      fakeDeps({
        loadActiveRuleSet: async () => {
          throw new RuleSetNotFoundError('No hay ningún conjunto de reglas activo para "mesdessous".');
        },
      })
    );
    const res = fakeRes();
    await handler(
      fakeReq({ body: { reference: REFERENCE, email: ACCOUNT_EMAIL }, ip: uniqueIp() }) as never,
      res as never
    );
    assert.equal(res.statusCode, 503);
    assert.ok((res.body as { error?: string }).error);
  });

  test("cualquier fallo al cargar las reglas es 503, no solo los errores tipados", async () => {
    // Verificado contra el entorno real: un error de conexión de Prisma NO es
    // `RuleSetNotFoundError`, y enumerando clases de error caía al 500 genérico.
    // Sin reglas no se puede contestar, y la causa nunca es del cliente que
    // pregunta: base inalcanzable, migración sin aplicar o pool agotado son el
    // mismo caso operativo. El detalle interno tampoco debe salir.
    stubIdentityOnly();
    const handler = createOrderLookupHandler(
      fakeDeps({
        loadActiveRuleSet: async () => {
          throw new Error("boom: detalle interno que no debe llegar al cliente");
        },
      })
    );
    const res = fakeRes();
    await handler(
      fakeReq({ body: { reference: REFERENCE, email: ACCOUNT_EMAIL }, ip: uniqueIp() }) as never,
      res as never
    );
    assert.equal(res.statusCode, 503);
    const message = (res.body as { error?: string }).error ?? "";
    assert.ok(!message.includes("boom"), "el mensaje interno no puede llegar al cliente");
  });

  test("un error no transitorio de la API en la consolidación responde 500 sin filtrar detalle", async () => {
    // El 500 sigue existiendo para lo que de verdad es inesperado: un error
    // funcional de PrestaShop (HTTP 400) no es transitorio y no se reintenta, así
    // que escapa como excepción. Debe responderse genérico, sin el mensaje de la API.
    stubFetch([
      { when: /\/orders\?/, body: ORDERS_BODY },
      { when: /\/customers\//, body: CUSTOMER_BODY },
      { when: /\/customer_threads\?/, body: EMPTY_THREADS_BODY },
      {
        when: /\/orders\/\d+\?/,
        status: 400,
        body: JSON.stringify({ errors: [{ code: 33, message: "detalle crudo de la API" }] }),
      },
      { when: /\//, body: emptyCollection("orders") },
    ]);
    const handler = createOrderLookupHandler(fakeDeps());
    const res = fakeRes();
    await handler(
      fakeReq({ body: { reference: REFERENCE, email: ACCOUNT_EMAIL }, ip: uniqueIp() }) as never,
      res as never
    );
    assert.equal(res.statusCode, 500);
    const message = (res.body as { error?: string }).error ?? "";
    assert.ok(!message.includes("detalle crudo"), "el mensaje de la API no puede llegar al cliente");
  });
});

describe("POST /order_lookup — camino feliz", () => {
  test("identidad verificada y regla resuelta → 200 con guidance y sin campos sensibles", async () => {
    stubHappyPath();
    const handler = createOrderLookupHandler(fakeDeps());
    const res = fakeRes();
    await handler(
      fakeReq({ body: { reference: REFERENCE, email: ACCOUNT_EMAIL }, ip: uniqueIp() }) as never,
      res as never
    );

    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal(body.found, true);
    assert.equal(body.identity_verified, true);
    assert.ok(body.order);
    assert.ok(body.customer);
    assert.ok(Array.isArray(body.lines));
    assert.ok(body.shipping);
    assert.ok(body.return);
    assert.ok(body.conversation);
    assert.ok(body.guidance);

    // `direction` es siempre "OUTBOUND": este endpoint es exactamente lo que consume el
    // agente, así que si el campo no llegara acá (whitelist explícita del handler), Lia
    // seguiría sin poder distinguir el tracking de ida del de un retorno (§ fallo real de
    // producción, conversación VJWIRCHVQ).
    const shipping = body.shipping as Record<string, unknown>;
    assert.equal(shipping.direction, "OUTBOUND");

    const guidance = body.guidance as Record<string, unknown>;
    assert.equal(guidance.situation, "MAIL_1");
    assert.equal(guidance.can_answer, true);
    assert.equal(guidance.must_escalate, false);
    assert.ok(Array.isArray(guidance.facts_to_convey));

    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("passwd"));
    assert.ok(!serialized.includes("secure_key"));
    assert.ok(!serialized.includes("reset_password_token"));
  });
});

describe("POST /order_lookup — límite de intentos", () => {
  test(`superar ${ORDER_LOOKUP_RATE_LIMIT_MAX_FAILURES} intentos fallidos de identidad desde la misma IP → 429`, async () => {
    const ip = uniqueIp();
    stubIdentityOnly();
    const handler = createOrderLookupHandler(fakeDeps());

    for (let i = 0; i < ORDER_LOOKUP_RATE_LIMIT_MAX_FAILURES; i++) {
      const res = fakeRes();
      await handler(
        fakeReq({ body: { reference: REFERENCE, email: `intruso${i}@example.com` }, ip }) as never,
        res as never
      );
      assert.equal(res.statusCode, 200, `intento ${i} debería resolver 200 (negativo uniforme), no bloquearse aún`);
    }

    const blockedRes = fakeRes();
    await handler(
      fakeReq({ body: { reference: REFERENCE, email: "otro-mas@example.com" }, ip }) as never,
      blockedRes as never
    );
    assert.equal(blockedRes.statusCode, 429);
  });

  test("un email correcto no cuenta como intento fallido ni bloquea intentos futuros de esa IP", async () => {
    const ip = uniqueIp();
    stubHappyPath();
    const handler = createOrderLookupHandler(fakeDeps());

    for (let i = 0; i < ORDER_LOOKUP_RATE_LIMIT_MAX_FAILURES + 2; i++) {
      const res = fakeRes();
      await handler(fakeReq({ body: { reference: REFERENCE, email: ACCOUNT_EMAIL }, ip }) as never, res as never);
      assert.equal(res.statusCode, 200);
    }
  });
});
