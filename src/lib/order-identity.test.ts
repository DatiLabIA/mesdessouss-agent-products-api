import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { verifyOrderIdentity } from "./order-identity";

// El import de arriba es estático y no revienta aunque la clave se asigne después:
// la configuración se lee de forma diferida en la primera petición, no al evaluar
// el módulo. Si volviera a leerse al importar, este fichero dejaría de cargar.
process.env.PRESTASHOP_API_KEY = "clave-de-prueba";
process.env.PRESTASHOP_API_URL = "https://ps.test/api/";

const ORDER_ID = 705570;
const CUSTOMER_ID = 27794;
const REFERENCE = "LLKVUZDZD";
const ACCOUNT_EMAIL = "marie54140@hotmail.fr";
const THREAD_EMAIL = "correo.anterior@example.com";

const ORDERS_BODY = JSON.stringify({
  orders: [
    {
      id: ORDER_ID,
      reference: REFERENCE,
      id_customer: CUSTOMER_ID,
      date_add: "2026-08-27 23:42:20",
      current_state: 61,
      valid: "1",
    },
  ],
});

// Forma real verificada contra la API: con `display=[...]` un recurso individual
// vuelve como ARRAY con la clave en plural, no como objeto en singular.
const CUSTOMER_BODY = JSON.stringify({
  customers: [
    { id: CUSTOMER_ID, email: ACCOUNT_EMAIL, firstname: "Marie France", lastname: "lorgeas", id_lang: 1 },
  ],
});

const THREADS_BODY = JSON.stringify({
  customer_threads: [{ id: 183438, email: THREAD_EMAIL }],
});

interface StubRoute {
  when: RegExp;
  body?: string;
  status?: number;
  /** Simula el `TimeoutError` que lanza `fetch` cuando `AbortSignal.timeout` aborta. */
  timeout?: boolean;
}

const realFetch = globalThis.fetch;
let callCount = 0;

function stubFetch(routes: StubRoute[]): void {
  callCount = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    callCount += 1;
    const url = String(input);
    const route = routes.find((r) => r.when.test(url));
    assert.ok(route, `El test no tiene stub para la URL solicitada: ${url}`);
    if (route.timeout) {
      const err = new Error("timeout simulado");
      err.name = "TimeoutError";
      throw err;
    }
    return new Response(route.body ?? "", { status: route.status ?? 200 });
  }) as typeof fetch;
}

