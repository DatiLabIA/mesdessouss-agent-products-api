import { getMany, getOne, PrestashopNotFoundError } from "./prestashop-client";
import { toNumericId } from "./order-identity";
import type { VerifiedCustomerData, VerifiedOrderData } from "../types";
import type { OrderFactsInput, OrderFactsLineInput, StateGroup } from "./order-facts";
import type { GuidanceExtraContext, GuidanceOrderContext } from "./rule-evaluator";

/**
 * Consolidación de un pedido: una sola llamada de más alto nivel que reúne
 * todo lo que hace falta de PrestaShop (en olas paralelas) y arma tanto el
 * `OrderFactsInput` para `computeOrderFacts` como el `GuidanceOrderContext`/
 * `GuidanceExtraContext` para `buildGuidance`.
 *
 * No repite la validación de identidad: recibe el pedido y el cliente ya
 * verificados por `verifyOrderIdentity` (T2). Tampoco carga el conjunto de
 * reglas desde base de datos —eso es tarea del handler (T11)— pero sí
 * necesita el mapeo de estado→grupo para mostrar el `group` del pedido y
 * para decidir si el estado "implica expedido" (`shippedWithoutTracking`):
 * se recibe inyectado, igual que `OrderFactsConfig.stateGroups`, nunca se
 * lee de una tabla desde este módulo.
 */

// ─── Entrada ────────────────────────────────────────────────────────────

/** Pedido y cliente ya verificados (rama `VERIFIED` de `OrderIdentityResult`), más la fecha de "hoy" inyectada. */
export interface ConsolidateOrderInput {
  order: VerifiedOrderData;
  customer: VerifiedCustomerData;
  /** "Hoy", inyectada por el llamador — igual que `OrderFactsInput.today`, nunca `new Date()` interno. */
  today: Date;
}

// ─── Formas crudas del webservice (whitelist vía `display`) ─────────────
//
// Los campos numéricos de identificador (`id`, `id_product`, `id_carrier`,
// etc.) se tipan directamente como `number`, siguiendo el mismo precedente
// que `order-identity.ts`: la API los devuelve como número en JSON. Los
// importes y cantidades se vuelven a coercionar con `toNumber` por si la
// instalación real los sirve como string, sin que eso rompa el tipo.

interface OrderHeaderRecord {
  id: number;
  reference: string;
  date_add: string;
  total_paid: string | number;
  total_paid_tax_incl: string | number;
  total_shipping_tax_incl: string | number;
  /** Vive también en `order_carriers.tracking_number`; se toma el primero con contenido real. */
  shipping_number: string | null;
}

/**
 * Verificado contra la API: los campos traducibles no son strings, son arrays
 * `[{ id: "1", value: "Retour Terminé" }, …]` indexados por id de idioma. Tiparlo
 * como `string` hacía que el nombre del estado viajara crudo hasta el payload.
 */
type TranslatableField = string | Array<{ id: string; value: string }>;

interface OrderStateRecord {
  id: number;
  name: TranslatableField;
}

/** Resuelve un campo traducible al idioma del pedido, con el francés (id 1) como respaldo. */
function resolveTranslatable(field: TranslatableField, idLang: number): string {
  if (typeof field === "string") return field;
  if (!Array.isArray(field) || field.length === 0) return "";
  const wanted = field.find((entry) => entry.id === String(idLang));
  const fallback = field.find((entry) => entry.id === "1");
  return (wanted ?? fallback ?? field[0]).value;
}

interface OrderDetailRecord {
  id: number;
  product_id: number;
  product_attribute_id: number;
  product_name: string;
  product_quantity: string | number;
}

interface ProductBrandRecord {
  id: number;
  manufacturer_name: string;
}

interface StockAvailableRecord {
  id: number;
  id_product: number;
  id_product_attribute: number;
  quantity: string | number;
}

interface OrderCarrierRecord {
  id: number;
  id_order: number;
  id_carrier: number;
  tracking_number: string | null;
}

interface CarrierRecord {
  id: number;
  name: string;
  url: string;
  delay: string;
}

interface OrderHistoryRecord {
  id: number;
  id_order_state: number;
  date_add: string;
}

interface CustomerThreadRecord {
  id: number;
  id_order: number;
  email: string;
  status: string;
  date_add: string;
  date_upd: string;
}

