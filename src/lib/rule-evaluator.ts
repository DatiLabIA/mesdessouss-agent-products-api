import type { OrderFacts } from "./order-facts";
import { matchesDelayBucket } from "./order-facts";
import type { RuleDecisionSeed, RuleOutcome, RuleTemplateSeed } from "../data/order-rules-seed";

/**
 * Evaluador de la matriz de decisión del bloque PEDIDO (§4 de
 * docs/reglas-lia-pedidos-retornos.md), su fail-safe en código, y el
 * constructor del bloque `guidance` que se le entrega a Lia.
 *
 * Este módulo no toca red ni base de datos: recibe los hechos ya calculados
 * (`order-facts.ts`, T7) y el conjunto de reglas ya cargado (`order-rules-seed.ts`
 * o, en producción, su reflejo en base) como parámetro.
 */

// ─── Fail-safe (§7.2, §7.4) ─────────────────────────────────────────────
//
// Estas cuatro comprobaciones viven en código, nunca en una fila editable de
// la base. Es a propósito y no es solo una preferencia de estilo: el §7.2 del
// documento dice "si ninguna regla aplica, se escala" y el §7.4 dice "marca
// desconocida, estado desconocido o dato faltante → escalar, sin valores por
// defecto". Si esa garantía viviera como una fila de `rule_decisions`,
// cualquiera que edite el conjunto de reglas por MCP (recordar: quien edita
// es un modelo, no una persona con un formulario, según la Fase 2 del task
// doc) podría borrarla sin querer, o una fila mal escrita podría "taparla"
// si quedara antes en la prioridad. El resultado sería un pedido con datos
// incompletos al que Lia le contesta igual, improvisando sobre su estado,
// que es exactamente lo que este documento entero existe para evitar.
// Por eso `evaluateRules` la invoca siempre, antes de mirar ninguna fila, y
// no hay forma de llamar al evaluador saltándosela.

/**
 * Comprueba las condiciones de fail-safe contra los hechos de un pedido.
 * Devuelve el motivo legible de la escalada, o `null` si ninguna aplica y
 * corresponde seguir con la matriz.
 *
 * Orden de comprobación (no importa para el resultado, todas escalan igual,
 * pero sí para qué motivo se reporta primero si se dan varias a la vez):
 * 1. Grupo D: estado no cubierto por el documento (§2.1).
 * 2. Grupo R (retorno terminado, §3.2) sin reembolso y con más de
 *    `returnRefundMaxBusinessDays` días hábiles esperando uno.
 * 3. Marca afectada sin plazo en la tabla (§2.4, §7.4: sin valores por defecto).
 * 4. Línea con stock indeterminable (`stockQuantity === null` en la entrada).
 * 5. Línea sin stock y sin marca informada: dato faltante que `order-facts.ts`
 *    deja pasar a propósito para que esta capa decida (ver el comentario de
 *    diseño en `computeOrderFacts` sobre por qué no inventa un nombre).
 * 6. `SIN_STOCK` sin un plazo de expedición fiable que calcular.
 */
