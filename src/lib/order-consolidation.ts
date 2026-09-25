import { getMany, getOne, PrestashopNotFoundError } from "./prestashop-client";
import { toNumericId } from "./order-identity";
import type { VerifiedCustomerData, VerifiedOrderData } from "../types";
import type { OrderFactsInput, OrderFactsLineInput, StateGroup } from "./order-facts";
import type { GuidanceExtraContext, GuidanceOrderContext, GuidanceRefundContext } from "./rule-evaluator";

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
  /** Dirección de entrega (`addresses.id`). `id_*`, viaja como string: normalizar con `toNumericId`. */
  id_address_delivery: string | number;
  /**
   * Dirección de facturación. Solo se usa para compararla contra `id_address_delivery`: cuando
   * difieren, el pedido es candidato a punto de recogida (§ decisión de `computeDeliveryAddress`).
   */
  id_address_invoice: string | number;
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
  /** Campo traducible, igual que `order_states.name`: se resuelve con `resolveTranslatable`. */
  delay: TranslatableField;
}

interface OrderHistoryRecord {
  id: number;
  /**
   * Igual patrón que el resto de campos `id_*` (verificado en T9 para `product_id`/`id_carrier`):
   * viaja como string mientras `id` viaja como número. Se normaliza con `toNumericId` en cada uso,
   * nunca se compara ni se indexa cruda contra el mapa de grupos.
   */
  id_order_state: string | number;
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

/** Una línea de un avoir (`order_slip.associations.order_slip_details`). Solo viaja con `displayFull`. */
interface OrderSlipDetailRecord {
  /** `order_details.id` de la línea del pedido cubierta por el avoir. `id_*`, viaja como string. */
  id_order_detail: string | number;
  product_quantity: string | number;
  amount_tax_incl: string | number;
}

interface OrderSlipRecord {
  id: number;
  id_order: number;
  total_products_tax_incl: string | number;
  total_shipping_tax_incl: string | number;
  date_add: string;
  /**
   * Solo presente con `displayFull` (ver esa constante en `PrestashopQueryParams`), y solo
   * cuando el avoir cubre productos: un avoir 100% de envío (verificado en el pedido 705570,
   * avoir 72384) no trae esta clave en absoluto.
   */
  associations?: {
    order_slip_details?: OrderSlipDetailRecord[];
  };
}

interface CustomerMessageRecord {
  id: number;
  id_customer_thread: number;
  /** Presente y > 0 cuando lo escribió un empleado; ausente/0 cuando lo escribió el cliente. */
  id_employee: string | number | null;
  message: string;
  date_add: string;
  /**
   * Viaja como string ("0"/"1"), igual que el resto de campos no-`id`. Verificado contra
   * producción (§ hallazgos de la tarea): todo apunte interno, nota de pago y buena parte de las
   * respuestas de la tienda tienen `private = 1`; ningún apunte interno se vio jamás en `0`. Es la
   * barrera real entre un mensaje y Lia — ver `isPublicMessage`.
   */
  private: string | number | boolean | null | undefined;
}

interface CartRuleRecord {
  id: number;
  code: string;
  /** `"0000-00-00 00:00:00"` cuando el vale no caduca: `parsePrestashopDate` lo trata como `null`. */
  date_to: string;
  active: string | boolean;
}

/**
 * Dirección de entrega (`addresses/{id}`). A propósito NUNCA se piden `address1`/`address2`
 * (la calle y el número): el agente no necesita el domicilio exacto para responder, y es un
 * dato personal de más en el contexto de un modelo. Con `city`/`postcode`/país y, si aplica,
 * el nombre del punto de recogida, alcanza.
 */
interface AddressRecord {
  id: number;
  alias: string;
  company: string | null;
  city: string;
  postcode: string;
  /** `id_*`, viaja como string: normalizar con `toNumericId`. */
  id_country: string | number;
}

interface CountryRecord {
  id: number;
  iso_code: string;
}

interface OrderPaymentRecord {
  id: number;
  amount: string | number;
  payment_method: string;
  /** Enmascarado por PrestaShop (ej. `"497355XXXXXX8929"`). Solo se conservan los últimos 4. */
  card_number: string | null;
  date_add: string;
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
  "id_address_delivery",
  "id_address_invoice",
] as const;

const ORDER_STATE_FIELDS = ["id", "name"] as const;
const ORDER_DETAIL_FIELDS = ["id", "product_id", "product_attribute_id", "product_name", "product_quantity"] as const;
const PRODUCT_FIELDS = ["id", "manufacturer_name"] as const;
const STOCK_FIELDS = ["id", "id_product", "id_product_attribute", "quantity"] as const;
const ORDER_CARRIER_FIELDS = ["id", "id_order", "id_carrier", "tracking_number"] as const;
const CARRIER_FIELDS = ["id", "name", "url", "delay"] as const;
const ORDER_HISTORY_FIELDS = ["id", "id_order_state", "date_add"] as const;
const CUSTOMER_THREAD_FIELDS = ["id", "id_order", "email", "status", "date_add", "date_upd"] as const;
// `order_slip` ya no usa una whitelist de `display=[...]`: se pide con `displayFull` (ver esa
// constante en `PrestashopQueryParams`), la única forma verificada de traer
// `associations.order_slip_details` sin colgar la petición.
const CUSTOMER_MESSAGE_FIELDS = ["id", "id_customer_thread", "id_employee", "message", "date_add", "private"] as const;
const CART_RULE_FIELDS = ["id", "code", "date_to", "active"] as const;
const ADDRESS_FIELDS = ["id", "alias", "company", "city", "postcode", "id_country"] as const;
const COUNTRY_FIELDS = ["id", "iso_code"] as const;
const ORDER_PAYMENT_FIELDS = ["id", "amount", "payment_method", "card_number", "date_add"] as const;

/** Estado 61 "Retour Terminé": la única señal fiable de retorno físico completado (§ hallazgos de la tarea). */
const RETURN_COMPLETED_STATE_ID = 61;

/**
 * El webservice no expone `order_returns`; en vez de fingir el dato, se documenta acá la limitación,
 * en inglés y dirigida al agente (§ hallazgo de producción: un agente con una pregunta sobre un
 * retorno en curso presentó el tracking DE IDA como si fuera el de la devolución, dos veces, en la
 * conversación VJWIRCHVQ). El texto anterior explicaba el porqué en español y para el equipo; este
 * le dice a Lia qué puede y qué no puede hacer.
 */
const RETURN_DATA_UNAVAILABLE_REASON =
  "Returns in progress are not visible to this service: only a completed return can be detected, " +
  "through the order state. If the customer asks about a return that is under way, say plainly that " +
  "you cannot see its status and answer with guidance.return_inquiry when it is present (it holds the " +
  "approved text on how returns are processed); do not send the customer to customer service by default. " +
  "Never use the shipping tracking number as if it were the return's.";

/**
 * Moneda de la tienda. El pedido solo trae `id_currency`; resolver el código ISO exigiría un recurso
 * adicional (`currencies/{id}`) que no está en las olas de esta tarea. Esta tienda es monomoneda EUR
 * (ver `CatalogProduct.currency` en `src/types/index.ts`), así que se fija el mismo valor aquí en vez
 * de inventar una llamada extra para un dato que no varía. Documentado en el reporte de la tarea.
 */
const DEFAULT_CURRENCY = "EUR";

/**
 * Prefijo verificado de las notas automáticas del módulo de pago (3D Secure / IPN). En la muestra
 * verificada contra producción, las 288 notas de pago observadas tenían `id_employee = 0` y
 * `private = 1`: el filtro de `private` (ver `isPublicMessage`) ya las descarta antes de llegar
 * acá. Esta comprobación por contenido queda como segunda barrera, por si alguna vez llegara una
 * nota de pago con `private = 0`: nunca debe leerse como conversación real ni tapar el mensaje
 * real anterior.
 */
const PAYMENT_MODULE_NOTE_PREFIX = "Action successfully completed";

/** Un mensaje de conversación real no es cliente esperando > este umbral. */
const AWAITING_REPLY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Alias verificados de "mi dirección" (entrega a domicilio genérica), normalizados sin acentos
 * y en minúsculas con `normalizeForMatch` antes de comparar. Solo los dos verificados contra la
 * API real (tabla `addresses`): no se inventan variantes de otros idiomas sin comprobar. Un
 * alias que no matchea ninguno de estos, en un pedido a relay (`id_address_delivery !==
 * id_address_invoice`), se toma como el nombre del punto de recogida.
 */
const GENERIC_ADDRESS_ALIASES = new Set(["mon adresse", "mi direccion"]);

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

/**
 * `true` si el autor del mensaje es el cliente: sin empleado asignado (o `0`). Se asume que
 * `message` ya pasó `isPublicMessage`: dentro de ese conjunto, `id_employee` es una señal fiable
 * (§ hallazgos verificados contra producción).
 */
function isFromCustomer(message: CustomerMessageRecord): boolean {
  return toNumber(message.id_employee) === 0;
}

/**
 * `true` únicamente cuando `private` llegó explícitamente en "0"/0/false: fail-closed, un valor
 * ausente o de otro tipo se trata como privado y el mensaje se descarta antes de llegar a Lia.
 * Verificado contra producción (§ hallazgos de la tarea): ningún apunte interno se vio jamás con
 * `private = 0`, así que este flag es la barrera real.
 */
function isPublicMessage(message: CustomerMessageRecord): boolean {
  const raw = message.private;
  return raw === "0" || raw === 0 || raw === false;
}

// ─── Autoría de un mensaje público ──────────────────────────────────────────
//
// Antes hacía falta una cascada por contenido: en el hilo 185221 del pedido YOGGHZYXI, un mensaje
// con `id_employee = 28` (un empleado real) tenía contenido evidentemente del cliente -se queja de
// su propio pedido y firma "Yamine Priem"-, porque alguien de la tienda pegó el correo del cliente
// dentro del hilo. Verificado contra producción (§ hallazgos de la tarea): ese tipo de mensaje
// pegado llega con `private = 1`, igual que todo apunte interno, así que `isPublicMessage` ya lo
// descarta antes de que la autoría importe. Dentro del conjunto público que queda, `id_employee` es
// una señal fiable (0/ausente = cliente, >0 = tienda): la cascada por texto quedó sin objeto.

/**
 * Quita acentos (NFD + strip de diacríticos) y normaliza comillas tipográficas antes de comparar,
 * para que variantes acentuadas o con apóstrofo curvo casen igual. Usado por `isGenericAddressAlias`.
 */
function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[‘’]/g, "'")
    .toLowerCase();
}

