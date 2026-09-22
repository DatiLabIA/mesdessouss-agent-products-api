/**
 * Datos de la siembra inicial del motor de reglas de pedidos/retornos.
 *
 * Fuente de la verdad: docs/reglas-lia-pedidos-retornos.md (versión 2.0).
 * Este fichero NO toca Prisma: son solo estructuras tipadas y exportadas.
 * scripts/seed-rules.ts las inserta dentro de una transacción, siguiendo
 * el mismo patrón que src/data/size-guides.ts + scripts/seed-size-guides.ts
 * (datos en src/data/, script de inserción en scripts/).
 */

import { normalizeBrandKey } from "../lib/brand-normalize";
import type { DelayBucketCondition } from "../lib/order-facts";

/** Cliente para el que se siembra este conjunto de reglas. */
export const RULES_SEED_CLIENT_ID = "mesdessous";

/** Versión del RuleSet que crea esta siembra. Nunca se reutiliza: la edición
 * de un conjunto activo siempre nace como una versión nueva en draft. */
export const RULES_SEED_VERSION = 1;

// ═══════════════════════════════════════════════════════════════════════
// §2.1 — Mapeo de estados de PrestaShop a grupos del árbol de decisión
//
// El mapeo es por ID, nunca por nombre: el estado 10 ya se renombró una vez
// durante el desarrollo ("Paiement OK" → "Commande Terminée"). `stateName`
// se guarda solo como referencia humana, jamás se usa para matchear.
//
// Todo estado no listado aquí cae en Grupo D (escalar) por comportamiento
// por defecto del código que calcula los hechos (T7), no porque exista una
// fila "D" por cada uno de los ~52 estados restantes: no se siembran.
// ═══════════════════════════════════════════════════════════════════════

export type StateGroupCode = "A" | "B" | "C" | "D" | "R";

export interface OrderStateGroupSeed {
  orderStateId: number;
  /** Nombre verificado contra el PrestaShop real; solo para lectura humana. */
  stateName: string;
  groupCode: StateGroupCode;
}

export const stateGroupSeed: OrderStateGroupSeed[] = [
  // Bloque RETORNO (§3.2). Es un árbol aparte del §4: sin esta fila el 61 caía en
  // el grupo D y escalaba, dejando el mail 12 sembrado pero inalcanzable.
  { orderStateId: 61, stateName: "Retour Terminé", groupCode: "R" },
  // Grupo A — pedido no expedido
  { orderStateId: 18, stateName: "Chèque reçu", groupCode: "A" },
  { orderStateId: 17, stateName: "Commande en cours de traitement", groupCode: "A" },
  { orderStateId: 9, stateName: "Commande enregistrée", groupCode: "A" },
  { orderStateId: 2, stateName: "Paiement validé", groupCode: "A" },
  { orderStateId: 3, stateName: "Préparation en cours", groupCode: "A" },
  // Grupo B — pedido expedido
  { orderStateId: 31, stateName: "Livraison En Cours", groupCode: "B" },
  { orderStateId: 4, stateName: "En cours de livraison", groupCode: "B" },
  { orderStateId: 10, stateName: "Commande Terminée", groupCode: "B" },
  // Grupo C — expedición parcial
  { orderStateId: 14, stateName: "Livraison partielle", groupCode: "C" },
];

// ═══════════════════════════════════════════════════════════════════════
// §2.4 — Plazos de expedición por marca, en días hábiles
//
// `brandKey` es la grafía normalizada (NFD, sin diacríticos, minúsculas,
// solo alfanumérico) para poder matchear el nombre de marca que devuelve
// PrestaShop sin depender de acentos, mayúsculas o espacios.
// ═══════════════════════════════════════════════════════════════════════

export interface BrandLeadTimeSeed {
  brand: string;
  brandKey: string;
  leadDays: number;
}

// La normalización se importa de src/lib/brand-normalize.ts a propósito, en vez
// de reimplementarse acá. Es la MISMA función que usa el runtime para buscar el
// plazo de una marca: si las dos versiones divergieran, las claves sembradas
// dejarían de casar con las calculadas y todas las marcas pasarían a desconocidas,
// escalando cada pedido sin stock. Una sola fuente, sin excepción.

/**
 * Marca (grafía original del documento) + plazo en días hábiles.
 * Los seis valores marcados con ✱ en el documento (antes en 0, lo que
 * disparaba el mail 15 de inmediato) son 10 días, por decisión del cliente.
 */