export function checkFailSafe(facts: OrderFacts): string | null {
  if (facts.stateGroup === "D") {
    return (
      "El estado del pedido pertenece al grupo D, no cubierto por ninguna regla del documento " +
      "(Annulé, Paiement erroné, etc.): se escala siempre, sin consultar la matriz (§2.1, §4 fila 12). Los " +
      "estados de reembolso (antes ejemplo de este grupo) tienen su propio grupo F desde T2."
    );
  }

  // Grupo R (retorno terminado, §3.2): si no hay reembolso todavía, la matriz decide entre
  // MAIL_12/MAIL_10 según `refundIssued` (§ hallazgo A.6, docs/hallazgos-conversaciones-flow-test.md).
  // Pero esperar sin límite un abono que podría no llegar nunca no es "en curso de tratamiento", es
  // un caso que un humano tiene que mirar: por eso esta comprobación vive en código (fail-safe), no
  // como una fila más editable de la matriz. `returnAgeBusinessDays` es `null` salvo que el pedido
  // esté en el grupo R (ver `computeOrderFacts`), así que esta rama nunca dispara fuera de R.
  if (facts.stateGroup === "R") {
    if (facts.returnRefundStale) {
      return (
        `El pedido entró en estado 61 (retorno terminado) hace ${facts.returnAgeBusinessDays} día(s) hábil(es) ` +
        "y todavía no hay ningún reembolso registrado (ni vale ni dinero): no tiene sentido seguir esperando " +
        "un abono indefinidamente, se escala para que un humano lo revise (RuleSetting " +
        "return_refund_max_business_days)."
      );
    }
    return null;
  }

  // Las comprobaciones que siguen son todas sobre el stock, y el stock solo decide
  // algo en el grupo A. El §3.1 lo dice explícitamente: "en el Grupo B el estado de
  // stock es irrelevante: una vez expedido el pedido, siempre es mail 3". El grupo C
  // se reparte por el historial, tampoco por el stock.
  //
  // DESVIACIÓN CONSCIENTE DEL DOCUMENTO, a confirmar con el cliente: la fila 13 del
  // §4 dice "estado: cualquiera | SIN_STOCK | marca desconocida → escalar", lo que
  // contradice la nota del §3.1. Prevalece el §3.1 porque el plazo de marca existe
  // para calcular una fecha de expedición, y en un pedido ya expedido esa fecha ya
  // ocurrió: la marca desconocida no puede cambiar la respuesta. Aplicarlo a todos
  // los grupos escalaría pedidos perfectamente contestables —los que ya tienen
  // tracking, que son la consulta más frecuente— por un dato que no se usa.
  if (facts.stateGroup !== "A") {
    return null;
  }

  if (facts.unknownBrands.length > 0) {
    return (
      `Hay marcas afectadas sin plazo de expedición definido en la tabla (${facts.unknownBrands.join(", ")}): ` +
      "no existen valores por defecto para una marca desconocida, se escala (§2.4, §7.4)."
    );
  }

  const indeterminateStockLine = facts.lines.find((line) => line.stockQuantity === null);
  if (indeterminateStockLine !== undefined) {
    return (
      `La línea "${indeterminateStockLine.name}" tiene el stock indeterminado (sin dato fiable que ` +
      "distinga cubierta de no cubierta): se escala en vez de asumir un estado (§7.4)."
    );
  }

  const unnamedOutOfStockLine = facts.lines.find((line) => !line.covered && line.brand === null);
  if (unnamedOutOfStockLine !== undefined) {
    return (
      `La línea "${unnamedOutOfStockLine.name}" está sin stock pero no trae la marca informada: ` +
      "dato faltante para calcular el plazo y para listar las marcas afectadas, se escala (§7.4)."
    );
  }

  if (facts.stockStatus === "SIN_STOCK" && (facts.leadDays === null || facts.limitDate === null)) {
    return (
      "El pedido tiene falta de stock pero no hay un plazo de expedición fiable que calcular " +
      "(ni una fecha límite derivada de él): se escala en vez de inventar una fecha (§2.4, §2.5, §7.4)."
    );
  }

  return null;
}

// ─── Evaluador de la matriz (§4) ────────────────────────────────────────

/** Fila que ganó la evaluación, o la que decidió una escalada explícita de la matriz. */
export interface RuleMatch {
  priority: number;
  note: string;
}

/**
 * Resultado de evaluar la matriz para un pedido: qué desenlace corresponde y
 * la traza necesaria para poder responder "¿por qué le dijimos esto?"
 * (alimenta la tool `simulate_rules`, fuera del alcance de esta tarea).
 */
export interface RuleEvaluationResult {
  outcome: RuleOutcome;
  /**
   * Fila de la matriz que matcheó. `null` cuando el resultado viene del
   * fail-safe en código (no se llegó a consultar ninguna fila) o cuando
   * ninguna fila matcheó y se aplicó la salvaguarda genérica de cierre.
   */
  matchedRule: RuleMatch | null;
  /** Motivo legible de la escalada. `null` cuando `outcome !== "ESCALATE"`. */
  escalateReason: string | null;
}

/**
 * `true` si `rule` matchea `facts`. `null`/`undefined` en cualquier columna
 * de la fila significa "cualquiera" (comodín). La columna `delayBucket` NUNCA
 * se compara con `===`: el vocabulario de la condición (`DelayBucketCondition`)
 * incluye `POSITIVE`, que los hechos no producen jamás, así que hay que
 * traducirlo con `matchesDelayBucket` (ver su JSDoc en `order-facts.ts` para
 * el incidente real que motivó esto: las filas 6 y 7 del §4 no matcheaban
 * nunca y un pedido sin stock y atrasado escalaba en silencio en vez de
 * recibir el mail 15).
 */
