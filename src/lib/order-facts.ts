import { addBusinessDays, countBusinessDaysBetween } from "./business-days";
import { normalizeBrandKey } from "./brand-normalize";

/**
 * Cálculo de los hechos del motor de reglas de pedidos: grupo de estado,
 * estado de stock, marcas afectadas, plazo y retraso (§2.2, §2.3, §2.4 y §2.5
 * de docs/reglas-lia-pedidos-retornos.md).
 *
 * Es lógica pura: sin base de datos, sin red, sin `new Date()` interno. Esta
 * función NO decide qué mail corresponde ni si hay que escalar; eso es tarea
 * del evaluador de la matriz y de su fail-safe (T8). Aquí solo se calculan
 * los hechos con los que esas reglas se evalúan, y todo lo necesario para
 * explicar la decisión si hay que escalar.
 */

// ─── Entrada ────────────────────────────────────────────────────────────

/** Grupo del árbol de decisión (§2.1). `D` es "no cubierto por ninguna regla": siempre escalar. */
/**
 * Rama del árbol de decisión. A/B/C/D son los grupos del §2.1 (bloque PEDIDO).
 * `R` es el bloque RETORNO del §3.2, que el documento trata como un árbol aparte
 * y no como una fila más de la matriz del §4. Sin una rama propia, el estado 61
 * "Retour Terminé" caía en D y escalaba: el mail 12 tenía plantilla sembrada y
 * ninguna forma de llegar a ella.
 *
 * `F` (reembolso) es nueva (§ hallazgo "Mejora E" de
 * docs/hallazgos-conversaciones-flow-test.md): los estados 83/68/7/39/63
 * caían todos en D y escalaban aunque el reembolso ya estuviera disponible.
 * No es D ni R: no está en el §2.1 del documento (es "todo lo demás" para el
 * documento original) y tampoco es el bloque RETORNO del §3.2 (esos estados
 * son de PEDIDO ya reembolsado, no de retorno físico en curso).
 */
export type StateGroup = "A" | "B" | "C" | "D" | "R" | "F";

/** Estado de stock del pedido completo (§2.2). */
export type StockStatus = "EN_STOCK" | "SIN_STOCK";

/** Cardinalidad de `affectedBrands` (§2.3): monomarca o multimarca. */
export type BrandCount = "ONE" | "MANY";

/**
 * Tramo de retraso frente a `limitDate`. `NONE` es "sin retraso todavía";
 * `SHORT` y `LONG` reparten el resto según `shortDelayMaxDays`.
 *
 * La matriz (§4) también usa un cuarto valor, `POSITIVE`, como comodín de fila
 * para "cualquier retraso" (`SHORT` o `LONG`, es decir `delayDays > 0`). Esta
 * función nunca produce `POSITIVE`: es un concepto derivado para el
 * evaluador de la matriz, que lo obtiene con `delayBucket !== "NONE"` sin
 * necesitar un campo aparte aquí.
 */
export type DelayBucket = "NONE" | "SHORT" | "LONG";

/**
 * Vocabulario de CONDICIÓN de la matriz, superconjunto del de hechos: añade el
 * comodín `POSITIVE`. `null` en una fila significa "cualquiera".
 */
export type DelayBucketCondition = DelayBucket | "POSITIVE";

/**
 * Traduce la condición de una fila de la matriz al tramo calculado.
 *
 * Existe porque los dos vocabularios NO son el mismo y compararlos por igualdad
 * sería un fallo silencioso: `POSITIVE` no es un valor que los hechos produzcan
 * nunca, así que las filas 6 y 7 del §4 (SIN_STOCK con retraso > 0 → mail 15)
 * no matchearían jamás y esos pedidos caerían al fail-safe, escalando en vez de
 * recibir su mail. El evaluador de la matriz debe usar esta función y no `===`.
 */
export function matchesDelayBucket(
  fact: DelayBucket,
  condition: DelayBucketCondition | null
): boolean {
  if (condition === null) return true;
  if (condition === "POSITIVE") return fact !== "NONE";
  return fact === condition;
}

/** Una línea del pedido, tal como la entrega PrestaShop ya consolidada. */
export interface OrderFactsLineInput {
  name: string;
  brand: string | null;
  quantity: number;
  /**
   * Stock ya descontado por el propio pedido (hallazgo verificado): nunca se
   * compara contra `quantity`, porque `stockQuantity >= quantity` daría falso
   * negativo siempre.
   */
  stockQuantity: number | null;
}

