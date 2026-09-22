export interface ProductSearchInput {
  type: string | string[];
  size?: string | string[];
  gender?: "female" | "male";
  brand?: string | string[];
  color?: string | string[];
  material?: string | string[];
  max_price?: number;
  min_price?: number;
  sub_type?: string | string[];
  category?: string | string[];
  /** % mínimo de la fibra pedida en `material` (cuerpo o forro). Requiere `material`. */
  min_material_pct?: number;
}

export interface MaterialComposition {
  fiber: string;
  pct: number;
  zone: string;
}

export interface SizeGuideInput {
  product_type: string;
  brand?: string;
}

export interface StorePoliciesInput {
  topic: string;
}

/**
 * Producto en el formato de la convención de microservicios
 * (docs/convencion-productos-microservicios.md). Tres cajones: núcleo (siempre se
 * pinta), `attributes` (se pinta, ordenado y recortable) y `details` (nunca se
 * pinta: contexto para el modelo).
 */
export interface CatalogProduct {
  id: string;
  title: string;
  /** Marca o línea. Va bajo el título. */
  subtitle?: string;
  /** URL de UNA imagen, no un array. */
  image: string;
  url: string;
  /** Número crudo, sin símbolos ni separadores: lo formatea quien lo pinta. */
  price: number;
  /** Código ISO de moneda (EUR). */
  currency: string;
  /** Precio anterior. Solo viaja si es mayor que `price` → se pinta el descuento. */
  oldPrice?: number;
  /** `false` oculta el producto en el render. */
  available: boolean;
  /** Ordenados por importancia, con etiqueta y valor ya escritos. */
  attributes: ProductAttribute[];
  details: ProductDetails;
}

/** Par etiqueta/valor que se pinta tal cual en la ficha. */
export interface ProductAttribute {
  label: string;
  value: string;
}

/** Lo que no se pinta pero el modelo necesita para responder preguntas. */
export interface ProductDetails {
  baseProductId: string;
  stock: number;
  type?: string;
  subType?: string;
  /** Composición cruda tal y como llega de Prestashop. */
  rawMaterial?: string;
  composition?: MaterialComposition[];
  categories?: string[];
  description?: string;
}

export interface ProductSearchResponse {
  products: CatalogProduct[];
  total: number;
  filters_applied: ProductSearchInput;
  suggestion?: string;
}

// ─── Validación de identidad de pedidos (lia-order-lookup) ────────────────

/**
 * Entrada de la validación de identidad. La referencia es el filtro de
 * búsqueda; el email solo valida que quien pregunta es el dueño del pedido.
 */
export interface OrderIdentityInput {
  reference: string;
  email: string;
}

/** Resultado posible de `verifyOrderIdentity`, discriminado por `outcome`. */
export type OrderIdentityOutcome =
  | "VERIFIED"
  | "IDENTITY_NOT_VERIFIED"
  | "AMBIGUOUS_REFERENCE"
  | "SERVICE_UNAVAILABLE";

/** Datos mínimos del pedido que viajan una vez verificada la identidad. */
export interface VerifiedOrderData {
  id: number;
  reference: string;
  dateAdd: string;
  currentState: number;
  valid: boolean;
}

/** Datos mínimos del cliente que viajan una vez verificada la identidad. */
export interface VerifiedCustomerData {
  id: number;
  email: string;
  firstname: string;
  lastname: string;
  idLang: number;
}

/** Identidad verificada: única rama que lleva datos del pedido y del cliente. */
export interface VerifiedOrderIdentity {
  outcome: "VERIFIED";
  order: VerifiedOrderData;
  customer: VerifiedCustomerData;
}

/**
 * Respuesta negativa uniforme. Referencia inexistente y email que no coincide
 * devuelven exactamente este mismo objeto, sin eco de la referencia, del email
 * ni de ningún dato del pedido: distinguir el motivo permitiría enumerar
 * datos personales de clientes probando referencias.
 */
export interface UnverifiedOrderIdentity {
  outcome: "IDENTITY_NOT_VERIFIED" | "AMBIGUOUS_REFERENCE" | "SERVICE_UNAVAILABLE";
}

/** Resultado discriminado de la validación de identidad de un pedido. */
export type OrderIdentityResult = VerifiedOrderIdentity | UnverifiedOrderIdentity;

// ─── Handler HTTP: POST /order_lookup (T11) ────────────────────────────────

/** Cuerpo de entrada de `POST /order_lookup`. */
export interface OrderLookupRequestBody {
  reference: string;
  email: string;
}

/**
 * Negativo uniforme de identidad: una sola forma para "referencia inexistente"
 * y "email ajeno" (RGPD). Nunca lleva la referencia, el email ni ningún dato
 * del pedido.
 */