interface OrderSlipRecord {
  id: number;
  id_order: number;
  total_products_tax_incl: string | number;
  total_shipping_tax_incl: string | number;
  date_add: string;
}

interface CustomerMessageRecord {
  id: number;
  id_customer_thread: number;
  /** Presente y > 0 cuando lo escribió un empleado; ausente/0 cuando lo escribió el cliente. */
  id_employee: string | number | null;
  message: string;
  date_add: string;
}

interface CartRuleRecord {
  id: number;
  code: string;
  /** `"0000-00-00 00:00:00"` cuando el vale no caduca: `parsePrestashopDate` lo trata como `null`. */
  date_to: string;
  active: string | boolean;
}

// ─── Whitelists (`display=[...]`) ────────────────────────────────────────
//
// El cliente (`prestashop-client.ts`) siempre serializa `display` entre
// corchetes (`display=[campo1,campo2]`), así que nunca puede emitir el
// literal `display=full` que espera PrestaShop (eso produciría
// `display=[full]`, que la API interpretaría como "quiero el campo
// llamado full" y fallaría). Donde el documento de la tarea pide releer
// "con display=full", esta capa pide en su lugar la whitelist explícita
// de los campos que realmente hacen falta. Ver el reporte de la tarea.

const ORDER_HEADER_FIELDS = [
  "id",
  "reference",
  "date_add",
  "total_paid",
  "total_paid_tax_incl",
  "total_shipping_tax_incl",
  "shipping_number",
] as const;

const ORDER_STATE_FIELDS = ["id", "name"] as const;
const ORDER_DETAIL_FIELDS = ["id", "product_id", "product_attribute_id", "product_name", "product_quantity"] as const;
const PRODUCT_FIELDS = ["id", "manufacturer_name"] as const;
const STOCK_FIELDS = ["id", "id_product", "id_product_attribute", "quantity"] as const;
const ORDER_CARRIER_FIELDS = ["id", "id_order", "id_carrier", "tracking_number"] as const;
const CARRIER_FIELDS = ["id", "name", "url", "delay"] as const;
const ORDER_HISTORY_FIELDS = ["id", "id_order_state", "date_add"] as const;
const CUSTOMER_THREAD_FIELDS = ["id", "id_order", "email", "status", "date_add", "date_upd"] as const;
const ORDER_SLIP_FIELDS = ["id", "id_order", "total_products_tax_incl", "total_shipping_tax_incl", "date_add"] as const;
const CUSTOMER_MESSAGE_FIELDS = ["id", "id_customer_thread", "id_employee", "message", "date_add"] as const;
const CART_RULE_FIELDS = ["id", "code", "date_to", "active"] as const;

/** Estado 61 "Retour Terminé": la única señal fiable de retorno físico completado (§ hallazgos de la tarea). */
const RETURN_COMPLETED_STATE_ID = 61;

/** El webservice no expone `order_returns`; se documenta el motivo en vez de fingir el dato. */
const RETURN_DATA_UNAVAILABLE_REASON =
  "El recurso order_returns no existe en el webservice de PrestaShop: no hay forma de leer el estado " +
  "físico de la devolución. `completed` se deriva únicamente de current_state === 61 (Retour Terminé), " +
  "la única señal verificada como fiable; el motivo de stock (motivo 10) no sirve, cubre un tercio de " +
  "los casos y se dispara también con pedidos anulados.";

/**
 * Moneda de la tienda. El pedido solo trae `id_currency`; resolver el código ISO exigiría un recurso
 * adicional (`currencies/{id}`) que no está en las olas de esta tarea. Esta tienda es monomoneda EUR
 * (ver `CatalogProduct.currency` en `src/types/index.ts`), así que se fija el mismo valor aquí en vez
 * de inventar una llamada extra para un dato que no varía. Documentado en el reporte de la tarea.
 */
const DEFAULT_CURRENCY = "EUR";

/**
 * Prefijo verificado de las notas automáticas del módulo de pago (3D Secure / IPN). Nunca son mensajes
 * de conversación, ni siquiera cuando `private = 0`: el flag `private` es inservible para esto (62% de
 * las respuestas de empleados lo tienen a 1, y clientes responden después igual), así que la nota se
 * reconoce por contenido.
 */
const PAYMENT_MODULE_NOTE_PREFIX = "Action successfully completed";