const brandLeadDaysByName: Array<[string, number]> = [
  ["Adidas", 9],
  ["Anita", 7],
  ["Antigel", 5],
  ["Arthur", 7],
  ["Athena", 9],
  ["Aubade", 5],
  ["Calida", 7],
  ["Chantelle", 5],
  ["EdenPark", 8],
  ["Eminence", 9],
  ["Emporio Armani", 10], // ✱
  ["Empreinte", 6],
  ["Hanro", 9],
  ["HOM", 8],
  ["Impetus", 8],
  ["Janira", 7],
  ["Komilfo", 10], // ✱
  ["Le Chat", 7],
  ["Le Slip Français", 10],
  ["Lise Charmel", 5],
  ["Loïc Henry", 10],
  ["Louisa Bracq", 5],
  ["Maison Broussaud", 10], // ✱
  ["Maison Lejaby", 7],
  ["Marie Jo", 5],
  ["Marjolaine", 7],
  ["Massana", 7],
  ["Moretta", 12],
  ["Oscalito", 12],
  ["Passionata", 9],
  ["Prima Donna", 5],
  ["Rosa Faia", 7],
  ["Sans Complexe Lingerie", 10], // ✱
  ["Sarda", 10], // ✱
  ["Saxx", 10], // ✱
  ["Simone Pérèle", 5],
  ["Sloggi", 9],
  ["Sloggi For Men", 9],
  ["Triumph", 9],
  ["Wacoal", 8],
  ["WOH", 8],
];

/**
 * Submarcas reales del catálogo de PrestaShop que NO aparecen con ese nombre
 * exacto en la tabla del §2.4 del documento. Se siembran con el plazo de su
 * marca madre como aproximación razonable — NO es un dato confirmado por el
 * cliente, es una decisión de esta siembra para no dejarlas sin plazo (lo
 * que forzaría escalar todo pedido que las incluya). Pendiente de confirmar
 * con el cliente cuál es su plazo real.
 */
const subBrandLeadDaysByName: Array<[string, number]> = [
  ["Prima Donna Twist", 5], // como Prima Donna — submarca pendiente de confirmar
  ["Prima Donna Bain", 5], // como Prima Donna — submarca pendiente de confirmar
  ["Aubade Men", 5], // como Aubade — submarca pendiente de confirmar
];

export const brandLeadTimeSeed: BrandLeadTimeSeed[] = [
  ...brandLeadDaysByName,
  ...subBrandLeadDaysByName,
].map(([brand, leadDays]) => ({
  brand,
  brandKey: normalizeBrandKey(brand),
  leadDays,
}));

// ═══════════════════════════════════════════════════════════════════════
// §4 — Matriz de decisión cerrada del bloque PEDIDO
//
// Evaluada por `priority` ascendente: gana la primera fila que matchea.
// Cada condición es un enum cerrado o `null` = "cualquiera".
//
// El bloque RETORNO (§3.2) no tiene matriz propia en el documento — es un
// árbol simple, no una tabla de verdad — pero su único mail implementable
// en esta fase (el 12) necesita una fila igual, o quedaría sembrado sin
// ninguna forma de llegar a él. Entra como grupo `R` con prioridad 0.
// ═══════════════════════════════════════════════════════════════════════

export type StockStatus = "EN_STOCK" | "SIN_STOCK";
export type BrandCount = "ONE" | "MANY";

/**
 * Tramo de retraso admitido como CONDICIÓN de una fila.
 *
 * NONE = sin retraso (retard = 0). SHORT/LONG solo se usan con EN_STOCK; el
 * umbral entre ambos vive en el RuleSetting `short_delay_max_days`.
 * POSITIVE = "retard > 0" genérico, usado con SIN_STOCK, que no distingue corto
 * de largo (§3.1: cualquier retraso con falta de stock cae en el mail 15).
 *
 * Se importa de src/lib/order-facts.ts y no se redefine acá: el vocabulario de
 * las condiciones es un superconjunto del de los hechos calculados, que nunca
 * producen POSITIVE. El evaluador debe traducirlo con `matchesDelayBucket`, no
 * comparar por igualdad, o estas filas no matchearían nunca.
 */
export type DelayBucket = DelayBucketCondition;

/**
 * Universo de desenlaces que efectivamente siembra esta tarea. El documento
 * define más mails (8, 10, 13, 14 del bloque RETORNO, y 9/11 que quedan
 * fuera de todo alcance por requerir integración con transportista), pero
 * esta fase solo implementa el bloque PEDIDO completo más el mail 12 de
 * RETORNO (ver odd/tasks/lia-order-lookup.md, "Decisiones tomadas").
 */
