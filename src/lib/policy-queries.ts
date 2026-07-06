import { prisma } from "./prisma";

const CLIENT_ID = "mesdessous";

// Aliases para topics enviados en inglés/variantes → topic exacto en BD
export const TOPIC_ALIASES: Record<string, string> = {
  // ── Políticas de tienda ─────────────────────────────────────────────────
  delivery: "livraison",
  shipping: "livraison",
  envio: "livraison",
  envíos: "livraison",

  returns: "retours",
  return: "retours",
  devoluciones: "retours",
  devolucion: "retours",
  devolución: "retours",

  payment: "paiement",
  payments: "paiement",
  pay: "paiement",
  pago: "paiement",
  pagos: "paiement",

  promo: "codes_promo",
  promo_codes: "codes_promo",
  promocodes: "codes_promo",
  discount: "codes_promo",
  discounts: "codes_promo",
  coupon: "codes_promo",
  coupons: "codes_promo",
  descuento: "codes_promo",
  descuentos: "codes_promo",

  international: "international",
  internacional: "international",

  sizes: "tailles_faq",
  size: "tailles_faq",
  tallas: "tailles_faq",
  talla: "tailles_faq",
  taille: "tailles_faq",
  tailles: "tailles_faq",

  // ── Empresa y soporte ───────────────────────────────────────────────────
  shop: "boutique_info",
  store: "boutique_info",
  boutique: "boutique_info",
  tienda: "boutique_info",

  contact: "contact",
  contacto: "contact",

  legal: "mentions_legales",
  mentions_legales: "mentions_legales",
  legales: "mentions_legales",
  aviso_legal: "mentions_legales",

  products: "produits",
  product: "produits",
  productos: "produits",
  producto: "produits",

  account: "compte_client",
  my_account: "compte_client",
  customer_account: "compte_client",
  cuenta: "compte_client",
  mi_cuenta: "compte_client",

  agent_notes: "agent_notes",
  notes: "agent_notes",
  notas: "agent_notes",

  // ── Operaciones ─────────────────────────────────────────────────────────
  statuses: "lexique_statuts",
  status: "lexique_statuts",
  order_statuses: "lexique_statuts",
  estados: "lexique_statuts",
  estado: "lexique_statuts",

  // ── Guías de medición ───────────────────────────────────────────────────
  mesure_femme: "guide_mesure_femme",
  measure_women: "guide_mesure_femme",
  medidas_mujer: "guide_mesure_femme",

  mesure_homme: "guide_mesure_homme",
  measure_men: "guide_mesure_homme",
  medidas_hombre: "guide_mesure_homme",

  // ── Guías de tallas por marca ───────────────────────────────────────────
  adidas: "guide_tailles_adidas",
  anita: "guide_tailles_anita",
  antigel: "guide_tailles_antigel",
  arthur: "guide_tailles_arthur",
  athena: "guide_tailles_athena",
  aubade: "guide_tailles_aubade",
  calida: "guide_tailles_calida",
  chantelle: "guide_tailles_chantelle",
  cuissoh: "guide_tailles_cuissoh",
  "eden park": "guide_tailles_eden_park",
  eden_park: "guide_tailles_eden_park",
  edenpark: "guide_tailles_eden_park",
  eminence: "guide_tailles_eminence",
  empreinte: "guide_tailles_empreinte",
  hom: "guide_tailles_hom",
  impetus: "guide_tailles_impetus",
  "lise charmel": "guide_tailles_lise_charmel",
  lise_charmel: "guide_tailles_lise_charmel",
  lisecharmel: "guide_tailles_lise_charmel",
  "louisa bracq": "guide_tailles_louisa_bracq",
  louisa_bracq: "guide_tailles_louisa_bracq",
  louisabracq: "guide_tailles_louisa_bracq",
  "maison lejaby": "guide_tailles_maison_lejaby",
  maison_lejaby: "guide_tailles_maison_lejaby",
  lejaby: "guide_tailles_maison_lejaby",
  massana: "guide_tailles_massana",
  moretta: "guide_tailles_moretta",
  passionata: "guide_tailles_passionata",
  "rosa faia": "guide_tailles_rosa_faia",
  rosa_faia: "guide_tailles_rosa_faia",
  rosafaia: "guide_tailles_rosa_faia",
  "sans complexe": "guide_tailles_sans_complexe",
  sans_complexe: "guide_tailles_sans_complexe",
  sanscomplexe: "guide_tailles_sans_complexe",
  sarda: "guide_tailles_sarda",
  saxx: "guide_tailles_saxx",
  "simone perele": "guide_tailles_simone_perele",
  "simone pérèle": "guide_tailles_simone_perele",
  simone_perele: "guide_tailles_simone_perele",
  simoneperele: "guide_tailles_simone_perele",
  sloggi: "guide_tailles_sloggi",
  "sloggi for men": "guide_tailles_sloggi_for_men",
  sloggi_for_men: "guide_tailles_sloggi_for_men",
  sloggimen: "guide_tailles_sloggi_for_men",
  triumph: "guide_tailles_triumph",
};