export interface OrderFactsInput {
  orderDate: Date;
  stateId: number;
  trackingNumber: string | null;
  lines: OrderFactsLineInput[];
  historyHasInfo: boolean | null;
  /** Fecha de "hoy", inyectada por el llamador. Nunca se usa `new Date()` dentro de esta función. */
  today: Date;
  /**
   * `true` si el pedido tiene al menos un avoir (`refund !== null` en la consolidación).
   * Opcional, por defecto `false`: solo importa para el grupo `R` (bloque RETORNO, §3.2) —
   * en el resto de grupos ninguna fila de la matriz lo condiciona, así que los tests y
   * llamadores que no hablan de retornos no necesitan pensarlo. A diferencia de
   * `historyHasInfo`, este hecho SIEMPRE se conoce (el avoir existe o no existe: no hay un
   * "no lo sé" intermedio), por eso es `boolean` y no `boolean | null`.
   */
  refundIssued?: boolean;
  /**
   * Fecha en que el pedido entró más recientemente al grupo `R` (hoy, solo el estado 61
   * "Retour Terminé"). Opcional, por defecto `null`: solo importa para el grupo `R`, igual
   * que `refundIssued`. `null` cuando nunca entró (o el llamador no lo sabe).
   */
  returnEnteredAt?: Date | null;
}

// ─── Configuración (inyectada, viene de la base en producción) ─────────────

export interface OrderFactsConfig {
  /** Estado de PrestaShop (`stateId`) → grupo del árbol de decisión. Sin entrada = grupo `D`. */
  stateGroups: Map<number, StateGroup>;
  /** Plazo de expedición en días hábiles, por clave de marca normalizada (`normalizeBrandKey`). */
  brandLeadDays: Map<string, number>;
  /** Fechas `AAAA-MM-DD` excluidas del cómputo de días hábiles, además de sábados y domingos. */
  holidays: Set<string>;
  /** Plazo cuando `stockStatus = EN_STOCK`: las 48 horas hábiles del §2.5. */
  inStockLeadDays: number;
  /** Tope superior (inclusive) del tramo `SHORT`, la ventana de 1 a 3 días del mail 2. */
  shortDelayMaxDays: number;
  /**
   * Días hábiles máximos que un pedido puede quedarse en el grupo `R` (retorno terminado, §3.2)
   * sin ningún reembolso registrado antes de que `checkFailSafe` lo escale en vez de dejarlo
   * esperando indefinidamente (RuleSetting `return_refund_max_business_days`, §ver hallazgo
   * "el equipo quería el texto A.6" en docs/hallazgos-conversaciones-flow-test.md).
   */
  returnRefundMaxBusinessDays: number;
}

// ─── Salida ─────────────────────────────────────────────────────────────

/** Detalle de una línea, con la cobertura de stock ya resuelta. */
export interface OrderFactsLine extends OrderFactsLineInput {
  /**
   * `true` si la línea está cubierta: `stockQuantity !== null && stockQuantity >= 0`.
   * `stockQuantity = 0` cuenta como cubierta (el pedido ya descontó el stock);
   * un negativo es una rotura confirmada; `null` es stock indeterminable.
   */
  covered: boolean;
}

export interface OrderFacts {
  stateGroup: StateGroup;
  stockStatus: StockStatus;
  /**
   * Marcas distintas, solo de las líneas sin stock (§2.3). Una línea sin
   * stock y sin marca informada no aporta ningún nombre aquí: ver la nota de
   * diseño en `computeOrderFacts` sobre por qué no se inventa un nombre.
   */
  affectedBrands: string[];
  /** `null` cuando `affectedBrands` está vacío (no hay nada que contar). */
  brandCount: BrandCount | null;
  /** Subconjunto de `affectedBrands` sin plazo en `brandLeadDays`. No vacío obliga a escalar (§7.4). */
  unknownBrands: string[];
  /**
   * Plazo en días hábiles. `null` cuando `stockStatus = SIN_STOCK` y no se
   * puede fijar con confianza: hay marcas afectadas desconocidas, o ninguna
   * línea sin stock trae marca informada.
   */
  leadDays: number | null;
  /** `orderDate + leadDays` días hábiles. `null` si `leadDays` es `null`. */
  limitDate: Date | null;
  /** Días hábiles desde `limitDate` hasta `today`. 0 si `limitDate` es `null` o si `today <= limitDate`. */
  delayDays: number;
  delayBucket: DelayBucket;
  hasTracking: boolean;
  historyHasInfo: boolean | null;
  /** Detalle por línea, con la cobertura de stock ya resuelta. */
  lines: OrderFactsLine[];
  /** `input.refundIssued`, o `false` si el llamador no lo informó. Ver su JSDoc en `OrderFactsInput`. */
  refundIssued: boolean;
  /** `input.returnEnteredAt` tal cual, sin tocar. `null` si el llamador no lo informó o nunca entró. */
  returnEnteredAt: Date | null;
  /**
   * Días hábiles transcurridos desde `returnEnteredAt` hasta `today`. `null` fuera del grupo `R`
   * o sin `returnEnteredAt`: no tiene sentido "cuánto lleva en retorno" para un pedido que no
   * está en ese grupo.
   */
  returnAgeBusinessDays: number | null;
  /**
   * `true` cuando el pedido lleva más de `config.returnRefundMaxBusinessDays` días hábiles en el
   * grupo `R` sin ningún reembolso registrado: `checkFailSafe` lo usa para escalar en vez de
   * seguir esperando un abono que podría no llegar nunca. `false` en cualquier otro caso,
   * incluido fuera del grupo `R`.
   */
  returnRefundStale: boolean;
}