export type RuleOutcome =
  | "MAIL_1"
  | "MAIL_2"
  | "MAIL_3"
  | "MAIL_4"
  | "MAIL_5"
  | "MAIL_6"
  | "MAIL_7"
  | "MAIL_12"
  | "MAIL_15"
  | "ESCALATE";

export interface RuleDecisionSeed {
  priority: number;
  stateGroup: StateGroupCode | null;
  stockStatus: StockStatus | null;
  brandCount: BrandCount | null;
  delayBucket: DelayBucket | null;
  hasTracking: boolean | null;
  historyHasInfo: boolean | null;
  outcome: RuleOutcome;
  note: string;
}

export const ruleDecisionSeed: RuleDecisionSeed[] = [
  {
    priority: 1,
    stateGroup: "A",
    stockStatus: "EN_STOCK",
    brandCount: null,
    delayBucket: "NONE",
    hasTracking: null,
    historyHasInfo: null,
    outcome: "MAIL_1",
    note: "No expedido, en stock, sin retraso: confirmación estándar (§4 fila 1).",
  },
  {
    priority: 2,
    stateGroup: "A",
    stockStatus: "EN_STOCK",
    brandCount: null,
    delayBucket: "SHORT",
    hasTracking: null,
    historyHasInfo: null,
    outcome: "MAIL_2",
    note: "No expedido, en stock, retraso corto (1 a short_delay_max_days días hábiles) (§4 fila 2).",
  },
  {
    priority: 3,
    stateGroup: "A",
    stockStatus: "EN_STOCK",
    brandCount: null,
    delayBucket: "LONG",
    hasTracking: null,
    historyHasInfo: null,
    outcome: "MAIL_15",
    note: "No expedido, en stock, retraso mayor a short_delay_max_days días: cierre sin prometer fecha (§4 fila 3).",
  },
  {
    priority: 4,
    stateGroup: "A",
    stockStatus: "SIN_STOCK",
    brandCount: "ONE",
    delayBucket: "NONE",
    hasTracking: null,
    historyHasInfo: null,
    outcome: "MAIL_5",
    note: "Falta de stock monomarca (contada solo sobre líneas sin stock, §2.3), sin retraso todavía (§4 fila 4).",
  },
  {
    priority: 5,
    stateGroup: "A",
    stockStatus: "SIN_STOCK",
    brandCount: "MANY",
    delayBucket: "NONE",
    hasTracking: null,
    historyHasInfo: null,
    outcome: "MAIL_4",
    note: "Falta de stock multimarca, sin retraso todavía (§4 fila 5).",
  },
  {
    priority: 6,
    stateGroup: "A",
    stockStatus: "SIN_STOCK",
    brandCount: "ONE",
    delayBucket: "POSITIVE",
    hasTracking: null,
    historyHasInfo: null,
    outcome: "MAIL_15",
    note: "Falta de stock monomarca ya con retraso: cierre genérico, sin distinguir corto/largo (§4 fila 6).",
  },
  {
    priority: 7,
    stateGroup: "A",
    stockStatus: "SIN_STOCK",
    brandCount: "MANY",
    delayBucket: "POSITIVE",
    hasTracking: null,
    historyHasInfo: null,
    outcome: "MAIL_15",
    note: "Falta de stock multimarca ya con retraso: cierre genérico, sin distinguir corto/largo (§4 fila 7).",
  },
  {
    priority: 8,
    stateGroup: "B",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: true,
    historyHasInfo: null,
    outcome: "MAIL_3",
    note: "Expedido con número de seguimiento disponible; en Grupo B el stock es irrelevante (§4 fila 8).",
  },
  {
    priority: 9,
    stateGroup: "B",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: false,
    historyHasInfo: null,
    outcome: "ESCALATE",
    note: "Expedido pero sin número de seguimiento: salvaguarda para no enviar un enlace de seguimiento vacío (§4 fila 9).",
  },
  {
    priority: 10,
    stateGroup: "C",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: null,
    historyHasInfo: true,
    outcome: "MAIL_6",
    note: "Expedición parcial con historial que indica productos pendientes y/o plazo (§4 fila 10).",
  },
  {
    priority: 11,
    stateGroup: "C",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: null,
    historyHasInfo: false,
    outcome: "MAIL_7",
    note: "Expedición parcial sin información útil en el historial (§4 fila 11).",
  },
  {
    priority: 12,
    stateGroup: "D",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: null,
    historyHasInfo: null,
    outcome: "ESCALATE",
    note: "Grupo D: cualquier estado no cubierto por las reglas (Annulé, Remboursé, etc.) se escala siempre (§4 fila 12).",
  },
  {
    // Prioridad 0: el bloque RETORNO es una rama distinta del árbol, no una fila
    // más de la matriz del §4. Se comprueba antes que nada y no puede colisionar
    // con las filas de los grupos A/B/C/D.
    priority: 0,
    stateGroup: "R",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: null,
    historyHasInfo: null,
    outcome: "MAIL_12",
    note:
      "Bloque RETORNO (§3.2): devolución terminada. Es el único de los cinco mails de " +
      "retorno implementable con lo que la API expone; los otros cuatro necesitan " +
      "order_returns, que no existe en el webservice.",
  },
  {
    priority: 13,
    stateGroup: null,
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: null,
    historyHasInfo: null,
    outcome: "ESCALATE",
    note:
      "Fail-safe explícito de última prioridad: cualquier combinación no capturada arriba. " +
      "Cubre también la fila 13 del documento (SIN_STOCK con marca desconocida), que en la " +
      "práctica debería escalar antes, durante el cálculo de hechos (T7), porque sin plazo de " +
      "marca no hay delayBucket que computar. Esta fila es redundante con el fail-safe en " +
      "código a propósito: hace la matriz legible por sí sola, sin depender de leer el " +
      "evaluador para saber que nada queda sin salida.",
  },
];