export interface StorePolicyResult {
  topic: string;
  content: unknown | null;
  /** Solo presente cuando no se encuentra el topic. */
  message?: string;
  /** Topic real resuelto tras aplicar aliases (para auditoría/logging). */
  resolvedTopic?: string;
}

/**
 * Obtiene una política/topic de la base de conocimientos resolviendo aliases
 * (inglés/español/variantes). Solo lectura. Compartida REST + MCP.
 */
export async function getStorePolicy(topic: string): Promise<StorePolicyResult> {
  const resolvedTopic = TOPIC_ALIASES[topic.toLowerCase()] ?? topic;

  const policy = await prisma.storePolicy.findUnique({
    where: { clientId_topic: { clientId: CLIENT_ID, topic: resolvedTopic } },
  });

  if (!policy) {
    return {
      topic,
      content: null,
      message: `No hay información disponible para el tema '${topic}'.`,
      resolvedTopic,
    };
  }

  return { topic: policy.topic, content: policy.content, resolvedTopic };
}

/** Tipos de producto que pertenecen a ropa interior masculina. */
const MALE_PRODUCT_TYPES = new Set([
  "boxer", "slip homme", "caleçon", "t-shirt homme",
  "sous-vêtement homme", "underwear homme", "chaussettes homme",
]);

function normalizeBrand(brand: string): string {
  return brand.toLowerCase().replace(/[\s-]+/g, "_").replace(/_+/g, "_");
}

export interface SizeGuideResult {
  topic: string | null;
  brand: string | null;
  product_type: string | null;
  content: unknown | null;
  /** Nota cuando se devuelve el guía genérico en lugar del específico de marca. */
  note?: string;
  /** Mensaje cuando no hay ningún guía disponible. */
  message?: string;
}

/**
 * Resuelve el guía de tallas: primero intenta el específico de la marca,
 * y si no existe cae al guía genérico (mujer/hombre según el tipo de producto).
 * Solo lectura. Compartida REST + MCP.
 */
export async function getSizeGuide(
  product_type: string | undefined,
  brand: string | undefined
): Promise<SizeGuideResult> {
  const isHomme = MALE_PRODUCT_TYPES.has((product_type ?? "").toLowerCase());
  const fallbackTopic = isHomme ? "guide_mesure_homme" : "guide_mesure_femme";

  // Intento 1: guía específica de la marca
  if (brand) {
    const brandTopic = `guide_tailles_${normalizeBrand(brand)}`;
    const policy = await prisma.storePolicy.findUnique({
      where: { clientId_topic: { clientId: CLIENT_ID, topic: brandTopic } },
    });
    if (policy) {
      return { topic: policy.topic, brand, product_type: product_type ?? null, content: policy.content };
    }
  }

  // Fallback: guía genérica de medidas
  const fallback = await prisma.storePolicy.findUnique({
    where: { clientId_topic: { clientId: CLIENT_ID, topic: fallbackTopic } },
  });

  if (fallback) {
    return {
      topic: fallback.topic,
      brand: brand ?? null,
      product_type: product_type ?? null,
      content: fallback.content,
      ...(brand ? { note: `Guide spécifique pour '${brand}' non disponible. Guide général fourni.` } : {}),
    };
  }

  return {
    topic: null,
    brand: brand ?? null,
    product_type: product_type ?? null,
    content: null,
    message: "Aucun guide de tailles disponible pour cette recherche.",
  };
}