// ─── Cálculo ────────────────────────────────────────────────────────────

/**
 * Calcula los hechos del motor de reglas para un pedido. Función pura: la
 * misma entrada y la misma configuración siempre producen la misma salida.
 */
export function computeOrderFacts(input: OrderFactsInput, config: OrderFactsConfig): OrderFacts {
  const stateGroup = config.stateGroups.get(input.stateId) ?? "D";

  const lines: OrderFactsLine[] = input.lines.map((line) => ({
    ...line,
    covered: line.stockQuantity !== null && line.stockQuantity >= 0,
  }));

  const stockStatus: StockStatus = lines.every((line) => line.covered) ? "EN_STOCK" : "SIN_STOCK";

  // Marcas afectadas: únicamente de las líneas sin stock (§2.3), dedupeadas
  // por clave normalizada para que grafías distintas de la misma marca no
  // cuenten dos veces. Una línea sin stock y sin marca informada (`brand ===
  // null`) es un dato faltante, no una marca desconocida: no tiene nombre que
  // listar en `affectedBrands` ni en `unknownBrands`, así que no se inventa
  // uno. Sigue visible en `lines` (con `covered: false` y `brand: null`) para
  // que el evaluador de la matriz decida escalar por dato faltante (§7.4),
  // sin que este módulo tome esa decisión.
  const affectedBrands: string[] = [];
  const unknownBrands: string[] = [];
  const knownLeadDaysByBrand: number[] = [];
  const seenBrandKeys = new Set<string>();

  for (const line of lines) {
    if (line.covered || line.brand === null) continue;

    const key = normalizeBrandKey(line.brand);
    if (seenBrandKeys.has(key)) continue;
    seenBrandKeys.add(key);

    affectedBrands.push(line.brand);
    const leadDaysForBrand = config.brandLeadDays.get(key);
    if (leadDaysForBrand === undefined) {
      unknownBrands.push(line.brand);
    } else {
      knownLeadDaysByBrand.push(leadDaysForBrand);
    }
  }

  const brandCount: BrandCount | null =
    affectedBrands.length === 0 ? null : affectedBrands.length === 1 ? "ONE" : "MANY";

  let leadDays: number | null;
  if (stockStatus === "EN_STOCK") {
    leadDays = config.inStockLeadDays;
  } else if (unknownBrands.length > 0 || knownLeadDaysByBrand.length === 0) {
    // Marca desconocida (§7.4, sin valores por defecto), o ninguna línea sin
    // stock trae marca informada: no hay un plazo confiable que fijar. El
    // fail-safe de la matriz es quien decide escalar; aquí no se fabrica un
    // número que no está respaldado por la tabla de plazos.
    leadDays = null;
  } else {
    leadDays = Math.max(...knownLeadDaysByBrand);
  }

  const limitDate = leadDays === null ? null : addBusinessDays(input.orderDate, leadDays, config.holidays);

  const delayDays = limitDate === null ? 0 : countBusinessDaysBetween(limitDate, input.today, config.holidays);

  const delayBucket: DelayBucket =
    delayDays === 0 ? "NONE" : delayDays <= config.shortDelayMaxDays ? "SHORT" : "LONG";

  // Un tracking vacío o solo espacios se trata como ausente: un enlace de
  // seguimiento en blanco es la misma salvaguarda que "no hay tracking" (§3.1).
  const hasTracking = input.trackingNumber !== null && input.trackingNumber.trim().length > 0;

  // ─── Bloque RETORNO (§3.2): reembolso emitido y antigüedad en el grupo R ──
  //
  // Los dos son opcionales en la entrada (ver sus JSDoc en `OrderFactsInput`) porque solo
  // importan para el grupo R: un pedido que no está en retorno no necesita pensarlos.
  const refundIssued = input.refundIssued ?? false;
  const returnEnteredAt = input.returnEnteredAt ?? null;

  const returnAgeBusinessDays =
    stateGroup === "R" && returnEnteredAt !== null
      ? countBusinessDaysBetween(returnEnteredAt, input.today, config.holidays)
      : null;

  const returnRefundStale =
    stateGroup === "R" &&
    !refundIssued &&
    returnAgeBusinessDays !== null &&
    returnAgeBusinessDays > config.returnRefundMaxBusinessDays;

  return {
    stateGroup,
    stockStatus,
    affectedBrands,
    brandCount,
    unknownBrands,
    leadDays,
    limitDate,
    delayDays,
    delayBucket,
    hasTracking,
    historyHasInfo: input.historyHasInfo,
    lines,
    refundIssued,
    returnEnteredAt,
    returnAgeBusinessDays,
    returnRefundStale,
  };
}