/** Un mensaje de conversación real no es cliente esperando > este umbral. */
const AWAITING_REPLY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// ─── Helpers de bajo nivel ────────────────────────────────────────────────

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}

/** El primer valor con contenido real (no vacío, no solo espacios), o `null` si ninguno lo tiene. */
function firstNonBlank(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (!isBlank(value)) return (value as string).trim();
  }
  return null;
}

function toNumber(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isNaN(n) ? 0 : n;
}

function toBool(value: string | boolean | null | undefined): boolean {
  return value === true || value === "1";
}

/**
 * Interpreta una fecha del webservice (`"AAAA-MM-DD HH:mm:ss"`) como UTC, forzando la `Z` porque el
 * motor de JavaScript trataría ese formato sin ella como hora LOCAL del proceso. Sigue la misma
 * convención de fecha civil de `business-days.ts`: se ignora el desfase horario real de la tienda, se
 * toma la lectura del reloj tal cual. El sentinela `"0000-00-00 00:00:00"` de PrestaShop (fecha "sin
 * valor", típico en `cart_rules.date_to` cuando el vale no caduca) se trata como `null`, no como una
 * fecha real de 1899.
 */
function parsePrestashopDate(raw: string | null | undefined): Date | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith("0000-00-00")) return null;
  const iso = trimmed.includes("T") ? trimmed : `${trimmed.replace(" ", "T")}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Sintaxis OR de PrestaShop para filtrar por lote: `filter[campo]=[v1|v2|v3]`. El tipo `PrestashopFilterValue`
 * del cliente solo admite un valor simple o una tupla `[min,max]` de RANGO (una sintaxis distinta, con
 * comas): no tiene una variante de lista. Pasar el string ya formado con corchetes y barras funciona sin
 * tocar el cliente porque PHP decodifica el query string antes de que PrestaShop inspeccione el valor del
 * filtro: quien la codifique (`encodeURIComponent`, que es lo que hace `serializeFilterValue` para un
 * valor no-array) es indiferente al resultado final. Documentado en el reporte como una carencia de
 * `prestashop-client.ts` para una tarea futura, no como un bug de esta capa.
 */
function orFilterValue(values: ReadonlyArray<string | number>): string {
  return `[${values.join("|")}]`;
}

/** Trae un recurso por lote solo si hay ids: evita `filter[campo]=[]`, que no es una sintaxis válida. */
async function fetchBatch<T>(
  resource: string,
  ids: ReadonlyArray<string | number>,
  filterField: string,
  display: readonly string[]
): Promise<T[]> {
  if (ids.length === 0) return [];
  return getMany<T>(resource, { filter: { [filterField]: orFilterValue(ids) }, display });
}

/** `true` si `message` es una nota automática del módulo de pago (3DS/IPN), nunca una respuesta real. */
function isPaymentModuleNote(message: string): boolean {
  return message.trim().startsWith(PAYMENT_MODULE_NOTE_PREFIX);
}

/** `true` si el autor del mensaje es el cliente: sin empleado asignado (o `0`), nunca por el flag `private`. */
function isFromCustomer(message: CustomerMessageRecord): boolean {
  return toNumber(message.id_employee) === 0;
}

// ─── Salida ───────────────────────────────────────────────────────────────

export interface ConsolidatedOrderStatus {
  id: number;
  name: string;
}

export interface ConsolidatedOrderTotals {
  totalPaid: number;
  shippingPaid: number;
}

export interface ConsolidatedOrder {
  id: number;
  reference: string;
  dateAdd: Date;
  status: ConsolidatedOrderStatus;
  /** Grupo del árbol de decisión (§2.1 del documento de reglas): `A|B|C|D`. `D` = estado no cubierto. */
  group: StateGroup;
  totals: ConsolidatedOrderTotals;
  currency: string;
}

/** Nunca lleva campos sensibles (`passwd`, `secure_key`, etc.): ya vienen filtrados desde `VerifiedCustomerData`. */
export interface ConsolidatedCustomer {
  firstname: string;
  lastname: string;
  email: string;
  idLang: number;
}

export interface ConsolidatedLine {
  name: string;
  brand: string | null;
  quantity: number;
  /** `null` cuando la combinación no tiene fila en `stock_availables`: stock indeterminable, no cero. */
  stockQuantity: number | null;
  /** `stockQuantity !== null && stockQuantity >= 0`. Igual criterio que `OrderFactsLine.covered`. */
  covered: boolean;
}

export interface ConsolidatedShipping {
  carrierName: string | null;
  /** `null` si no hay número real en ninguna de las dos fuentes (`orders.shipping_number` u `order_carriers.tracking_number`). */
  trackingNumber: string | null;
  /** URL del transportista con `@` sustituido por el número. `null` si falta el número o la URL. Nunca se inventa un patrón. */
  trackingUrl: string | null;
  /** El estado implica expedido (grupo B o C) pero no hay número de seguimiento en ninguna fuente. */
  shippedWithoutTracking: boolean;
  /** Fecha de la primera entrada en `order_histories` cuyo estado mapea a grupo B. `null` si nunca se alcanzó. */
  shippedAt: Date | null;
}

export interface ConsolidatedRefund {
  /** Suma de `total_products_tax_incl + total_shipping_tax_incl` de todos los avoirs del pedido. */
  amount: number;
  type: "VOUCHER" | "MONEY";
  /** Caducidad del vale (`cart_rules.date_to`). `null` si es dinero, o si el vale no caduca. */
  voucherExpiresAt: Date | null;
  /** Fecha del avoir más reciente (`order_slip.date_add`). */
  processedDate: Date;
}

export interface ConsolidatedReturn {
  dataAvailable: false;
  reason: string;
  /** `current_state === 61` ("Retour Terminé"), la única señal fiable verificada. */
  completed: boolean;
}

export interface ConsolidatedConversation {
  threadId: number | null;
  lastMessage: string | null;
  lastMessageDate: Date | null;
  /**
   * El último mensaje real (no una nota del módulo de pago) es del cliente y pasaron más de 24
   * horas sin respuesta. No está en el documento de reglas: se agrega porque en 4 de 6 casos reales
   * auditados el dato que resolvía la consulta estaba en el hilo, no en el pedido.
   */
  awaitingShopReply: boolean;
}

export interface OrderConsolidationResult {
  order: ConsolidatedOrder;
  customer: ConsolidatedCustomer;
  lines: ConsolidatedLine[];
  shipping: ConsolidatedShipping;
  /** `null` cuando el pedido no tiene ningún avoir. */
  refund: ConsolidatedRefund | null;
  return: ConsolidatedReturn;
  conversation: ConsolidatedConversation;
  /** Listo para pasar a `computeOrderFacts` junto con el `OrderFactsConfig` que cargue el handler. */
  facts: OrderFactsInput;
  /** Listo para pasar a `buildGuidance` junto con la evaluación de la matriz. */
  orderContext: GuidanceOrderContext;
  /**
   * `pendingProducts` y `additionalDelay` siempre viajan en `null`: interpretarlos exige leer el
   * historial en lenguaje natural (§7.1, mail 6), y esa interpretación es tarea de Lia, no de este
   * módulo. Solo `processedDate` se resuelve acá, a partir del avoir.
   */
  extraContext: GuidanceExtraContext;
}

// ─── Marcas y stock por línea ───────────────────────────────────────────

function buildFactsLines(
  lines: OrderDetailRecord[],
  products: ProductBrandRecord[],
  stocks: StockAvailableRecord[]
): OrderFactsLineInput[] {
  // Todos los cruces pasan por `toNumericId`. La API mezcla los tipos dentro de la
  // misma respuesta —`id` viene como número, cualquier otro `id_*` como string—, así
  // que `producto.id === linea.product_id` compara 63242 contra "63242" y da falso
  // siempre. El fallo no lanza nada: deja la marca en null, y con eso la tabla de
  // plazos entera queda muerta sin que nadie se entere.
  return lines.map((line) => {
    const productId = toNumericId(line.product_id);
    const attributeId = toNumericId(line.product_attribute_id);

    const product = products.find((p) => toNumericId(p.id) === productId) ?? null;
    const stock =
      stocks.find(
        (s) => toNumericId(s.id_product) === productId && toNumericId(s.id_product_attribute) === attributeId
      ) ?? null;

    const brand = product !== null && !isBlank(product.manufacturer_name) ? product.manufacturer_name.trim() : null;

    return {
      name: line.product_name,
      brand,
      quantity: toNumber(line.product_quantity),
      stockQuantity: stock !== null ? toNumber(stock.quantity) : null,
    };
  });
}

// ─── Transportista y seguimiento ──────────────────────────────────────────

interface ShippingSources {
  orderCarriers: OrderCarrierRecord[];
  carriers: CarrierRecord[];
}

/** Trae `carriers/{id}` tolerando que el transportista ya no exista (404): degrada a `null`, nunca oculta un transitorio. */
async function fetchCarrierSafe(id: number): Promise<CarrierRecord | null> {
  try {
    return await getOne<CarrierRecord>("carriers", id, { display: CARRIER_FIELDS });
  } catch (err) {
    if (err instanceof PrestashopNotFoundError) return null;
    throw err;
  }
}

async function fetchShippingSources(orderId: number): Promise<ShippingSources> {
  const orderCarriers = await getMany<OrderCarrierRecord>("order_carriers", {
    filter: { id_order: orderId },
    display: ORDER_CARRIER_FIELDS,
  });

  const carrierIds = [...new Set(orderCarriers.map((c) => c.id_carrier))];
  const carriers = await Promise.all(carrierIds.map((id) => fetchCarrierSafe(id)));

  return { orderCarriers, carriers: carriers.filter((c): c is CarrierRecord => c !== null) };
}

function computeShippedAt(histories: OrderHistoryRecord[], stateGroups: Map<number, StateGroup>): Date | null {
  let earliest: Date | null = null;
  for (const history of histories) {
    if (stateGroups.get(history.id_order_state) !== "B") continue;
    const date = parsePrestashopDate(history.date_add);
    if (date === null) continue;
    if (earliest === null || date.getTime() < earliest.getTime()) earliest = date;
  }
  return earliest;
}

/**
 * Resuelve transportista, número de seguimiento y URL.
 *
 * El número se busca primero en `orders.shipping_number` y, si no tiene contenido real, en el primer
 * `order_carriers.tracking_number` que sí lo tenga (orden verificado en el documento de la tarea).
 * Una cadena vacía o solo espacios cuenta como ausente en las dos fuentes. La URL sale de
 * `carriers.url` sustituyendo `@` por el número; si falta cualquiera de los dos, es `null` — nunca se
 * inventa un patrón de URL de transportista.
 */
function computeShipping(
  header: OrderHeaderRecord,
  sources: ShippingSources,
  group: StateGroup,
  histories: OrderHistoryRecord[],
  stateGroups: Map<number, StateGroup>
): ConsolidatedShipping {
  // Indexado por id ya normalizado: `carriers.id` llega como número y
  // `order_carriers.id_carrier` como string, así que un Map sin normalizar
  // nunca encuentra nada y la URL de seguimiento queda en null.
  const carrierById = new Map(sources.carriers.map((c) => [toNumericId(c.id), c] as const));

  let trackingNumber: string | null = null;
  let sourceCarrier: CarrierRecord | null = null;

  if (!isBlank(header.shipping_number)) {
    trackingNumber = header.shipping_number!.trim();
  } else {
    for (const orderCarrier of sources.orderCarriers) {
      if (!isBlank(orderCarrier.tracking_number)) {
        trackingNumber = orderCarrier.tracking_number!.trim();
        sourceCarrier = carrierById.get(toNumericId(orderCarrier.id_carrier)) ?? null;
        break;
      }
    }
  }

  // El transportista a mostrar es el de la fuente que aportó el número; si el número vino de
  // `orders.shipping_number` (que no está ligado a un transportista concreto) o no hay número en
  // absoluto, se usa el primer `order_carriers` del pedido como mejor referencia disponible.
  if (sourceCarrier === null && sources.orderCarriers.length > 0) {
    sourceCarrier = carrierById.get(toNumericId(sources.orderCarriers[0].id_carrier)) ?? null;
  }

  const trackingUrl =
    trackingNumber !== null && sourceCarrier !== null && !isBlank(sourceCarrier.url)
      ? sourceCarrier.url.replace("@", trackingNumber)
      : null;

  // "Implica expedido": grupo B (expedido) o C (expedición parcial). Ver §3.1 del documento.
  const impliesShipped = group === "B" || group === "C";
  const shippedWithoutTracking = impliesShipped && trackingNumber === null;

  return {
    carrierName: sourceCarrier?.name ?? null,
    trackingNumber,
    trackingUrl,
    shippedWithoutTracking,
    shippedAt: computeShippedAt(histories, stateGroups),
  };
}

// ─── Conversación ─────────────────────────────────────────────────────────

/** Última fecha de actividad de un hilo: la del mensaje más reciente, o `date_upd`/`date_add` si no tiene ninguno. */
function threadActivityTime(thread: CustomerThreadRecord, messages: CustomerMessageRecord[]): number {
  const messageTimes = messages
    .map((m) => parsePrestashopDate(m.date_add)?.getTime() ?? null)
    .filter((t): t is number => t !== null);
  if (messageTimes.length > 0) return Math.max(...messageTimes);
  const fallback = parsePrestashopDate(thread.date_upd) ?? parsePrestashopDate(thread.date_add);
  return fallback?.getTime() ?? 0;
}

/** El hilo con la actividad más reciente. `null` si el pedido no tiene ningún hilo. */
function pickPrimaryThread(
  threads: CustomerThreadRecord[],
  messagesByThread: Map<number, CustomerMessageRecord[]>
): CustomerThreadRecord | null {
  if (threads.length === 0) return null;
  let best = threads[0];
  let bestTime = threadActivityTime(best, messagesByThread.get(best.id) ?? []);
  for (const thread of threads.slice(1)) {
    const time = threadActivityTime(thread, messagesByThread.get(thread.id) ?? []);
    if (time > bestTime) {
      best = thread;
      bestTime = time;
    }
  }
  return best;
}

/**
 * Regla conservadora del `historyHasInfo` que consume el motor de reglas (§7.1 del documento habla de
 * que la IA interpreta el historial para los mails 6 y 7; acá no se adivina):
 *
 * - Si NINGÚN mensaje del pedido (en ningún hilo) es real —todos son notas automáticas del módulo de
 *   pago, o no hay mensajes en absoluto— el historial se declara mecánicamente vacío: `false`. Eso
 *   habilita el mail 7.
 * - Si hay al menos un mensaje real, no se afirma que contenga productos pendientes o un plazo: se
 *   devuelve `null`, que el evaluador de la matriz trata como "no lo sé" y escala. En fase 1, esto
 *   implica que el Grupo C con historial no vacío escala siempre, aunque el mensaje real no aporte
 *   nada útil: es preferible a inventar una lectura del contenido.
 */
function computeHistoryHasInfo(allMessages: CustomerMessageRecord[]): boolean | null {
  const hasRealMessage = allMessages.some((m) => !isPaymentModuleNote(m.message));
  return hasRealMessage ? null : false;
}

function computeConversation(
  primaryThread: CustomerThreadRecord | null,
  messagesByThread: Map<number, CustomerMessageRecord[]>,
  today: Date
): ConsolidatedConversation {
  if (primaryThread === null) {
    return { threadId: null, lastMessage: null, lastMessageDate: null, awaitingShopReply: false };
  }

  const messages = messagesByThread.get(primaryThread.id) ?? [];
  const sorted = [...messages].sort(
    (a, b) => (parsePrestashopDate(a.date_add)?.getTime() ?? 0) - (parsePrestashopDate(b.date_add)?.getTime() ?? 0)
  );

  const last = sorted.at(-1) ?? null;
  const realMessages = sorted.filter((m) => !isPaymentModuleNote(m.message));
  const lastReal = realMessages.at(-1) ?? null;
  const lastRealDate = lastReal !== null ? parsePrestashopDate(lastReal.date_add) : null;

  const awaitingShopReply =
    lastReal !== null &&
    lastRealDate !== null &&
    isFromCustomer(lastReal) &&
    today.getTime() - lastRealDate.getTime() > AWAITING_REPLY_THRESHOLD_MS;

  return {
    threadId: primaryThread.id,
    lastMessage: last?.message ?? null,
    lastMessageDate: last !== null ? parsePrestashopDate(last.date_add) : null,
    awaitingShopReply,
  };
}

// ─── Reembolso: vale o dinero ─────────────────────────────────────────────

/**
 * Detecta si algún avoir del pedido fue un vale en vez de dinero: busca, entre los `cart_rules` del
 * cliente, uno activo cuyo código coincida EXACTAMENTE con `V<id_cart_rule>C<id_customer>O<id_order>`
 * (el propio id de la regla forma parte de su propio código, así que se recorre cada regla y se
 * compara contra el código que le correspondería a ELLA). Si hay coincidencia, el reembolso es
 * `VOUCHER` y su caducidad es `cart_rules.date_to`; si no, es `MONEY`.
 */
function computeRefund(
  slips: OrderSlipRecord[],
  cartRules: CartRuleRecord[],
  customerId: number,
  orderId: number
): ConsolidatedRefund | null {
  if (slips.length === 0) return null;

  const amount = slips.reduce(
    (sum, slip) => sum + toNumber(slip.total_products_tax_incl) + toNumber(slip.total_shipping_tax_incl),
    0
  );

  const latestSlip = [...slips].sort(
    (a, b) => (parsePrestashopDate(a.date_add)?.getTime() ?? 0) - (parsePrestashopDate(b.date_add)?.getTime() ?? 0)
  ).at(-1)!;
  const processedDate = parsePrestashopDate(latestSlip.date_add) ?? new Date(0);

  const matchingRule = cartRules.find(
    (rule) => toBool(rule.active) && rule.code === `V${rule.id}C${customerId}O${orderId}`
  );

  if (matchingRule !== undefined) {
    return {
      amount,
      type: "VOUCHER",
      voucherExpiresAt: parsePrestashopDate(matchingRule.date_to),
      processedDate,
    };
  }

  return { amount, type: "MONEY", voucherExpiresAt: null, processedDate };
}

// ─── Orquestación ─────────────────────────────────────────────────────────

/**
 * Reúne en tres olas todo lo que hace falta de PrestaShop para un pedido ya verificado, y arma el
 * payload consolidado: hechos de negocio de cara a Lia, más `facts`/`orderContext`/`extraContext` ya
 * listos para `computeOrderFacts` y `buildGuidance`.
 *
 * `stateGroups` se inyecta (igual que `OrderFactsConfig.stateGroups`): esta función no toca base de
 * datos, ni siquiera para el mapeo de estados, y no evalúa la matriz de reglas — solo prepara su
 * entrada. Cargar el conjunto de reglas activo es tarea del handler (T11).
 *
 * Cualquier fallo transitorio de PrestaShop en cualquiera de las tres olas (`PrestashopUnavailableError`,
 * incluido un timeout) se propaga tal cual: ninguna ola atrapa un error transitorio para disfrazarlo de
 * "sin datos". La única excepción es un 404 puntual al leer el detalle de un transportista concreto
 * (`carriers/{id}`), que degrada a "transportista desconocido" en vez de tumbar toda la consolidación,
 * igual que el 404 de `customer_threads` degrada en silencio en `verifyOrderIdentity` (T2).
 */
export async function consolidateOrder(
  input: ConsolidateOrderInput,
  stateGroups: Map<number, StateGroup>
): Promise<OrderConsolidationResult> {
  const orderId = input.order.id;
  const customerId = input.customer.id;
  const currentStateId = input.order.currentState;

  // ─── Ola 1 ──────────────────────────────────────────────────────────
  // El pedido se relee con la whitelist de campos que la verificación de identidad no pidió
  // (totales, número de seguimiento). El documento de la tarea habla de "display=full"; el cliente
  // HTTP no puede emitir ese literal (ver el comentario de `ORDER_HEADER_FIELDS`), así que se pide
  // la whitelist explícita en su lugar. `order_states` usa el `currentState` ya conocido por la
  // identidad verificada momentos antes en el mismo request, no uno recién releído: las dos
  // consultas son independientes entre sí a propósito, para que corran en paralelo de verdad.
  const [header, lines, state] = await Promise.all([
    getOne<OrderHeaderRecord>("orders", orderId, { display: ORDER_HEADER_FIELDS }),
    getMany<OrderDetailRecord>("order_details", { filter: { id_order: orderId }, display: ORDER_DETAIL_FIELDS }),
    getOne<OrderStateRecord>("order_states", currentStateId, { display: ORDER_STATE_FIELDS }),
  ]);

  const group = stateGroups.get(currentStateId) ?? "D";

  const productIds = [...new Set(lines.map((l) => l.product_id))];
  const attributeIds = [...new Set(lines.map((l) => l.product_attribute_id))];

  // ─── Ola 2 ──────────────────────────────────────────────────────────
  const [products, stocks, shippingSources, histories, threads, slips] = await Promise.all([
    fetchBatch<ProductBrandRecord>("products", productIds, "id", PRODUCT_FIELDS),
    fetchBatch<StockAvailableRecord>("stock_availables", attributeIds, "id_product_attribute", STOCK_FIELDS),
    fetchShippingSources(orderId),
    getMany<OrderHistoryRecord>("order_histories", { filter: { id_order: orderId }, display: ORDER_HISTORY_FIELDS }),
    getMany<CustomerThreadRecord>("customer_threads", {
      filter: { id_order: orderId },
      display: CUSTOMER_THREAD_FIELDS,
    }),
    getMany<OrderSlipRecord>("order_slip", { filter: { id_order: orderId }, display: ORDER_SLIP_FIELDS }),
  ]);

  // ─── Ola 3 ──────────────────────────────────────────────────────────
  // `cart_rules` solo hace falta si hay al menos un avoir que clasificar: sin avoir no hay nada que
  // distinguir entre vale y dinero.
  const threadIds = threads.map((t) => t.id);
  const [allMessages, cartRules] = await Promise.all([
    fetchBatch<CustomerMessageRecord>("customer_messages", threadIds, "id_customer_thread", CUSTOMER_MESSAGE_FIELDS),
    slips.length > 0
      ? getMany<CartRuleRecord>("cart_rules", { filter: { id_customer: customerId }, display: CART_RULE_FIELDS })
      : Promise.resolve<CartRuleRecord[]>([]),
  ]);

  // ─── Ensamblado ─────────────────────────────────────────────────────

  const messagesByThread = new Map<number, CustomerMessageRecord[]>();
  for (const message of allMessages) {
    const bucket = messagesByThread.get(message.id_customer_thread);
    if (bucket) {
      bucket.push(message);
    } else {
      messagesByThread.set(message.id_customer_thread, [message]);
    }
  }

  const factsLines = buildFactsLines(lines, products, stocks);

  // Fallback defensivo, no de negocio: un pedido real siempre trae `date_add`. Si viniera vacío o
  // corrupto, se usa `today` para no romper el cálculo de plazos con una fecha inválida.
  const orderDate = parsePrestashopDate(header.date_add) ?? input.today;

  const trackingNumber = firstNonBlank(
    header.shipping_number,
    ...shippingSources.orderCarriers.map((c) => c.tracking_number)
  );

  const shipping = computeShipping(header, shippingSources, group, histories, stateGroups);
  const refund = computeRefund(slips, cartRules, customerId, orderId);
  const primaryThread = pickPrimaryThread(threads, messagesByThread);
  const conversation = computeConversation(primaryThread, messagesByThread, input.today);
  const historyHasInfo = computeHistoryHasInfo(allMessages);

  const facts: OrderFactsInput = {
    orderDate,
    stateId: currentStateId,
    trackingNumber,
    lines: factsLines,
    historyHasInfo,
    today: input.today,
  };

  const orderContext: GuidanceOrderContext = {
    reference: header.reference,
    idLang: input.customer.idLang,
    trackingUrl: shipping.trackingUrl,
  };

  const extraContext: GuidanceExtraContext = {
    pendingProducts: null,
    additionalDelay: null,
    processedDate: refund?.processedDate ?? null,
  };

  return {
    order: {
      id: header.id,
      reference: header.reference,
      dateAdd: orderDate,
      status: { id: currentStateId, name: resolveTranslatable(state.name, input.customer.idLang) },
      group,
      totals: {
        totalPaid: toNumber(header.total_paid_tax_incl ?? header.total_paid),
        shippingPaid: toNumber(header.total_shipping_tax_incl),
      },
      currency: DEFAULT_CURRENCY,
    },
    customer: {
      firstname: input.customer.firstname,
      lastname: input.customer.lastname,
      email: input.customer.email,
      idLang: input.customer.idLang,
    },
    lines: factsLines.map((line) => ({
      ...line,
      covered: line.stockQuantity !== null && line.stockQuantity >= 0,
    })),
    shipping,
    refund,
    return: {
      dataAvailable: false,
      reason: RETURN_DATA_UNAVAILABLE_REASON,
      completed: currentStateId === RETURN_COMPLETED_STATE_ID,
    },
    conversation,
    facts,
    orderContext,
    extraContext,
  };
}