function ruleMatches(rule: RuleDecisionSeed, facts: OrderFacts): boolean {
  if (rule.stateGroup !== null && rule.stateGroup !== facts.stateGroup) return false;
  if (rule.stockStatus !== null && rule.stockStatus !== facts.stockStatus) return false;
  if (rule.brandCount !== null && rule.brandCount !== facts.brandCount) return false;
  if (!matchesDelayBucket(facts.delayBucket, rule.delayBucket ?? null)) return false;
  if (rule.hasTracking !== null && rule.hasTracking !== facts.hasTracking) return false;
  if (rule.historyHasInfo !== null && rule.historyHasInfo !== facts.historyHasInfo) return false;
  if ((rule.refundIssued ?? null) !== null && rule.refundIssued !== facts.refundIssued) return false;
  return true;
}

/**
 * Evalúa la matriz de decisión para un pedido.
 *
 * 1. Corre el fail-safe primero (`checkFailSafe`), siempre, sin excepción:
 *    si aplica, el resultado es `ESCALATE` y no se mira ninguna fila.
 * 2. Ordena `rules` por `priority` ascendente y devuelve el desenlace de la
 *    primera fila que matchea.
 * 3. Si ninguna fila matchea, escala con un motivo genérico: nunca se elige
 *    un mail "parecido" (§7.2). En la siembra actual esto es inalcanzable
 *    porque la última fila es un cajón de sastre sin condiciones, pero un
 *    conjunto de reglas cargado desde base (edición futura) podría no
 *    incluirlo, y esta función tiene que seguir siendo segura igual.
 */
export function evaluateRules(facts: OrderFacts, rules: RuleDecisionSeed[]): RuleEvaluationResult {
  const failSafeReason = checkFailSafe(facts);
  if (failSafeReason !== null) {
    return { outcome: "ESCALATE", matchedRule: null, escalateReason: failSafeReason };
  }

  const sortedRules = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of sortedRules) {
    if (ruleMatches(rule, facts)) {
      return {
        outcome: rule.outcome,
        matchedRule: { priority: rule.priority, note: rule.note },
        escalateReason: rule.outcome === "ESCALATE" ? rule.note : null,
      };
    }
  }

  return {
    outcome: "ESCALATE",
    matchedRule: null,
    escalateReason:
      "Ninguna fila de la matriz coincide con los hechos de este pedido: se escala como salvaguarda, " +
      "sin elegir un mail parecido (§7.2).",
  };
}

// ─── Bloque `guidance` ──────────────────────────────────────────────────
//
// El microservicio no redacta: entrega los hechos y los límites, y Lia
// escribe la respuesta al cliente. Esta sección solo resuelve valores y
// arma el paquete; ningún texto de cara al cliente se genera aquí (salvo el
// `template_text` de referencia, que es el `body` ya sembrado, en francés).

/** Un hecho resuelto, listo para que Lia lo use al redactar. */
export interface GuidanceFact {
  key: string;
  value: string;
}

/**
 * Identidad y datos de contacto del pedido que el bloque `guidance` necesita
 * y que `OrderFacts` NO expone a propósito: el cálculo de hechos es lógica
 * pura, ciega a identidad, a idioma y a URLs. `trackingUrl` llega ya resuelta
 * por el llamador (el enlace del transportista con el número de seguimiento
 * ya sustituido): este módulo no conoce el formato de la URL de ningún
 * transportista, ni lo inventa. Si no llega pese a que el desenlace la pide,
 * es un dato faltante como cualquier otro (§7.4).
 */
export interface GuidanceOrderContext {
  /** Referencia del pedido (9 caracteres alfanuméricos), tal como la devuelve PrestaShop. */
  reference: string;
  /** `id_lang` del pedido/cliente: 1 = fr, 2 = en, 3 = es (§5). */
  idLang: number;
  /** URL de seguimiento ya resuelta. `null` si no hay tracking o no se pudo resolver. */
  trackingUrl: string | null;
}

/**
 * Reembolso ya resuelto por la consolidación (`ConsolidatedRefund` en
 * `order-consolidation.ts`), en la forma mínima que `resolveFactValue` necesita para redactar
 * `refund_method`/`refunded_products` y que `buildGuidance` necesita para la prohibición dinámica
 * vale/dinero. No se importa el tipo completo de `order-consolidation.ts` a propósito: ese módulo
 * ya importa `GuidanceExtraContext` de acá, y hacerlo al revés crearía un ciclo.
 */