// ═══════════════════════════════════════════════════════════════════════
// Ajustes configurables (RuleSetting)
//
// Los puntos abiertos del §8.1 del documento se resuelven cambiando estos
// valores por MCP, no desplegando código.
// ═══════════════════════════════════════════════════════════════════════

export interface RuleSettingSeed {
  key: string;
  value: string | number | boolean;
  note?: string;
}

export const ruleSettingSeed: RuleSettingSeed[] = [
  {
    key: "in_stock_lead_days",
    value: 2,
    note: "Plazo en días hábiles cuando todo el pedido está en stock: las 48 horas ouvrées del §2.5.",
  },
  {
    key: "short_delay_max_days",
    value: 3,
    note: "Tope en días hábiles de la ventana del mail 2 (retraso corto). Por encima, delayBucket pasa a LONG y cae en mail 15.",
  },
  {
    key: "date_format",
    value: "DD/MM/YYYY",
    note: "Formato de fecha para el cliente, siempre francés (JJ/MM/AAAA) según §5.",
  },
];

// ═══════════════════════════════════════════════════════════════════════
// Plantillas (RuleTemplate), idioma fr — es el idioma del cliente
//
// `body`: solo el mail 4 tiene texto redactado en el documento (§6). Los
// demás textos viven en scenario_lia.numbers (hoja Feuil2), que NO está en
// este repositorio: se dejan en "" con un comentario explícito. No se
// inventa texto comercial en francés que no esté aprobado por el cliente.
//
// `factsToConvey`: derivado de la tabla de variables del §5. Para los
// mails 4 y 5, el §5 no lista [Numéro de commande], pero el §6 corrige eso
// explícitamente ("Se añade también [Numéro de commande], que faltaba en
// los mails 4 y 5"): se siguió la corrección del §6, más reciente y
// explícita, por sobre la tabla del §5.
//
// `mustNotClaim`: no está en el documento tal cual — sustituye al "nunca
// se improvisa" del §7.2 ahora que Lia redacta en vez de repetir goteando
// la plantilla literal. Son afirmaciones prohibidas, pensadas mail a mail
// a partir de lo que cada uno dice (o deja de decir). Se escriben en inglés
// porque son guía interna para el modelo (identificador/clave de control),
// no texto de cara al cliente — eso es `body`, que sí va en francés.
// ═══════════════════════════════════════════════════════════════════════

export interface RuleTemplateSeed {
  outcome: RuleOutcome;
  lang: "fr";
  body: string;
  /** Claves de los datos que Lia tiene que transmitir en este desenlace. */
  factsToConvey: string[];
  /** Afirmaciones que Lia tiene prohibido hacer en este desenlace. */
  mustNotClaim: string[];
}