/** Stub del camino feliz: pedido encontrado, cliente y un hilo con otro email. */
function stubHappyPath(): void {
  stubFetch([
    { when: /\/orders\?/, body: ORDERS_BODY },
    { when: /\/customers\//, body: CUSTOMER_BODY },
    { when: /\/customer_threads\?/, body: THREADS_BODY },
  ]);
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("verifyOrderIdentity", () => {
  test("acepta el email de la cuenta del pedido", async () => {
    stubHappyPath();
    const r = await verifyOrderIdentity({ reference: REFERENCE, email: ACCOUNT_EMAIL });
    assert.equal(r.outcome, "VERIFIED");
    assert.equal(r.outcome === "VERIFIED" && r.customer.id, CUSTOMER_ID);
  });

  test("acepta un email de un hilo de ese pedido aunque no sea el de la cuenta", async () => {
    stubHappyPath();
    const r = await verifyOrderIdentity({ reference: REFERENCE, email: THREAD_EMAIL });
    assert.equal(r.outcome, "VERIFIED");
  });

  test("normaliza mayúsculas del email y minúsculas de la referencia", async () => {
    stubHappyPath();
    const r = await verifyOrderIdentity({
      reference: REFERENCE.toLowerCase(),
      email: ACCOUNT_EMAIL.toUpperCase(),
    });
    assert.equal(r.outcome, "VERIFIED");
  });

  test("un email ajeno no verifica y no filtra ningún dato del pedido", async () => {
    stubHappyPath();
    const r = await verifyOrderIdentity({ reference: REFERENCE, email: "intruso@example.com" });
    assert.equal(r.outcome, "IDENTITY_NOT_VERIFIED");
    // Criterio 4: el negativo no lleva nada más que el veredicto.
    assert.deepEqual(Object.keys(r), ["outcome"]);
  });

  test("una referencia inexistente es indistinguible de un email que no coincide", async () => {
    stubFetch([{ when: /\/orders\?/, body: JSON.stringify({ orders: [] }) }]);
    const inexistente = await verifyOrderIdentity({ reference: "ZZZZZZZZZ", email: ACCOUNT_EMAIL });

    stubHappyPath();
    const emailAjeno = await verifyOrderIdentity({ reference: REFERENCE, email: "intruso@example.com" });

    assert.deepEqual(inexistente, emailAjeno);
  });

  test("una referencia mal formada colapsa al mismo negativo uniforme", async () => {
    stubFetch([]);
    const r = await verifyOrderIdentity({ reference: "ABC", email: ACCOUNT_EMAIL });
    assert.equal(r.outcome, "IDENTITY_NOT_VERIFIED");
    assert.equal(callCount, 0, "una entrada inválida no debe llegar a consultar la API");
  });

  test("un 200 con cuerpo vacío reintenta y nunca se disfraza de identidad no verificada", async () => {
    stubFetch([{ when: /\/orders\?/, body: "" }]);
    const r = await verifyOrderIdentity({ reference: REFERENCE, email: ACCOUNT_EMAIL });
    // Criterio 3: un cuerpo vacío es un fallo transitorio, no "sin resultados".
    assert.equal(r.outcome, "SERVICE_UNAVAILABLE");
    assert.equal(callCount, 3, "debe agotar el intento inicial más los dos reintentos");
  });

  test("un fallo transitorio leyendo el cliente tampoco niega la identidad", async () => {
    stubFetch([
      { when: /\/orders\?/, body: ORDERS_BODY },
      { when: /\/customers\//, body: "", status: 503 },
      { when: /\/customer_threads\?/, body: THREADS_BODY },
    ]);
    const r = await verifyOrderIdentity({ reference: REFERENCE, email: ACCOUNT_EMAIL });
    assert.equal(r.outcome, "SERVICE_UNAVAILABLE");
  });

  test("si los hilos devuelven 404, el email de cuenta sigue verificando", async () => {
    // El recurso customer_threads puede no estar expuesto por los permisos del
    // webservice. Ese 404 no puede rechazar al dueño cuyo email de cuenta coincide.
    stubFetch([
      { when: /\/orders\?/, body: ORDERS_BODY },
      { when: /\/customers\//, body: CUSTOMER_BODY },
      { when: /\/customer_threads\?/, status: 404 },
    ]);
    const r = await verifyOrderIdentity({ reference: REFERENCE, email: ACCOUNT_EMAIL });
    assert.equal(r.outcome, "VERIFIED");
  });

  test("si los hilos devuelven 404, un email ajeno sigue sin verificar", async () => {
    stubFetch([
      { when: /\/orders\?/, body: ORDERS_BODY },
      { when: /\/customers\//, body: CUSTOMER_BODY },
      { when: /\/customer_threads\?/, status: 404 },
    ]);
    const r = await verifyOrderIdentity({ reference: REFERENCE, email: "intruso@example.com" });
    assert.equal(r.outcome, "IDENTITY_NOT_VERIFIED");
    assert.deepEqual(Object.keys(r), ["outcome"]);
  });

  test("un timeout se resuelve a servicio no disponible, no escapa como excepción", async () => {
    stubFetch([{ when: /\/orders\?/, timeout: true }]);
    const r = await verifyOrderIdentity({ reference: REFERENCE, email: ACCOUNT_EMAIL });
    assert.equal(r.outcome, "SERVICE_UNAVAILABLE");
  });

  test("un timeout en los hilos no impide verificar por el email de cuenta", async () => {
    stubFetch([
      { when: /\/orders\?/, body: ORDERS_BODY },
      { when: /\/customers\//, body: CUSTOMER_BODY },
      { when: /\/customer_threads\?/, timeout: true },
    ]);
    const r = await verifyOrderIdentity({ reference: REFERENCE, email: ACCOUNT_EMAIL });
    assert.equal(r.outcome, "VERIFIED");
  });

  test("un timeout en los hilos sí es decisivo si el email solo podía estar ahí", async () => {
    stubFetch([
      { when: /\/orders\?/, body: ORDERS_BODY },
      { when: /\/customers\//, body: CUSTOMER_BODY },
      { when: /\/customer_threads\?/, timeout: true },
    ]);
    const r = await verifyOrderIdentity({ reference: REFERENCE, email: THREAD_EMAIL });
    assert.equal(r.outcome, "SERVICE_UNAVAILABLE");
  });

  test("más de un pedido con la misma referencia escala en vez de elegir uno", async () => {
    const dos = JSON.stringify({
      orders: [
        { id: 1, reference: REFERENCE, id_customer: 10, date_add: "", current_state: 2, valid: "1" },
        { id: 2, reference: REFERENCE, id_customer: 20, date_add: "", current_state: 2, valid: "1" },
      ],
    });
    stubFetch([{ when: /\/orders\?/, body: dos }]);
    const r = await verifyOrderIdentity({ reference: REFERENCE, email: ACCOUNT_EMAIL });
    assert.equal(r.outcome, "AMBIGUOUS_REFERENCE");
  });
});