export interface GuidanceRefundContext {
  type: "VOUCHER" | "MONEY";
  /** Caducidad del vale. `null` si es dinero, o si el vale no caduca. */
  voucherExpiresAt: Date | null;
  /** Nombres de las líneas cubiertas por el reembolso; `null` cuando una línea no cruza con el pedido. */
  lineNames: Array<string | null>;
}

/**
 * Datos que tampoco salen de `OrderFacts` ni de `GuidanceOrderContext` porque
 * viven en el historial de mensajes o en el avoir de una devolución, no en el
 * pedido en sí: productos pendientes y plazo adicional (mail 6, interpretados
 * por Lia del historial), y fecha de tratamiento del retorno (mail 12, del
 * avoir). Son opcionales porque solo algunos desenlaces los piden; si el
 * desenlace los pide y no llegan, es un dato faltante y se escala (§7.4) en
 * vez de inventarse.
 */
export interface GuidanceExtraContext {
  pendingProducts?: string | null;
  additionalDelay?: string | null;
  processedDate?: Date | null;
  /**
   * Reembolso del pedido (mail 12, mail 10, y el grupo F de estados de reembolso), o `null`/
   * `undefined` cuando no hay ningún avoir. Alimenta `refund_method`, `refunded_products` y la
   * prohibición dinámica vale/dinero de `buildGuidance` (§ user requirement: "la info del pedido
   * tiene que decir si una devolución se reembolsó como vale en vez de dinero").
   */
  refund?: GuidanceRefundContext | null;
  /**
   * `false` mientras el webservice no exponga `order_returns` (ver `ConsolidatedReturn.dataAvailable`
   * en `order-consolidation.ts`). Cuando es exactamente `false`, `buildGuidance` agrega las dos
   * prohibiciones de `RETURN_TRACKING_PROHIBITION`/`RETURN_STATUS_PROHIBITION` a `must_not_claim`,
   * sea cual sea el desenlace. `true` o `undefined` no agregan nada: el día que exista el módulo que
   * exponga los retornos, esta prohibición desaparece sola en cuanto el llamador pase `true`.
   */
  returnDataAvailable?: boolean;
}

/**
 * Prohibiciones agregadas por `buildGuidance` cuando `extra.returnDataAvailable === false` (§ hallazgo
 * de producción, conversación VJWIRCHVQ: el agente presentó el tracking de ida como si fuera el de la
 * devolución, dos veces, porque nada en `must_not_claim` lo prohibía). En inglés, como el resto de
 * `must_not_claim` sembrado: lo lee Lia, no el equipo.
 */
const RETURN_TRACKING_PROHIBITION =
  "must not present the outbound tracking number as tracking for the customer's return";
const RETURN_STATUS_PROHIBITION =
  "must not state the status of a return in progress: this service cannot see returns that have not " +
  "been completed, so hand over to a human instead";

/**
 * Prohibiciones agregadas por `buildGuidance` cuando `extra.refund` no es `null`/`undefined`, sea
 * cual sea el desenlace: mismo patrón que `RETURN_TRACKING_PROHIBITION`/`RETURN_STATUS_PROHIBITION`
 * (§ user requirement: "la info del pedido tiene que decir si una devolución se reembolsó como vale
 * en vez de dinero"). Una sola nunca puede faltar la otra: el reembolso es SIEMPRE vale o dinero,
 * nunca las dos cosas a la vez.
 */
const VOUCHER_REFUND_PROHIBITION =
  "must not say the money was refunded to the customer's bank or card: this refund was issued as a " +
  "store credit (avoir)";
const MONEY_REFUND_PROHIBITION = "must not describe this refund as a voucher or store credit (avoir)";

/**
 * El bloque que Lia recibe para redactar la respuesta al cliente. `situation`
 * es el desenlace (`RuleOutcome`); el resto son los hechos, límites y
 * prohibiciones que Lia tiene que respetar, nunca texto ya redactado salvo
 * `template_text`, que es material de referencia (mayormente vacío hoy:
 * ver la nota "Pendiente de fuente externa" del task doc).
 */
export interface GuidanceBlock {
  situation: string;
  can_answer: boolean;
  must_escalate: boolean;
  escalate_reason: string | null;
  reply_language: string;
  facts_to_convey: GuidanceFact[];
  must_not_claim: string[];
  reference_template: string | null;
  template_text: string | null;
  missing_facts: string[];
}