/**
 * Autoría de un mensaje ya filtrado por `isPublicMessage`. Dentro del conjunto público,
 * `id_employee` es fiable (§ hallazgos verificados): 0/ausente = cliente, >0 = tienda, siempre
 * `authorCertain: true`. La nota del módulo de pago (`isPaymentModuleNote`) sigue siendo una
 * segunda barrera, por si alguna vez llegara una con `private = 0`.
 */
function inferMessageAuthor(message: CustomerMessageRecord): { author: MessageAuthor; authorCertain: boolean } {
  if (isPaymentModuleNote(message.message)) return { author: "SYSTEM", authorCertain: true };
  return { author: isFromCustomer(message) ? "CUSTOMER" : "SHOP", authorCertain: true };
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

export interface ConsolidatedStatusChange {
  stateId: number;
  /** Grupo al que mapea (§2.1 del documento de reglas), o `"D"` si el estado no está mapeado. */
  group: StateGroup;
  date: Date;
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
  /** Historial de cambios de estado (`order_histories`), ordenado cronológicamente ascendente. */
  timeline: ConsolidatedStatusChange[];
  /** Dirección de entrega, sin calle ni número (ver `ConsolidatedAddress`). */
  deliveryAddress: ConsolidatedAddress;
}

/**
 * Dirección de entrega, deliberadamente sin calle ni número: el agente no necesita el domicilio
 * exacto para responder, y es un dato personal de más en el contexto de un modelo.
 */
export interface ConsolidatedAddress {
  /** Alias del punto de recogida, o `null` si es entrega a domicilio. Ej: "COLISSIMO POINT PICKUP 24085". */
  pickupPointName: string | null;
  city: string;
  postcode: string;
  countryId: number;
  /** Código ISO del país (`countries.iso_code`), ej. "FR", "BE". `null` si no se pudo resolver. */
  countryIso: string | null;
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
  /**
   * Siempre `OUTBOUND`: es el envío de la tienda AL cliente. El servicio no puede
   * ver los envíos de retorno (`order_returns` no existe en el webservice), así que
   * nunca hay un tracking de vuelta acá. Se etiqueta explícitamente porque un
   * agente con una pregunta sobre retornos delante confundió los dos.
   */
  direction: "OUTBOUND";
  carrierName: string | null;
  /** `null` si no hay número real en ninguna de las dos fuentes (`orders.shipping_number` u `order_carriers.tracking_number`). */
  trackingNumber: string | null;
  /** URL del transportista con `@` sustituido por el número. `null` si falta el número o la URL. Nunca se inventa un patrón. */
  trackingUrl: string | null;
  /** El estado implica expedido (grupo B o C) pero no hay número de seguimiento en ninguna fuente. */
  shippedWithoutTracking: boolean;
  /** Fecha de la primera entrada en `order_histories` cuyo estado mapea a grupo B. `null` si nunca se alcanzó. */
  shippedAt: Date | null;
  /**
   * Plazo prometido por el transportista (`carriers.delay`), resuelto al idioma del cliente con
   * `resolveTranslatable`. `null` si no hay transportista conocido o el campo viene vacío. Prueba
   * concreta de por qué importa: en un pedido a EEUU, el texto resuelto ("5 a 9 días para el resto
   * del mundo") era justo lo que probaba el retraso.
   */
  carrierDelay: string | null;
}

export interface ConsolidatedRefund {
  /** Suma de `total_products_tax_incl + total_shipping_tax_incl` de todos los avoirs del pedido. */
  amount: number;
  type: "VOUCHER" | "MONEY";
  /** Caducidad del vale (`cart_rules.date_to`). `null` si es dinero, o si el vale no caduca. */
  voucherExpiresAt: Date | null;
  /** Fecha del avoir más reciente (`order_slip.date_add`). */
  processedDate: Date;
  /**
   * Qué líneas del pedido cubrió cada avoir, cruzado por `id_order_detail`. Puede quedar vacío
   * (un avoir 100% de envío no tiene líneas asociadas). El prompt de la tarea tipa `name` como
   * `string`, pero su propio texto pide `name: null` cuando la línea no cruza: se resuelve la
   * contradicción a favor del texto, que es más específico.
   */
  lines: ConsolidatedRefundLine[];
}

export interface ConsolidatedRefundLine {
  /** `null` cuando `id_order_detail` no aparece entre las líneas del pedido: nunca se descarta la línea. */
  name: string | null;
  quantity: number;
  amount: number;
}

export interface ConsolidatedReturn {
  dataAvailable: false;
  reason: string;
  /** `current_state === 61` ("Retour Terminé"), la única señal fiable verificada. */
  completed: boolean;
}

export type MessageAuthor = "CUSTOMER" | "SHOP" | "SYSTEM";

export interface ConsolidatedMessage {
  date: Date;
  author: MessageAuthor;
  /**
   * Siempre `true`: solo los mensajes públicos (`private = 0`, ver `isPublicMessage`) llegan hasta
   * acá, y dentro de ese conjunto `id_employee` es una señal fiable. Se conserva el campo (en vez
   * de quitarlo) para no cambiar el contrato HTTP del payload.
   */
  authorCertain: boolean;
  text: string;
  threadId: number;
}

/** Cuántos mensajes recientes viajan en `ConsolidatedConversation.messages`. */
const MAX_RECENT_MESSAGES = 10;

export interface ConsolidatedConversation {
  threadId: number | null;
  lastMessage: string | null;
  lastMessageDate: Date | null;
  /**
   * El último mensaje PÚBLICO (ver `isPublicMessage`; nunca uno privado, y nunca una nota del
   * módulo de pago) es del cliente, con autoría por `id_employee` (fiable dentro del conjunto
   * público), y pasaron más de 24 horas sin respuesta. No está en el documento de reglas: se
   * agrega porque en 4 de 6 casos reales auditados el dato que resolvía la consulta estaba en el
   * hilo, no en el pedido.
   */
  awaitingShopReply: boolean;
  /**
   * Últimos `MAX_RECENT_MESSAGES` mensajes PÚBLICOS del pedido (ver `isPublicMessage`), fusionados
   * de TODOS sus hilos (un pedido puede tener más de uno: el 704330 tenía dos) y ordenados
   * cronológicamente ascendente. Nunca incluye apuntes internos, correos pegados por staff, ni
   * notas automáticas del módulo de pago.
   */
  messages: ConsolidatedMessage[];
}

export interface ConsolidatedPayment {
  /** `order_payments.payment_method` (ej. "Paiement CB", "PayPal"). `null` si viene vacío. */
  method: string | null;
  /** Últimos 4 dígitos de `card_number`, o `null` si no fue tarjeta (o no hay pago). NUNCA el número completo, ni siquiera enmascarado. */
  cardLast4: string | null;
  amount: number;
  date: Date | null;
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
  /** `null` cuando el pedido no tiene ningún pago registrado en `order_payments`. */
  payment: ConsolidatedPayment | null;
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
    if (stateGroups.get(toNumericId(history.id_order_state)) !== "B") continue;
    const date = parsePrestashopDate(history.date_add);
    if (date === null) continue;
    if (earliest === null || date.getTime() < earliest.getTime()) earliest = date;
  }
  return earliest;
}

