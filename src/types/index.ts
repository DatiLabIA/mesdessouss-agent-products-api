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
