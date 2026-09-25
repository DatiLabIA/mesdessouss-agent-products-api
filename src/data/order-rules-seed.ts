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

export type StateGroupCode = "A" | "B" | "C" | "D" | "R" | "F";

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
  // Estado 5 "Livré" (T5, catálogo real de producción, 67 pedidos de los últimos 8.000 leídos por
  // estado actual): ya se había agregado a mano al conjunto de reglas v2 en base, pero nunca a esta
  // siembra en código — quedaba sin mapear acá, así que un conjunto nuevo creado desde la siembra
  // (en vez de clonado del activo) lo hubiera vuelto a mandar al grupo D y escalado siempre.
  { orderStateId: 5, stateName: "Livré", groupCode: "B" },
  // Grupo C — expedición parcial
  { orderStateId: 14, stateName: "Livraison partielle", groupCode: "C" },
  // Grupo F — reembolso (§ hallazgo "Mejora E" de docs/hallazgos-conversaciones-flow-test.md:
  // 104+78+40 pedidos en dos meses caían en D y escalaban, aunque el reembolso ya estuviera
  // disponible). 83/68/7 tienen volumen real verificado; 39/63 existen en el catálogo de estados
  // pero sin volumen visto todavía — se siembran igual para no dejarlos en D por omisión.
  { orderStateId: 83, stateName: "Remboursé avec Sogecommerce", groupCode: "F" },
  { orderStateId: 68, stateName: "Remboursement partiel", groupCode: "F" },
  { orderStateId: 7, stateName: "Remboursé", groupCode: "F" },
  { orderStateId: 39, stateName: "Remboursement partiel", groupCode: "F" },
  { orderStateId: 63, stateName: "Partiellement remboursé", groupCode: "F" },
];

// ═══════════════════════════════════════════════════════════════════════
// T5 — Catálogo de estados conocidos del grupo D (por omisión: cualquier estado sin fila arriba)
//
// 64 estados en total en `order_states` de producción. De los últimos 8.000 pedidos leídos (por
// estado ACTUAL, 27/07 → 25/09), el resto de estados con volumen visto y sin mapear son:
//
//   78  Autorisation annulée              24 pedidos
//   6   Annulé                             9 pedidos
//   1   En attente du paiement par chèque  8 pedidos
//   8   Erreur de paiement                 2 pedidos
//   20  Relance paiement par chèque        2 pedidos
//   70  Commande validée Stockly           1 pedido
//
// No se les da fila propia a propósito: caen en el grupo D por comportamiento por defecto del
// código (§2.1) y `checkFailSafe` los escala siempre, SIN excepción. Los seis son casos de pago o
// de cancelación (autorización de pago anulada, pedido anulado, a la espera de un cheque, pago con
// error, cheque reclamado de nuevo, o un pedido de un canal externo — Stockly — todavía sin
// validar internamente): ninguno tiene un texto aprobado por el equipo, y los seis necesitan que un
// humano decida (reembolsar, reclamar el pago, confirmar la cancelación), no una respuesta
// automática. Documentados acá para que quede explícito que la ausencia es deliberada y no un
// olvido — no para sembrar filas que de todos modos siempre escalarían igual.
// ═══════════════════════════════════════════════════════════════════════

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
 * define más mails (8, 13, 14 del bloque RETORNO, y 9/11 que quedan
 * fuera de todo alcance por requerir integración con transportista), pero
 * esta fase solo implementa el bloque PEDIDO completo más los mails 10 y 12
 * de RETORNO (ver odd/tasks/lia-order-lookup.md, "Decisiones tomadas") y
 * `MAIL_REFUND`, un desenlace nuevo para el grupo F (§ hallazgo "Mejora E" de
 * docs/hallazgos-conversaciones-flow-test.md) que no tiene número de mail en
 * el documento original porque ese documento no cubría los estados de
 * reembolso — no se inventa un número de mail que el equipo no asignó.
 *
 * `MAIL_8` (T4, § hallazgo 4.1 "el equipo quiere el mail 8" de
 * docs/hallazgos-conversaciones-flow-test.md) es distinto de todos los demás: NINGUNA fila de la
 * matriz lo selecciona nunca, a propósito. `order_lookup` no sabe si la pregunta del cliente es
 * sobre una devolución (eso exigiría un parámetro nuevo en la tool, fuera de esta tarea), así que
 * su plantilla se entrega siempre como el bloque adicional `guidance.return_inquiry`, para que Lia
 * lo tenga disponible SI el cliente pregunta por una devolución — nunca como el `situation`/
 * `reference_template` principal del pedido. Ver `order-rules-seed.test.ts` para la prueba de que
 * es la única plantilla sembrada sin fila propia.
 */