/**
 * Fecha en que el pedido entró más recientemente al grupo R (retorno terminado, §3.2; hoy solo el
 * estado 61). A diferencia de `computeShippedAt` (la PRIMERA entrada al grupo B), acá se quiere la
 * ÚLTIMA: si el pedido entró en 61 más de una vez, el texto A.6 del equipo habla de la recepción
 * más reciente del paquete, no de la primera (§ hallazgo "Estado 61 timing" del task doc). `null`
 * si el pedido nunca entró al grupo R.
 */
function computeReturnEnteredAt(histories: OrderHistoryRecord[], stateGroups: Map<number, StateGroup>): Date | null {
  let latest: Date | null = null;
  for (const history of histories) {
    if (stateGroups.get(toNumericId(history.id_order_state)) !== "R") continue;
    const date = parsePrestashopDate(history.date_add);
    if (date === null) continue;
    if (latest === null || date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

/**
 * Timeline de cambios de estado del pedido (`order_histories`), ordenado cronológicamente
 * ascendente. No se consulta `order_states` por cada entrada para resolver un nombre -sería una
 * llamada HTTP por estado-: con el id y el grupo alcanza para que Lia razone sobre "cuánto lleva en
 * este estado"; el nombre del estado ACTUAL ya viaja en `order.status.name`. Motivo concreto: en el
 * pedido YOGGHZYXI el cliente pregunta desde cuándo está en tratamiento, y el historial dice que
 * entró en el estado 17 el 14/09 y no se movió. Ese dato ya se consultaba y no salía.
 */
function computeTimeline(
  histories: OrderHistoryRecord[],
  stateGroups: Map<number, StateGroup>
): ConsolidatedStatusChange[] {
  return histories
    .map((history) => {
      const stateId = toNumericId(history.id_order_state);
      return {
        stateId,
        group: stateGroups.get(stateId) ?? ("D" as StateGroup),
        date: parsePrestashopDate(history.date_add),
      };
    })
    .filter((entry): entry is ConsolidatedStatusChange => entry.date !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
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
  stateGroups: Map<number, StateGroup>,
  idLang: number
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

  const resolvedDelay = sourceCarrier !== null ? resolveTranslatable(sourceCarrier.delay, idLang) : null;
  const carrierDelay = resolvedDelay !== null && !isBlank(resolvedDelay) ? resolvedDelay : null;

  return {
    direction: "OUTBOUND",
    carrierName: sourceCarrier?.name ?? null,
    trackingNumber,
    trackingUrl,
    shippedWithoutTracking,
    shippedAt: computeShippedAt(histories, stateGroups),
    carrierDelay,
  };
}

// ─── Dirección de entrega ───────────────────────────────────────────────

/** Trae `addresses/{id}` tolerando que ya no exista (404): degrada, igual que `fetchCarrierSafe`. */
async function fetchAddressSafe(id: number): Promise<AddressRecord | null> {
  try {
    return await getOne<AddressRecord>("addresses", id, { display: ADDRESS_FIELDS });
  } catch (err) {
    if (err instanceof PrestashopNotFoundError) return null;
    throw err;
  }
}

/** `true` si `alias` (ya con contenido real) es uno de los genéricos verificados de "mi dirección". */
function isGenericAddressAlias(alias: string): boolean {
  return GENERIC_ADDRESS_ALIASES.has(normalizeForMatch(alias).trim());
}

/**
 * Caché en memoria, por proceso, de `countries.id -> iso_code`: los países no cambian y no tiene
 * sentido repetir la consulta para dos pedidos (o dos líneas) del mismo país. Solo se cachea un
 * resultado definitivo (éxito o "no existe"); un fallo transitorio nunca se cachea, para que el
 * próximo pedido lo reintente en vez de quedar con `null` pegado por una caída puntual de la API.
 */
const countryIsoCache = new Map<number, string | null>();

/** Resuelve `countries/{id}.iso_code`, cacheado por id durante el proceso. */
async function getCountryIso(countryId: number): Promise<string | null> {
  if (countryIsoCache.has(countryId)) return countryIsoCache.get(countryId) ?? null;

  let iso: string | null;
  try {
    const country = await getOne<CountryRecord>("countries", countryId, { display: COUNTRY_FIELDS });
    iso = isBlank(country.iso_code) ? null : country.iso_code.trim();
  } catch (err) {
    if (!(err instanceof PrestashopNotFoundError)) throw err;
    iso = null;
  }

  countryIsoCache.set(countryId, iso);
  return iso;
}

/**
 * Colapsa las barras invertidas sobrantes delante de comillas y apóstrofos.
 *
 * PrestaShop devuelve algunos textos sobre-escapados: el punto de recogida de un
 * pedido real llega como `TOTAL CHANT D\\\'OISEAU` cuando su nombre es
 * `TOTAL CHANT D'OISEAU`. No es inventar un dato, es deshacer un escape que la API
 * aplicó de más — y este texto lo lee un modelo que puede repetírselo al cliente.
 */
function unescapeApiText(value: string): string {
  return value.replace(/\\+(?=['"])/g, "");
}


/**
 * Resuelve la dirección de entrega consolidada. Nunca expone calle ni número (la whitelist de
 * `ADDRESS_FIELDS` ya los excluye): con población, código postal, país y, si aplica, el nombre
 * del punto de recogida alcanza para todo lo que se pregunta.
 *
 * Detección de punto de recogida (verificado contra pedidos reales: KKWNDFPHA en Bélgica,
 * "COLISSIMO POINT PICKUP 24085"/"TOTAL CHANT D'OISEAU"; LLKVUZDZD en Francia, "Point
 * ChronoRelais 130BX"/"Consigne Car Wash Vignelongue"): el pedido debe ser candidato a relay
 * (`id_address_delivery !== id_address_invoice`) Y el alias no debe ser uno de los genéricos de
 * "mi dirección". Sin la primera condición, una dirección de regalo con un alias cualquiera
 * ("Chez mamie") se leería como punto de recogida; sin la segunda, toda entrega a una dirección
 * distinta de la de facturación (un regalo real) se leería como relay. El nombre a mostrar
 * prefiere `company` (el nombre comercial del punto) sobre el alias crudo, cuando está presente.
 */
function computeDeliveryAddress(
  address: AddressRecord | null,
  isDeliveryDifferentFromInvoice: boolean,
  countryIso: string | null
): ConsolidatedAddress {
  if (address === null) {
    // No debería ocurrir en un pedido real (la dirección de entrega es la del propio pedido),
    // pero se degrada igual que un transportista 404: nunca tumba la consolidación entera por
    // un dato secundario. Documentado como decisión no cubierta explícitamente por el prompt.
    return { pickupPointName: null, city: "", postcode: "", countryId: 0, countryIso: null };
  }

  const alias = address.alias ?? "";
  const isPickupPoint = isDeliveryDifferentFromInvoice && !isBlank(alias) && !isGenericAddressAlias(alias);
  const rawPickupName = isPickupPoint ? (firstNonBlank(address.company) ?? alias.trim()) : null;
  const pickupPointName = rawPickupName === null ? null : unescapeApiText(rawPickupName);

  return {
    pickupPointName,
    city: address.city?.trim() ?? "",
    postcode: address.postcode?.trim() ?? "",
    countryId: toNumericId(address.id_country),
    countryIso,
  };
}

// ─── Pago ─────────────────────────────────────────────────────────────────

/**
 * Resuelve el pago consolidado. `card_number` llega enmascarado (ej. `"497355XXXXXX8929"`);
 * solo se conservan los últimos 4 caracteres, nunca la cadena completa, ni siquiera enmascarada.
 * `null` si no hay ningún pago registrado (verificado: `order_payments` puede no traer nada) o si
 * el medio de pago no es tarjeta (ej. PayPal, verificado con `card_number` en `""`).
 *
 * Si hubiera más de un pago para el pedido (no observado en los pedidos verificados), se toma el
 * más reciente por `date_add`: no hay en el prompt un criterio de agregación, y sumar importes de
 * medios de pago distintos en un solo `method`/`cardLast4` mezclaría datos de dos eventos reales
 * en uno que no existió. Decisión no cubierta explícitamente por el prompt.
 */
function computePayment(payments: OrderPaymentRecord[]): ConsolidatedPayment | null {
  if (payments.length === 0) return null;

  const latest = [...payments].sort(
    (a, b) => (parsePrestashopDate(a.date_add)?.getTime() ?? 0) - (parsePrestashopDate(b.date_add)?.getTime() ?? 0)
  ).at(-1)!;

  const cardNumber = latest.card_number;
  const cardLast4 = !isBlank(cardNumber) && cardNumber!.trim().length >= 4 ? cardNumber!.trim().slice(-4) : null;

  return {
    method: firstNonBlank(latest.payment_method),
    cardLast4,
    amount: toNumber(latest.amount),
    date: parsePrestashopDate(latest.date_add),
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
 * que la IA interpreta el historial para los mails 6 y 7; acá no se adivina). Se calcula solo sobre
 * mensajes PÚBLICOS (`isPublicMessage`): un apunte interno o un correo pegado por staff no cuenta
 * como "hay información en el historial", ni aunque contuviera datos reales, porque nunca llega a
 * Lia:
 *
 * - Si NINGÚN mensaje público del pedido (en ningún hilo) es real —todos son notas automáticas del
 *   módulo de pago, o no hay mensajes públicos en absoluto— el historial se declara mecánicamente
 *   vacío: `false`. Eso habilita el mail 7.
 * - Si hay al menos un mensaje público real, no se afirma que contenga productos pendientes o un
 *   plazo: se devuelve `null`, que el evaluador de la matriz trata como "no lo sé" y escala. En fase
 *   1, esto implica que el Grupo C con historial no vacío escala siempre, aunque el mensaje real no
 *   aporte nada útil: es preferible a inventar una lectura del contenido.
 */
function computeHistoryHasInfo(allMessages: CustomerMessageRecord[]): boolean | null {
  const hasPublicRealMessage = allMessages.some((m) => isPublicMessage(m) && !isPaymentModuleNote(m.message));
  return hasPublicRealMessage ? null : false;
}

/**
 * Fusiona los mensajes PÚBLICOS (`isPublicMessage`) y reales (sin notas del módulo de pago) de
 * TODOS los hilos del pedido, con autoría por `inferMessageAuthor`, ordenados cronológicamente
 * ascendente. `allMessages` ya viene de todos los hilos del pedido (ola 3 de `consolidateOrder`),
 * así que no hace falta recorrer hilo por hilo. Un mensaje privado (apunte interno, correo de
 * cliente pegado por staff, o cualquier otro con `private` distinto de "0"/0/false) nunca llega a
 * este resultado: es la corrección del incidente de producción en que esos apuntes se leyeron al
 * cliente.
 */
function buildConversationMessages(allMessages: CustomerMessageRecord[]): ConsolidatedMessage[] {
  return allMessages
    .filter(isPublicMessage)
    .map((message) => {
      const { author, authorCertain } = inferMessageAuthor(message);
      return {
        date: parsePrestashopDate(message.date_add) ?? new Date(0),
        author,
        authorCertain,
        text: message.message,
        threadId: toNumericId(message.id_customer_thread),
      };
    })
    .filter((message) => message.author !== "SYSTEM")
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

function computeConversation(
  primaryThread: CustomerThreadRecord | null,
  messagesByThread: Map<number, CustomerMessageRecord[]>,
  allMessages: CustomerMessageRecord[],
  today: Date
): ConsolidatedConversation {
  const conversationMessages = buildConversationMessages(allMessages);
  const recentMessages = conversationMessages.slice(-MAX_RECENT_MESSAGES);

  const lastReal = conversationMessages.at(-1) ?? null;
  const awaitingShopReply =
    lastReal !== null &&
    lastReal.author === "CUSTOMER" &&
    today.getTime() - lastReal.date.getTime() > AWAITING_REPLY_THRESHOLD_MS;

  if (primaryThread === null) {
    return { threadId: null, lastMessage: null, lastMessageDate: null, awaitingShopReply, messages: recentMessages };
  }

  // Filtrado por `isPublicMessage`: sin esto, `lastMessage`/`lastMessageDate` podrían exponer el
  // texto de un apunte interno o de un correo pegado por staff, aunque `messages` ya esté filtrado.
  const primaryMessages = (messagesByThread.get(primaryThread.id) ?? []).filter(isPublicMessage);
  const sorted = [...primaryMessages].sort(
    (a, b) => (parsePrestashopDate(a.date_add)?.getTime() ?? 0) - (parsePrestashopDate(b.date_add)?.getTime() ?? 0)
  );
  const last = sorted.at(-1) ?? null;

  return {
    threadId: primaryThread.id,
    lastMessage: last?.message ?? null,
    lastMessageDate: last !== null ? parsePrestashopDate(last.date_add) : null,
    awaitingShopReply,
    messages: recentMessages,
  };
}

// ─── Reembolso: vale o dinero ─────────────────────────────────────────────

/**
 * Cruza las líneas de todos los avoirs (`order_slip.associations.order_slip_details`, solo
 * presentes con `displayFull`) contra las líneas del pedido, por `id_order_detail` normalizado.
 * Un avoir 100% de envío no trae ninguna línea (no tiene `associations` en absoluto: verificado
 * en el pedido 705570, avoir 72384) y no aporta nada acá.
 *
 * Si un `id_order_detail` no aparece entre las líneas del pedido, la línea se incluye igual con
 * `name: null` — nunca se descarta en silencio, para no ocultar que hay un importe abonado sin
 * poder decir de qué producto.
 */
function buildRefundLines(slips: OrderSlipRecord[], orderLines: OrderDetailRecord[]): ConsolidatedRefundLine[] {
  const nameByDetailId = new Map(orderLines.map((line) => [toNumericId(line.id), line.product_name] as const));

  const lines: ConsolidatedRefundLine[] = [];
  for (const slip of slips) {
    for (const detail of slip.associations?.order_slip_details ?? []) {
      lines.push({
        name: nameByDetailId.get(toNumericId(detail.id_order_detail)) ?? null,
        quantity: toNumber(detail.product_quantity),
        amount: toNumber(detail.amount_tax_incl),
      });
    }
  }
  return lines;
}

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
  orderId: number,
  orderLines: OrderDetailRecord[]
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

  const lines = buildRefundLines(slips, orderLines);

  const matchingRule = cartRules.find(
    (rule) => toBool(rule.active) && rule.code === `V${rule.id}C${customerId}O${orderId}`
  );

  if (matchingRule !== undefined) {
    return {
      amount,
      type: "VOUCHER",
      voucherExpiresAt: parsePrestashopDate(matchingRule.date_to),
      processedDate,
      lines,
    };
  }

  return { amount, type: "MONEY", voucherExpiresAt: null, processedDate, lines };
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
  // La dirección de entrega solo puede pedirse acá: depende de `header.id_address_delivery`,
  // recién resuelto en la ola 1. `order_payments` solo depende de `header.reference`, ya
  // conocida también desde la ola 1 (misma razón por la que no se sumó como una cuarta ola).
  const [products, stocks, shippingSources, histories, threads, slips, deliveryAddressRecord, payments] =
    await Promise.all([
      fetchBatch<ProductBrandRecord>("products", productIds, "id", PRODUCT_FIELDS),
      fetchBatch<StockAvailableRecord>("stock_availables", attributeIds, "id_product_attribute", STOCK_FIELDS),
      fetchShippingSources(orderId),
      getMany<OrderHistoryRecord>("order_histories", { filter: { id_order: orderId }, display: ORDER_HISTORY_FIELDS }),
      getMany<CustomerThreadRecord>("customer_threads", {
        filter: { id_order: orderId },
        display: CUSTOMER_THREAD_FIELDS,
      }),
      // `displayFull`, no una whitelist: ver el comentario de esa opción en `PrestashopQueryParams`.
      getMany<OrderSlipRecord>("order_slip", { filter: { id_order: orderId }, displayFull: true }),
      fetchAddressSafe(toNumericId(header.id_address_delivery)),
      getMany<OrderPaymentRecord>("order_payments", {
        filter: { order_reference: header.reference },
        display: ORDER_PAYMENT_FIELDS,
      }),
    ]);

  // ─── Ola 3 ──────────────────────────────────────────────────────────
  // `cart_rules` solo hace falta si hay al menos un avoir que clasificar: sin avoir no hay nada que
  // distinguir entre vale y dinero. `countries` solo puede pedirse acá: depende de
  // `deliveryAddressRecord.id_country`, recién resuelto en la ola 2.
  const threadIds = threads.map((t) => t.id);
  const [allMessages, cartRules, countryIso] = await Promise.all([
    fetchBatch<CustomerMessageRecord>("customer_messages", threadIds, "id_customer_thread", CUSTOMER_MESSAGE_FIELDS),
    slips.length > 0
      ? getMany<CartRuleRecord>("cart_rules", { filter: { id_customer: customerId }, display: CART_RULE_FIELDS })
      : Promise.resolve<CartRuleRecord[]>([]),
    deliveryAddressRecord !== null
      ? getCountryIso(toNumericId(deliveryAddressRecord.id_country))
      : Promise.resolve<string | null>(null),
  ]);

  // ─── Ensamblado ─────────────────────────────────────────────────────

  // `id_customer_thread` llega como string ("184425") aunque el tipo diga number, y el mapa se
  // consulta con `thread.id`, que sí es numérico: sin normalizar la clave, ningún hilo encontraba
  // sus mensajes, `lastMessage` salía siempre null y el hilo "más activo" se elegía a ciegas.
  const messagesByThread = new Map<number, CustomerMessageRecord[]>();
  for (const message of allMessages) {
    const threadId = toNumericId(message.id_customer_thread);
    const bucket = messagesByThread.get(threadId);
    if (bucket) {
      bucket.push(message);
    } else {
      messagesByThread.set(threadId, [message]);
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

  const shipping = computeShipping(header, shippingSources, group, histories, stateGroups, input.customer.idLang);
  const timeline = computeTimeline(histories, stateGroups);
  const refund = computeRefund(slips, cartRules, customerId, orderId, lines);
  const isDeliveryDifferentFromInvoice =
    toNumericId(header.id_address_delivery) !== toNumericId(header.id_address_invoice);
  const deliveryAddress = computeDeliveryAddress(deliveryAddressRecord, isDeliveryDifferentFromInvoice, countryIso);
  const payment = computePayment(payments);
  const primaryThread = pickPrimaryThread(threads, messagesByThread);
  const conversation = computeConversation(primaryThread, messagesByThread, allMessages, input.today);
  const historyHasInfo = computeHistoryHasInfo(allMessages);
  // `refund !== null`: el hecho que decide entre las dos filas del grupo R (MAIL_12/MAIL_10, §3.2)
  // y entre las dos prohibiciones dinámicas de reembolso en `buildGuidance`. Siempre se conoce
  // (el avoir existe o no existe), a diferencia de `historyHasInfo`.
  const refundIssued = refund !== null;
  const returnEnteredAt = computeReturnEnteredAt(histories, stateGroups);

  const facts: OrderFactsInput = {
    orderDate,
    stateId: currentStateId,
    trackingNumber,
    lines: factsLines,
    historyHasInfo,
    today: input.today,
    refundIssued,
    returnEnteredAt,
  };

  const orderContext: GuidanceOrderContext = {
    reference: header.reference,
    idLang: input.customer.idLang,
    trackingUrl: shipping.trackingUrl,
  };

  // Mismo valor que `return.dataAvailable` más abajo: una sola fuente de verdad para
  // que `buildGuidance` sepa que no puede verse el estado de un retorno en curso. El
  // día que exista un módulo que exponga `order_returns`, este valor pasa a `true` y
  // la prohibición que agrega `buildGuidance` en `must_not_claim` deja de aplicarse sola.
  const returnDataAvailable: false = false;

  // Forma mínima que `resolveFactValue`/`buildGuidance` necesitan (`GuidanceRefundContext`), no el
  // `ConsolidatedRefund` completo: ese tipo vive en este módulo, y `rule-evaluator.ts` no puede
  // importarlo sin crear un ciclo (ver el JSDoc de `GuidanceRefundContext`).
  const guidanceRefund: GuidanceRefundContext | null =
    refund !== null
      ? { type: refund.type, voucherExpiresAt: refund.voucherExpiresAt, lineNames: refund.lines.map((l) => l.name) }
      : null;

  const extraContext: GuidanceExtraContext = {
    pendingProducts: null,
    additionalDelay: null,
    processedDate: refund?.processedDate ?? null,
    refund: guidanceRefund,
    returnDataAvailable,
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
      timeline,
      deliveryAddress,
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
      dataAvailable: returnDataAvailable,
      reason: RETURN_DATA_UNAVAILABLE_REASON,
      completed: currentStateId === RETURN_COMPLETED_STATE_ID,
    },
    conversation,
    payment,
    facts,
    orderContext,
    extraContext,
  };
}