export interface OrderLookupIdentityNotVerifiedResponse {
  found: false;
  identity_verified: false;
  outcome: "IDENTITY_NOT_VERIFIED";
}

/** Más de un pedido comparte la referencia: se escala, nunca se elige uno al azar. */
export interface OrderLookupAmbiguousResponse {
  found: false;
  identity_verified: false;
  outcome: "AMBIGUOUS_REFERENCE";
  must_escalate: true;
  escalate_reason: string;
}

export interface OrderLookupOrderView {
  id: number;
  reference: string;
  dateAdd: Date;
  status: { id: number; name: string };
  /** Grupo del árbol de decisión (§2.1): `A|B|C|D|R`. */
  group: string;
  totals: { totalPaid: number; shippingPaid: number };
  currency: string;
  /**
   * Cuándo entró el pedido en cada estado, en orden ascendente. Responde "¿desde
   * cuándo lleva así?", que es lo que pregunta el cliente cuando un pedido se queda
   * quieto y el estado actual por sí solo no dice nada.
   */
  timeline: OrderLookupStatusChangeView[];
}

export interface OrderLookupStatusChangeView {
  stateId: number;
  /** Grupo al que mapea el estado, o `D` si no está mapeado. */
  group: string;
  date: Date;
}

/** Nunca lleva campos sensibles (`passwd`, `secure_key`, etc.): construido con campos explícitos. */
export interface OrderLookupCustomerView {
  firstname: string;
  lastname: string;
  email: string;
  idLang: number;
}

export interface OrderLookupLineView {
  name: string;
  brand: string | null;
  quantity: number;
  stockQuantity: number | null;
  covered: boolean;
}

export interface OrderLookupShippingView {
  carrierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedWithoutTracking: boolean;
  shippedAt: Date | null;
  /** Plazo que promete el transportista, resuelto al idioma del cliente. */
  carrierDelay: string | null;
}

export interface OrderLookupRefundView {
  amount: number;
  type: "VOUCHER" | "MONEY";
  voucherExpiresAt: Date | null;
  processedDate: Date;
}

export interface OrderLookupReturnView {
  dataAvailable: false;
  reason: string;
  completed: boolean;
}

export interface OrderLookupConversationView {
  threadId: number | null;
  lastMessage: string | null;
  lastMessageDate: Date | null;
  awaitingShopReply: boolean;
  /**
   * Los últimos 10 mensajes reales de TODOS los hilos del pedido, en orden
   * cronológico y sin las notas automáticas del módulo de pago.
   *
   * Sin esto el agente no ve lo que ya se le dijo al cliente y se contradice: en el
   * pedido YOGGHZYXI la tienda había prometido "2 à 5 jours ouvrés" cuando la tabla
   * de plazos de la propia tienda dice 9 días para esa marca.
   */
  messages: OrderLookupMessageView[];
}

export interface OrderLookupMessageView {
  date: Date;
  /** `CUSTOMER` | `SHOP` | `SYSTEM`, deducido del contenido. */
  author: string;
  /**
   * `false` cuando la autoría se dedujo de `id_employee`, que no es fiable: se ha
   * visto a un empleado pegar el correo del cliente dentro del hilo.
   */
  authorCertain: boolean;
  text: string;
  threadId: number;
}

export interface OrderLookupGuidanceFactView {
  key: string;
  value: string;
}

/** El bloque que Lia usa para redactar la respuesta al cliente. */
export interface OrderLookupGuidanceView {
  situation: string;
  can_answer: boolean;
  must_escalate: boolean;
  escalate_reason: string | null;
  reply_language: string;
  facts_to_convey: OrderLookupGuidanceFactView[];
  must_not_claim: string[];
  reference_template: string | null;
  template_text: string | null;
  missing_facts: string[];
}

/** Camino feliz: identidad verificada y regla resuelta. */
export interface OrderLookupSuccessResponse {
  found: true;
  identity_verified: true;
  order: OrderLookupOrderView;
  customer: OrderLookupCustomerView;
  lines: OrderLookupLineView[];
  shipping: OrderLookupShippingView;
  refund: OrderLookupRefundView | null;
  return: OrderLookupReturnView;
  conversation: OrderLookupConversationView;
  guidance: OrderLookupGuidanceView;
}

/** Cuerpo de salida de `POST /order_lookup`, discriminado por `found`/`outcome`. */
export type OrderLookupResponseBody =
  | OrderLookupSuccessResponse
  | OrderLookupIdentityNotVerifiedResponse
  | OrderLookupAmbiguousResponse;