export const ruleTemplateSeed: RuleTemplateSeed[] = [
  {
    outcome: "MAIL_1",
    lang: "fr",
    // Pendiente de importar desde scenario_lia.numbers (Feuil2, mail 1).
    body: "",
    factsToConvey: ["order_reference"],
    mustNotClaim: [
      "must not state or imply the order has already shipped",
      "must not provide a tracking number or tracking link",
      "must not mention any delay, since there is none",
    ],
  },
  {
    outcome: "MAIL_2",
    lang: "fr",
    // Pendiente de importar desde scenario_lia.numbers (Feuil2, mail 2).
    body: "",
    factsToConvey: ["order_reference"],
    mustNotClaim: [
      "must not state or imply the order has already shipped",
      "must not provide a tracking number or tracking link",
      "must not claim the delay is longer than a few days or indefinite",
    ],
  },
  {
    outcome: "MAIL_3",
    lang: "fr",
    // Pendiente de importar desde scenario_lia.numbers (Feuil2, mail 3).
    body: "",
    factsToConvey: ["order_reference", "tracking_url"],
    mustNotClaim: [
      "must not claim the order has not shipped yet",
      "must not invent a delivery date that the tracking data does not confirm",
      "must not claim the parcel was delivered unless tracking confirms it",
    ],
  },
  {
    outcome: "MAIL_4",
    lang: "fr",
    // Único texto redactado en el documento (§6). Segundo párrafo reemplazado
    // por decisión del cliente: pasa a formato de lista porque el escenario
    // es multimarca por definición. Incluye [Numéro de commande], que
    // faltaba en la plantilla original de los mails 4 y 5.
    body: [
      "Bonjour,",
      "Nous vous remercions pour votre commande [Numéro de commande].",
      "Celle-ci est actuellement en cours de traitement. Toutefois, les produits suivants nécessitent un délai supplémentaire de préparation :",
      "",
      "- [Nom produit] — [Marque]",
      "- [Nom produit] — [Marque]",
      "",
      "ce qui peut légèrement retarder l'expédition de votre commande.",
      "Nous faisons notre maximum afin de finaliser votre commande dans les meilleurs délais. Votre commande devrait être expédiée au plus tard le [Date].",
      "Dès son expédition, vous recevrez un e-mail de notre partenaire de livraison (So Colissimo La Poste ou Chronopost) contenant toutes les informations nécessaires au suivi et à l'acheminement de votre colis.",
      "Nous vous remercions pour votre patience et votre confiance, et vous souhaitons une bonne réception de votre commande.",
    ].join("\n"),
    factsToConvey: ["order_reference", "out_of_stock_products", "limit_date"],
    mustNotClaim: [
      "must not state or imply the order has already shipped",
      "must not provide a tracking number or tracking link",
      "must not omit any of the out-of-stock products from the list",
      "must not commit to a ship date earlier than limit_date",
    ],
  },
  {
    outcome: "MAIL_5",
    lang: "fr",
    // Pendiente de importar desde scenario_lia.numbers (Feuil2, mail 5).
    body: "",
    // order_reference añadido por la corrección del §6 (faltaba también en el mail 5).
    factsToConvey: ["order_reference", "limit_date"],
    mustNotClaim: [
      "must not state or imply the order has already shipped",
      "must not provide a tracking number or tracking link",
      "must not commit to a ship date earlier than limit_date",
    ],
  },
  {
    outcome: "MAIL_6",
    lang: "fr",
    // Pendiente de importar desde scenario_lia.numbers (Feuil2, mail 6).
    body: "",
    factsToConvey: ["pending_products", "tracking_url", "additional_delay"],
    mustNotClaim: [
      "must not claim the full order has shipped when only part of it has",
      "must not invent a delay figure that is not present in the order history",
    ],
  },
  {
    outcome: "MAIL_7",
    lang: "fr",
    // Pendiente de importar desde scenario_lia.numbers (Feuil2, mail 7).
    body: "",
    factsToConvey: [],
    mustNotClaim: [
      "must not invent a reason for the partial delivery",
      "must not provide a date or a delay figure, since none is available",
      "must not claim the full order has shipped when only part of it has",
    ],
  },
  {
    outcome: "MAIL_12",
    lang: "fr",
    // Pendiente de importar desde scenario_lia.numbers (Feuil2, mail 12).
    body: "",
    factsToConvey: ["processed_date"],
    mustNotClaim: [
      "must not state a refund amount that the credit note does not confirm",
      "must not claim the funds have already reached the customer's bank, only that the return was processed",
    ],
  },
  {
    outcome: "MAIL_15",
    lang: "fr",
    // Pendiente de importar desde scenario_lia.numbers (Feuil2, mail 15).
    body: "",
    factsToConvey: [],
    mustNotClaim: [
      "must not promise a specific new ship date",
      "must not state or imply the order has already shipped",
      "must not provide a tracking number or tracking link",
    ],
  },
];