export type RuleOutcome =
  | "MAIL_1"
  | "MAIL_2"
  | "MAIL_3"
  | "MAIL_4"
  | "MAIL_5"
  | "MAIL_6"
  | "MAIL_7"
  | "MAIL_8"
  | "MAIL_10"
  | "MAIL_12"
  | "MAIL_15"
  | "MAIL_REFUND"
  | "ESCALATE";

export interface RuleDecisionSeed {
  priority: number;
  stateGroup: StateGroupCode | null;
  stockStatus: StockStatus | null;
  brandCount: BrandCount | null;
  delayBucket: DelayBucket | null;
  hasTracking: boolean | null;
  historyHasInfo: boolean | null;
  /**
   * `true`/`false` exige que haya (o no haya) reembolso registrado (`refund !== null` en la
   * consolidación); `null` = cualquiera. Solo lo usan las dos filas del grupo R (§3.2): el resto de
   * la matriz nunca lo pisa. Nombre y semántica iguales a `hasTracking`, mismo patrón de comodín.
   */
  refundIssued: boolean | null;
  outcome: RuleOutcome;
  note: string;
}

export const ruleDecisionSeed: RuleDecisionSeed[] = [
  {
    // Prioridades 0-1: el bloque RETORNO es una rama distinta del árbol, no una fila más de la
    // matriz del §4. Se comprueban antes que nada y no pueden colisionar con las filas de los
    // grupos A/B/C/D/F. Antes había una sola fila (prioridad 0, sin condición de reembolso) que
    // mandaba TODO estado 61 a MAIL_12, aunque no hubiera abono: `processed_date` no se podía
    // resolver y el pedido escalaba igual (§ hallazgo A.6, docs/hallazgos-conversaciones-flow-test.md).
    // El fail-safe de `checkFailSafe` sigue interceptando antes que estas dos filas cuando el
    // retorno lleva demasiado tiempo sin reembolso (RuleSetting return_refund_max_business_days).
    priority: 0,
    stateGroup: "R",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: true,
    outcome: "MAIL_12",
    note:
      "Bloque RETORNO (§3.2): devolución terminada y reembolso ya emitido (vale o dinero). Es el " +
      "único de los mails de retorno implementable con lo que la API expone además del mail 10; " +
      "los mails 8, 13 y 14 necesitan order_returns, que no existe en el webservice.",
  },
  {
    priority: 1,
    stateGroup: "R",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: false,
    outcome: "MAIL_10",
    note:
      "Bloque RETORNO (§3.2, mail 10 'Colis reçu'): devolución terminada, reembolso todavía en " +
      "trámite. Antes esto caía en la fila de MAIL_12 sin poder resolver processed_date y escalaba " +
      "siempre, aunque el equipo ya tenía un texto (A.6) para justo este caso (§ hallazgo " +
      "docs/hallazgos-conversaciones-flow-test.md).",
  },
  {
    priority: 2,
    stateGroup: "A",
    stockStatus: "EN_STOCK",
    brandCount: null,
    delayBucket: "NONE",
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "MAIL_1",
    note: "No expedido, en stock, sin retraso: confirmación estándar (§4 fila 1).",
  },
  {
    priority: 3,
    stateGroup: "A",
    stockStatus: "EN_STOCK",
    brandCount: null,
    delayBucket: "SHORT",
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "MAIL_2",
    note: "No expedido, en stock, retraso corto (1 a short_delay_max_days días hábiles) (§4 fila 2).",
  },
  {
    priority: 4,
    stateGroup: "A",
    stockStatus: "EN_STOCK",
    brandCount: null,
    delayBucket: "LONG",
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "MAIL_15",
    note: "No expedido, en stock, retraso mayor a short_delay_max_days días: cierre sin prometer fecha (§4 fila 3).",
  },
  {
    priority: 5,
    stateGroup: "A",
    stockStatus: "SIN_STOCK",
    brandCount: "ONE",
    delayBucket: "NONE",
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "MAIL_5",
    note: "Falta de stock monomarca (contada solo sobre líneas sin stock, §2.3), sin retraso todavía (§4 fila 4).",
  },
  {
    priority: 6,
    stateGroup: "A",
    stockStatus: "SIN_STOCK",
    brandCount: "MANY",
    delayBucket: "NONE",
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "MAIL_4",
    note: "Falta de stock multimarca, sin retraso todavía (§4 fila 5).",
  },
  {
    priority: 7,
    stateGroup: "A",
    stockStatus: "SIN_STOCK",
    brandCount: "ONE",
    delayBucket: "POSITIVE",
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "MAIL_15",
    note: "Falta de stock monomarca ya con retraso: cierre genérico, sin distinguir corto/largo (§4 fila 6).",
  },
  {
    priority: 8,
    stateGroup: "A",
    stockStatus: "SIN_STOCK",
    brandCount: "MANY",
    delayBucket: "POSITIVE",
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "MAIL_15",
    note: "Falta de stock multimarca ya con retraso: cierre genérico, sin distinguir corto/largo (§4 fila 7).",
  },
  {
    priority: 9,
    stateGroup: "B",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: true,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "MAIL_3",
    note: "Expedido con número de seguimiento disponible; en Grupo B el stock es irrelevante (§4 fila 8).",
  },
  {
    priority: 10,
    stateGroup: "B",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: false,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "ESCALATE",
    note: "Expedido pero sin número de seguimiento: salvaguarda para no enviar un enlace de seguimiento vacío (§4 fila 9).",
  },
  {
    // Grupo C (T3, § hallazgo 3 "envío parcial: siempre deriva" de
    // docs/hallazgos-conversaciones-flow-test.md): las dos filas originales (§4 filas 10/11)
    // exigían `historyHasInfo` true/false EXACTO, pero `computeHistoryHasInfo` (order-consolidation.ts)
    // nunca devuelve `true` — solo `false` (sin ningún mensaje público real) o `null` (hay al menos
    // uno, pero su contenido no se interpreta). La fila del mail 6 (`true`) era letra muerta desde
    // que se escribió, y CUALQUIER pedido con un mensaje público real (el caso más común: 3 de 3
    // pedidos reales reproducidos) caía en `null`, no matcheaba ninguna de las dos filas, y terminaba
    // en el cajón de sastre. Se reemplazan por `hasTracking`, un hecho que SIEMPRE se conoce (nunca
    // `null`, a diferencia de `historyHasInfo`): con seguimiento hay algo verificable que decir
    // (MAIL_7, texto A.3); sin él, no hay nada fiable que ofrecer y se escala.
    priority: 11,
    stateGroup: "C",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: true,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "MAIL_7",
    note:
      "Expedición parcial con número de seguimiento disponible: se informa el envío parcial y el " +
      "enlace de seguimiento, sin inventar qué productos van en cada expedición (§4 fila 10/11, " +
      "reemplazadas por T3 — ver hallazgo 3 de docs/hallazgos-conversaciones-flow-test.md).",
  },
  {
    priority: 12,
    stateGroup: "C",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: false,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "ESCALATE",
    note:
      "Expedición parcial sin número de seguimiento: no hay ni un enlace verificable que dar, se " +
      "escala (§4 fila 10/11, reemplazadas por T3). El mail 6 (productos pendientes + fecha de " +
      "reposición, texto A.4 del equipo) NO se siembra: esa fecha solo existe hoy en notas internas " +
      "(§4 del documento de hallazgos), que ya no llegan a Lia desde T1, y no hay otra fuente fiable " +
      "para no inventarla (§7.4).",
  },
  {
    // Grupo F (reembolso, § hallazgo "Mejora E" de docs/hallazgos-conversaciones-flow-test.md):
    // 104+78+40 pedidos en dos meses caían en D y escalaban aunque el reembolso (vale o dinero)
    // ya estuviera disponible. Sin condición de reembolso: si el avoir todavía no llegó,
    // `missing_facts` escala igual (processed_date/refund_method/refunded_products sin resolver),
    // nunca inventa un dato — mismo patrón que la falta de tracking en el grupo B.
    priority: 13,
    stateGroup: "F",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "MAIL_REFUND",
    note:
      "Grupo F: estados de reembolso (83 'Remboursé avec Sogecommerce', 68/39 'Remboursement " +
      "partiel', 7 'Remboursé', 63 'Partiellement remboursé'). El reembolso ya está disponible en " +
      "el avoir; escalar por defecto solo porque el estado no estaba en el documento original era " +
      "innecesario (§4 fila 12 solo cubría 'todo lo demás' cuando se escribió el documento).",
  },
  {
    priority: 14,
    stateGroup: "D",
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: null,
    outcome: "ESCALATE",
    note: "Grupo D: cualquier estado no cubierto por las reglas (Annulé, Paiement erroné, etc.) se escala siempre (§4 fila 12).",
  },
  {
    priority: 15,
    stateGroup: null,
    stockStatus: null,
    brandCount: null,
    delayBucket: null,
    hasTracking: null,
    historyHasInfo: null,
    refundIssued: null,
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
  {
    key: "return_refund_max_business_days",
    value: 7,
    note:
      "Días hábiles máximos que un pedido puede quedarse en el grupo R (retorno terminado) sin " +
      "ningún reembolso registrado antes de escalar (fail-safe en código, checkFailSafe), en vez de " +
      "esperar indefinidamente un abono que podría no llegar (§ hallazgo A.6, " +
      "docs/hallazgos-conversaciones-flow-test.md). Mismo plazo que promete el texto A.6 del equipo.",
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
  /**
   * T4: si este desenlace tiene que marcarse para que el equipo lo revise (ej. MAIL_15, que
   * promete "nous reviendrons vers vous dans un délai de 48 heures" — § hallazgo 7 "je viens de
   * transmettre votre demande" de docs/hallazgos-conversaciones-flow-test.md). `buildGuidance`
   * expone esto en `guidance.notify_team`, junto con cualquier escalada: es SOLO una bandera, este
   * servicio nunca envía ninguna notificación — la acción real (Zimbra u otra) se habilita en otro
   * lugar (decisión del usuario, fuera de esta tarea).
   */
  notifyTeam: boolean;
}

export const ruleTemplateSeed: RuleTemplateSeed[] = [
  {
    outcome: "MAIL_1",
    lang: "fr",
    // Texto A.2 del Anexo A (docs/hallazgos-conversaciones-flow-test.md), transcrito literal: nota
    // de la conversación 721c0860 (pedido ZKHRPZKYY), un pedido en preparación con todo en stock
    // (§ hallazgo 1 "retrasos: MAIL_15 no tiene nada que decir", Mejora A punto 2).
    //
    // ATENCIÓN: el texto original TIENE erratas ("pour votre commande est en cours de traitement"
    // en vez de algo como "et votre commande est…"; "Celle va être expédiée" en vez de "Elle va
    // être expédiée") y el propio Anexo A las señala. Se siembran igual, sin corregirlas: es texto
    // comercial ya aprobado por el cliente, y esta siembra no se toma la licencia de reescribir el
    // francés de nadie en silencio. Corregirlas es tarea del equipo, no de este commit.
    body:
      "Bonjour, Nous vous remercions pour votre commande est en cours de traitement. Celle va être " +
      "expédiée sous 48 heures (hors week-end et jours fériés). À l'expédition de votre commande, un " +
      "mail de notre partenaire (Socolissimo La Poste ou Chronopost) vous sera transmis pour suivre " +
      "l'acheminement de votre colis. Nous vous remercions pour votre confiance et vous souhaitons " +
      "une bonne reception de votre commande.",
    factsToConvey: ["order_reference"],
    mustNotClaim: [
      "must not state or imply the order has already shipped",
      "must not provide a tracking number or tracking link",
      "must not mention any delay, since there is none",
    ],
    notifyTeam: false,
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
    notifyTeam: false,
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
    notifyTeam: false,
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
    notifyTeam: false,
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
    notifyTeam: false,
  },
  // No se siembra ninguna plantilla MAIL_6 (T3): su fila de la matriz se quitó (ver el comentario de
  // la fila de prioridad 12 más arriba) porque el texto A.4 del equipo (productos pendientes + fecha
  // de reposición) necesita un dato — la fecha de reposición de cada producto pendiente — que hoy
  // solo vive en notas internas, y esas ya no llegan a Lia desde T1 (§ hallazgo 3,
  // docs/hallazgos-conversaciones-flow-test.md). Sembrar una plantilla para un desenlace sin fila que
  // lo seleccione dejaría configuración muerta que podría hacer pensar a quien edite el conjunto de
  // reglas por MCP que MAIL_6 ya está disponible: se quita entera (fila y plantilla) hasta que exista
  // una fuente fiable para esa fecha. `MAIL_6` sigue siendo un `RuleOutcome`/`RULE_OUTCOMES` válido
  // por si el día que exista esa fuente se agregan la fila y la plantilla de nuevo.
  {
    outcome: "MAIL_7",
    lang: "fr",
    // Texto A.3 del Anexo A (docs/hallazgos-conversaciones-flow-test.md), transcrito literal: nota
    // de la conversación 5539f563 (pedido NQWWBQUNW), un envío parcial sin fecha de reposición. El
    // marcador "(Lien de suivi)" es del propio equipo, se mantiene literal (lo resuelve `tracking_url`).
    body: [
      "Bonjour,",
      "",
      "Votre commande a fait l'objet d'une expédition partielle. Vous trouverez le lien de suivi ci-dessous.",
      "(Lien de suivi)",
      "Vous recevrez prochainement un e-mail vous indiquant les produits qui ont été expédiés ainsi que ceux restant à expédier.",
      "",
      "Nous vous remercions pour votre patience et votre compréhension.",
    ].join("\n"),
    factsToConvey: ["order_reference", "tracking_url"],
    mustNotClaim: [
      "must not state which products were shipped or which are still pending, since that is not known here",
      "must not promise a date for the remaining products",
      "must not claim the whole order has been delivered",
    ],
    notifyTeam: false,
  },
  {
    outcome: "MAIL_10",
    lang: "fr",
    // Texto A.6 del Anexo A (docs/hallazgos-conversaciones-flow-test.md), transcrito literal: el
    // equipo lo escribió en las notas de revisión de la conversación 26be3780 (pedido MUJJABSBJ),
    // que era justo este caso — retorno recibido, reembolso todavía en trámite. `[Date]` es el
    // marcador del propio equipo, se mantiene literal (lo resuelve `return_received_date`).
    body: [
      "Bonjour,",
      "",
      "Après vérification, nous vous confirmons que votre colis de retour a bien été reçu le [Date].",
      "Votre remboursement ou votre code avoir, selon l'option que vous avez choisie, est actuellement en cours de traitement.",
      "Le traitement sera effectué dans un délai maximum de 7 jours après la réception et la vérification de l'état de vos articles.",
    ].join("\n"),
    factsToConvey: ["order_reference", "return_received_date"],
    mustNotClaim: [
      "must not state a refund amount, since the credit note has not been issued yet",
      "must not claim the refund or the voucher has already been issued",
    ],
    notifyTeam: false,
  },
  {
    outcome: "MAIL_12",
    lang: "fr",
    // Pendiente de importar desde scenario_lia.numbers (Feuil2, mail 12).
    body: "",
    factsToConvey: ["processed_date", "refund_method"],
    mustNotClaim: [
      "must not state a refund amount that the credit note does not confirm",
      "must not claim the funds have already reached the customer's bank, only that the return was processed",
    ],
    notifyTeam: false,
  },
  {
    outcome: "MAIL_REFUND",
    lang: "fr",
    // No hay texto aprobado para este desenlace: el documento y scenario_lia.numbers no cubrían
    // los estados de reembolso (§ hallazgo "Mejora E" de docs/hallazgos-conversaciones-flow-test.md,
    // era escalar siempre). No se inventa texto comercial en francés sin aprobar.
    body: "",
    factsToConvey: ["order_reference", "processed_date", "refund_method", "refunded_products"],
    mustNotClaim: [
      "must not state a refund amount that the credit note does not confirm",
      "must not claim the funds have already reached the customer's bank",
    ],
    notifyTeam: false,
  },
  {
    outcome: "MAIL_15",
    lang: "fr",
    // Texto A.1 del Anexo A (docs/hallazgos-conversaciones-flow-test.md), transcrito literal: cuatro
    // notas IDÉNTICAS del equipo (conversaciones 18b3611c/9944442e/10e1f22e/8e8cb91d, § hallazgo 1
    // "retrasos: MAIL_15 no tiene nada que decir", Mejora A punto 1) — el caso más repetido de las
    // dos muestras (12 de 28 conversaciones `bad`).
    body: [
      "Bonjour,",
      "",
      "Nous sommes malheureusement au regret de vous informer que le délai de préparation initialement " +
        "annoncé pour votre commande est désormais dépassé. Nous vous présentons nos sincères excuses " +
        "pour ce retard et pour la gêne occasionnée.",
      "Afin de vous communiquer une information précise, nous avons relancé notre service logistique " +
        "afin d'obtenir une nouvelle estimation du délai de préparation et d'expédition de votre commande.",
      "Nous reviendrons vers vous dans un délai de 48 heures ouvrées, hors week-ends et jours fériés, " +
        "afin de vous communiquer le nouveau délai et de vous tenir informé(e) de l'avancement de votre " +
        "commande.",
      "Nous vous remercions sincèrement pour votre patience, votre compréhension et votre confiance.",
    ].join("\n"),
    factsToConvey: [],
    mustNotClaim: [
      "must not promise a specific new ship date",
      "must not state or imply the order has already shipped",
      "must not provide a tracking number or tracking link",
    ],
    // El texto promete "nous reviendrons vers vous dans un délai de 48 heures ouvrées": esa promesa
    // solo es verdad si alguien del equipo recibe el caso (§ hallazgo 7 "je viens de transmettre
    // votre demande", Mejora G). El código nunca transmite nada por su cuenta: esto solo pone la
    // bandera `guidance.notify_team` para que quien reciba el payload sepa que hace falta un
    // seguimiento humano.
    notifyTeam: true,
  },
  {
    outcome: "MAIL_8",
    lang: "fr",
    // Texto A.5 del Anexo A (docs/hallazgos-conversaciones-flow-test.md), transcrito literal: mismo
    // texto en las notas de las conversaciones 7c5a7464 y 7df749b3 (§ hallazgo 4.1 "el equipo quiere
    // el mail 8"). A diferencia de toda otra plantilla, ninguna fila de la matriz selecciona esta:
    // `order_lookup` no sabe si la pregunta del cliente es sobre una devolución, así que
    // `buildGuidance` la entrega siempre como el bloque adicional `guidance.return_inquiry` (T4),
    // nunca como `situation`/`reference_template` del pedido.
    body: [
      "Bonjour,",
      "Après vérification, nous constatons que votre colis retour n'a pas encore été traité par notre " +
        "service retours.",
      "Si le suivi de votre colis indique qu'il a bien été livré, soyez rassuré(e) : le délai de " +
        "traitement des retours est de 4 jours ouvrés, hors week-ends et jours fériés, à compter de sa " +
        "réception par notre service.",
      "",
      "Dès que votre retour aura été traité, vous recevrez automatiquement une confirmation par e-mail.",
      "",
      "Si plus de 4 jours ouvrés se sont écoulés depuis la réception de votre colis, nous vous invitons " +
        "à contacter notre service après-vente afin que nous puissions vous accompagner au mieux :",
      "serviceclients@mesdessous.fr",
      "Nous vous remercions pour votre patience et votre compréhension.",
    ].join("\n"),
    // Sin claves: el texto no necesita ningún dato del pedido, es un mensaje genérico sobre el
    // plazo de tratamiento de un retorno.
    factsToConvey: [],
    mustNotClaim: [
      "must not use this template unless the customer explicitly asked about a return for this order",
      "must not claim to know whether the return parcel has actually been received: only the customer's own tracking can confirm that",
      "must not state that a return is already being processed, since this service cannot see that",
    ],
    notifyTeam: false,
  },
];