/**
 * Traduce `id_lang` al idioma de respuesta (§5, tabla de la petición: 1=fr,
 * 2=en, 3=es). Un valor fuera de ese rango usa `fr`, el idioma por defecto de
 * la tienda: no es un dato faltante que deba escalar, es un idioma que Lia
 * puede resolver igual con el idioma base del negocio.
 */
function resolveReplyLanguage(idLang: number): string {
  switch (idLang) {
    case 1:
      return "fr";
    case 2:
      return "en";
    case 3:
      return "es";
    default:
      return "fr";
  }
}

/** Formatea una fecha en el formato francés `DD/MM/AAAA` exigido para toda fecha de cara al cliente (§5). */
function formatFrenchDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Formatea las líneas sin stock como "nombre — marca" (§2.3, formato usado en
 * la plantilla del mail 4). Si alguna línea sin stock no trae marca, no se
 * arma una lista incompleta ni se inventa el nombre: se devuelve `null` para
 * que el llamador lo trate como dato faltante (§7.4). En la práctica esa
 * situación ya la intercepta el fail-safe antes de llegar a un desenlace que
 * pida esta clave, pero esta función no depende de esa garantía externa.
 */
function formatOutOfStockProducts(facts: OrderFacts): string | null {
  const outOfStockLines = facts.lines.filter((line) => !line.covered);
  if (outOfStockLines.length === 0) return null;

  const formatted: string[] = [];
  for (const line of outOfStockLines) {
    if (line.brand === null) return null;
    formatted.push(`${line.name} — ${line.brand}`);
  }
  return formatted.join("; ");
}

/**
 * Texto en francés para el desenlace del reembolso (§ user requirement: "la info del pedido
 * tiene que decir si una devolución se reembolsó como vale en vez de dinero"). `VOUCHER` agrega la
 * caducidad cuando se conoce; `MONEY` no tiene fecha que agregar, el reembolso vuelve al medio de
 * pago original. `null` cuando no hay ningún reembolso: nunca se inventa "todavía no hay reembolso"
 * como si fuera el valor del hecho, eso lo decide `missing_facts` sobre el desenlace, no esta función.
 */
function formatRefundMethod(refund: GuidanceRefundContext): string {
  if (refund.type === "VOUCHER") {
    const expiry = refund.voucherExpiresAt !== null ? ` valable jusqu'au ${formatFrenchDate(refund.voucherExpiresAt)}` : "";
    return `avoir${expiry}`;
  }
  return "remboursement sur le moyen de paiement utilisé pour la commande";
}

/**
 * Nombres de las líneas cubiertas por el reembolso, separados por coma. `null` cuando ninguna línea
 * cruzó con un nombre real (un avoir 100% de envío, o uno cuyas líneas no se pudieron cruzar con el
 * pedido): no se arma una lista vacía ni se inventa un nombre, se trata como dato faltante (§7.4),
 * igual que `formatOutOfStockProducts`.
 */
function formatRefundedProducts(refund: GuidanceRefundContext): string | null {
  const names = refund.lineNames.filter((name): name is string => name !== null);
  return names.length > 0 ? names.join(", ") : null;
}

/**
 * Resuelve el valor de una clave de `factsToConvey`. Devuelve `null` cuando
 * el dato no está disponible: nunca inventa un valor, y una clave que esta
 * función no reconoce se trata igual que un dato faltante (§7.4), nunca se
 * ignora en silencio.
 */
function resolveFactValue(
  key: string,
  facts: OrderFacts,
  order: GuidanceOrderContext,
  extra: GuidanceExtraContext
): string | null {
  switch (key) {
    case "order_reference":
      return order.reference.trim().length > 0 ? order.reference : null;
    case "tracking_url":
      return order.trackingUrl !== null && order.trackingUrl.trim().length > 0 ? order.trackingUrl : null;
    case "limit_date":
      return facts.limitDate !== null ? formatFrenchDate(facts.limitDate) : null;
    case "out_of_stock_products":
      return formatOutOfStockProducts(facts);
    case "pending_products":
      return extra.pendingProducts != null && extra.pendingProducts.trim().length > 0
        ? extra.pendingProducts
        : null;
    case "additional_delay":
      return extra.additionalDelay != null && extra.additionalDelay.trim().length > 0
        ? extra.additionalDelay
        : null;
    case "processed_date":
      return extra.processedDate != null ? formatFrenchDate(extra.processedDate) : null;
    case "refund_method":
      return extra.refund != null ? formatRefundMethod(extra.refund) : null;
    case "refunded_products":
      return extra.refund != null ? formatRefundedProducts(extra.refund) : null;
    case "return_received_date":
      return facts.returnEnteredAt !== null ? formatFrenchDate(facts.returnEnteredAt) : null;
    default:
      return null;
  }
}

/**
 * Construye el bloque `guidance` a partir del resultado de `evaluateRules`,
 * los hechos, la identidad del pedido y las plantillas sembradas.
 *
 * Regla central (§7.4): si una clave que la plantilla exige no se puede
 * resolver, no se inventa ni se omite en silencio. Se agrega a
 * `missing_facts` y el bloque entero pasa a `must_escalate: true`, aunque el
 * desenlace de la matriz no fuera `ESCALATE`. Un mail 3 con el enlace de
 * seguimiento vacío es exactamente el fallo que esto evita.
 *
 * También escala si el desenlace no es `ESCALATE` pero no hay ninguna
 * plantilla sembrada para él: sin plantilla no hay `factsToConvey` que
 * resolver ni `mustNotClaim` que respetar, así que no hay guía real que
 * entregarle a Lia.
 */
export function buildGuidance(
  evaluation: RuleEvaluationResult,
  facts: OrderFacts,
  order: GuidanceOrderContext,
  templates: RuleTemplateSeed[],
  extra: GuidanceExtraContext = {}
): GuidanceBlock {
  const isRuleEscalate = evaluation.outcome === "ESCALATE";

  // Solo hay una plantilla `fr` por desenlace en la siembra actual (ver la
  // nota "Pendiente de fuente externa" del task doc); si en el futuro hay
  // variantes por idioma, esto debería preferir la de `reply_language`.
  const template = isRuleEscalate ? null : (templates.find((t) => t.outcome === evaluation.outcome) ?? null);
  const missingTemplate = !isRuleEscalate && template === null;

  const missingFacts: string[] = [];
  const factsToConvey: GuidanceFact[] = [];

  if (template !== null) {
    for (const key of template.factsToConvey) {
      const value = resolveFactValue(key, facts, order, extra);
      if (value === null) {
        missingFacts.push(key);
      } else {
        factsToConvey.push({ key, value });
      }
    }
  }

  // Se agrega siempre que `returnDataAvailable` sea exactamente `false`, sin importar el desenlace
  // (incluido ESCALATE, donde `template` es `null` y `must_not_claim` arranca vacío): el fallo de
  // producción que motivó esto fue precisamente un MAIL_3 con `must_not_claim` sembrado, pero sin
  // ninguna fila sobre retornos. Nunca depender de qué plantilla ganó para proteger este dato.
  const mustNotClaim = [...(template?.mustNotClaim ?? [])];
  if (extra.returnDataAvailable === false) {
    mustNotClaim.push(RETURN_TRACKING_PROHIBITION, RETURN_STATUS_PROHIBITION);
  }
  // Mismo patrón, mismo motivo: agregada siempre que haya un reembolso, sin importar el desenlace
  // ni qué plantilla ganó. Nunca las dos a la vez: el reembolso es vale O dinero.
  if (extra.refund != null) {
    mustNotClaim.push(extra.refund.type === "VOUCHER" ? VOUCHER_REFUND_PROHIBITION : MONEY_REFUND_PROHIBITION);
  }

  const mustEscalate = isRuleEscalate || missingTemplate || missingFacts.length > 0;

  let escalateReason: string | null = null;
  if (isRuleEscalate) {
    escalateReason = evaluation.escalateReason ?? "Se escala: ninguna regla de la matriz aplica.";
  } else if (missingTemplate) {
    escalateReason =
      `No hay ninguna plantilla sembrada para el desenlace ${evaluation.outcome}: no se puede construir ` +
      "una guía de respuesta sin ella, se escala.";
  } else if (missingFacts.length > 0) {
    escalateReason =
      `No se pudieron resolver los siguientes datos que la plantilla exige: ${missingFacts.join(", ")}. ` +
      "Un dato faltante nunca se inventa ni se omite en silencio, se escala (§7.4).";
  }

  return {
    situation: evaluation.outcome,
    can_answer: !mustEscalate,
    must_escalate: mustEscalate,
    escalate_reason: escalateReason,
    reply_language: resolveReplyLanguage(order.idLang),
    facts_to_convey: factsToConvey,
    must_not_claim: mustNotClaim,
    reference_template: template?.outcome ?? null,
    template_text: template !== null && template.body.trim().length > 0 ? template.body : null,
    missing_facts: missingFacts,
  };
}
