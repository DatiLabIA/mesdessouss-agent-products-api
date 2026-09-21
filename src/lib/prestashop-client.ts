import "dotenv/config";

/**
 * Cliente HTTP de bajo nivel contra el webservice de PrestaShop.
 *
 * Solo conoce cómo hablar con la API (auth, construcción de query, reintentos
 * y normalización de la forma de la respuesta). No conoce reglas de negocio.
 */

const DEFAULT_API_URL = "https://www.mesdessous.fr/api/";

/** Tiempo máximo de espera por request antes de abortar. */
const REQUEST_TIMEOUT_MS = 8_000;

/** Reintentos ante fallos transitorios (5xx, timeout, 200 con cuerpo vacío). */
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Falta configuración obligatoria para hablar con el webservice. No es transitorio. */
export class PrestashopConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrestashopConfigError";
  }
}

let cachedAuthHeader: string | undefined;

/**
 * Cabecera de autenticación, leída de forma diferida y memoizada.
 *
 * La comprobación de la clave ocurre en la primera petición, no al evaluar el
 * módulo. Si lanzara al importar, cualquier fichero que importase este cliente
 * —un test, un script de tooling, o un módulo que lo arrastre de forma
 * transitiva— reventaría el proceso antes de ejecutar nada, y el alcance del
 * fallo dependería del orden de los imports en vez de si el cliente llega a
 * usarse. La garantía sigue siendo fail-closed: sin clave no sale ninguna
 * petición, y el error es atribuible al punto de uso.
 */
function getAuthHeader(): string {
  if (cachedAuthHeader === undefined) {
    const apiKey = process.env.PRESTASHOP_API_KEY;
    if (!apiKey) {
      throw new PrestashopConfigError(
        "La variable de entorno PRESTASHOP_API_KEY es obligatoria y no está definida. " +
          "La clave del webservice de PrestaShop nunca se escribe literal en el código."
      );
    }
    cachedAuthHeader = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  }
  return cachedAuthHeader;
}

function getApiBaseUrl(): string {
  return normalizeBaseUrl(process.env.PRESTASHOP_API_URL ?? DEFAULT_API_URL);
}

// ─── Errores tipados ─────────────────────────────────────────────────────

/** El recurso solicitado no existe (HTTP 404 con cuerpo vacío). */
export class PrestashopNotFoundError extends Error {
  constructor(resource: string) {
    super(`Recurso no encontrado en PrestaShop: ${resource}`);
    this.name = "PrestashopNotFoundError";
  }
}

/** La API respondió con un error funcional (`{"errors":[...]}`, HTTP 400). No es transitorio: nunca se reintenta. */
export class PrestashopApiError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message);
    this.name = "PrestashopApiError";
  }
}

/**
 * Fallo transitorio del webservice: 5xx, error de red o un 200 con cuerpo vacío.
 * Este último caso está verificado en producción (dos veces en la misma sesión, ambas
 * resueltas al reintentar) y NUNCA debe interpretarse como "sin resultados": confundirlo
 * le negaría un pedido legítimo a un cliente real.
 */
export class PrestashopUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PrestashopUnavailableError";
  }
}

/** El request superó el tiempo máximo de espera. */
export class PrestashopTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrestashopTimeoutError";
  }
}

function isRetryableError(err: unknown): boolean {
  return err instanceof PrestashopUnavailableError || err instanceof PrestashopTimeoutError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Construcción de la query ────────────────────────────────────────────
//
// El webservice de PrestaShop usa corchetes literales en la sintaxis de filtros
// (`filter[reference]=X`, `display=[id,email]`, `sort=[id_DESC]`, rangos
// `filter[quantity]=[-99999,-1]`). `URLSearchParams` codifica esos corchetes y
// cambia la semántica que la API espera, así que la query se arma a mano:
// las claves y la sintaxis estructural (corchetes, comas) viajan literales,
// y solo se codifica cada valor individual con `encodeURIComponent`.

/** Un valor de filtro simple, o una tupla `[min, max]` para un rango. */
export type PrestashopFilterValue = string | number | readonly [string | number, string | number];

export interface PrestashopQueryParams {
  /** Filtros `filter[campo]=valor`. Un valor tupla genera un rango `filter[campo]=[min,max]`. */
  filter?: Record<string, PrestashopFilterValue>;
  /** Whitelist de campos a devolver. Sin `display`, PrestaShop solo devuelve el `id`. */
  display?: readonly string[];
  /** Orden, ej. `"id_DESC"`. Se serializa como `sort=[id_DESC]`. */
  sort?: string;
  /** Límite de resultados: `"count"` o `"offset,count"`. */
  limit?: string;
  /** Fuerza `date=1`, obligatorio cuando se filtra por un rango de fechas. */
  date?: boolean;
}

function serializeFilterValue(value: PrestashopFilterValue): string {
  if (Array.isArray(value)) {
    const [min, max] = value;
    return `[${encodeURIComponent(String(min))},${encodeURIComponent(String(max))}]`;
  }
  return encodeURIComponent(String(value));
}

function buildQueryString(params: PrestashopQueryParams): string {
  const parts: string[] = ["output_format=JSON"];

  if (params.filter) {
    for (const [field, value] of Object.entries(params.filter)) {
      parts.push(`filter[${field}]=${serializeFilterValue(value)}`);
    }
  }

  if (params.display && params.display.length > 0) {
    parts.push(`display=[${params.display.join(",")}]`);
  }

  if (params.sort) {
    parts.push(`sort=[${params.sort}]`);
  }

  if (params.limit) {
    parts.push(`limit=${params.limit}`);
  }

  if (params.date) {
    parts.push("date=1");
  }

  return parts.join("&");
}

function buildUrl(resource: string, params: PrestashopQueryParams): string {
  return `${getApiBaseUrl()}${resource}?${buildQueryString(params)}`;
}

// ─── Normalización de la forma de la respuesta ──────────────────────────
//
// Verificado contra la API real: la clave del objeto de respuesta no siempre
// coincide con el nombre del recurso pedido (`order_slip` -> `order_slips`,
// `stock_movements` -> `stock_mvts`), y una búsqueda sin resultados puede
// devolver `[]` en la raíz en lugar de `{"recurso":[]}`. Por eso nunca se
// asume la clave: se extrae el primer valor del objeto que sea del tipo
// esperado (array u objeto).

function extractArray<T>(json: unknown): T[] {
  if (Array.isArray(json)) {
    return json as T[];
  }
  if (json && typeof json === "object") {
    for (const value of Object.values(json as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        return value as T[];
      }
    }
  }
  return [];
}

/**
 * Extrae un recurso individual de la respuesta.
 *
 * Verificado contra la API real: `display=[...]` CAMBIA la forma de la respuesta
 * de un recurso individual. Sin `display`, `customers/27794` devuelve
 * `{"customer":{...}}` (objeto, clave en singular); con `display=[id,email]`
 * devuelve `{"customers":[{...}]}` (array, clave en plural). Como la whitelist
 * es obligatoria en este cliente, el caso normal es el segundo. Hay que aceptar
 * las dos formas: tratar el array como "no encontrado" rechazaría a todo
 * cliente legítimo, y en silencio, porque el llamador lo leería como un
 * resultado de negocio y no como un fallo.
 */
function extractSingle<T>(json: unknown): T | null {
  if (Array.isArray(json)) {
    return (json[0] as T) ?? null;
  }
  if (json && typeof json === "object") {
    for (const value of Object.values(json as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        return (value[0] as T) ?? null;
      }
      if (value && typeof value === "object") {
        return value as T;
      }
    }
  }
  return null;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface PrestashopErrorBody {
  errors?: Array<{ code: number; message: string }>;
}

// ─── Request con reintentos ──────────────────────────────────────────────

async function performRequest(url: string): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await performSingleRequest(url);
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === MAX_RETRIES;
      if (isLastAttempt || !isRetryableError(err)) {
        throw err;
      }
      const backoff = RETRY_BASE_DELAY_MS * 2 ** attempt;
      const jitter = Math.random() * backoff * 0.5;
      await sleep(backoff + jitter);
    }
  }

  // Inalcanzable: el bucle siempre retorna o lanza. Se deja por seguridad de tipos.
  throw lastError;
}

async function performSingleRequest(url: string): Promise<unknown> {
  // Fail-closed: sin clave configurada no sale ninguna petición. `PrestashopConfigError`
  // no es transitorio, así que `performRequest` lo propaga sin reintentar.
  const authHeader = getAuthHeader();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new PrestashopTimeoutError(`Timeout al consultar PrestaShop (${REQUEST_TIMEOUT_MS}ms): ${url}`);
    }
    throw new PrestashopUnavailableError(`No se pudo conectar con PrestaShop: ${(err as Error).message}`, {
      cause: err,
    });
  }

  if (response.status === 404) {
    throw new PrestashopNotFoundError(url);
  }

  const bodyText = await response.text();

  if (response.status >= 500) {
    throw new PrestashopUnavailableError(`PrestaShop respondió HTTP ${response.status} para ${url}`);
  }

  if (!response.ok) {
    const parsed = safeParseJson(bodyText) as PrestashopErrorBody | undefined;
    const firstError = parsed?.errors?.[0];
    throw new PrestashopApiError(
      firstError?.code ?? response.status,
      firstError?.message ?? `Error de la API de PrestaShop (HTTP ${response.status})`
    );
  }

  // Verificado: la API devuelve 200 con cuerpo vacío de forma intermitente.
  // Nunca es "sin resultados": es un fallo transitorio que hay que reintentar.
  if (bodyText.trim().length === 0) {
    throw new PrestashopUnavailableError(`PrestaShop devolvió HTTP 200 con cuerpo vacío para ${url}`);
  }

  const parsed = safeParseJson(bodyText);
  if (parsed === undefined) {
    throw new PrestashopUnavailableError(`La respuesta de PrestaShop no es JSON válido para ${url}`);
  }

  return parsed;
}

// ─── API pública ─────────────────────────────────────────────────────────

/** Ejecuta un GET contra un recurso del webservice y devuelve el JSON crudo ya parseado. */
export async function prestashopGet<T = unknown>(
  resource: string,
  params: PrestashopQueryParams = {}
): Promise<T> {
  const url = buildUrl(resource, params);
  return (await performRequest(url)) as T;
}

/**
 * Obtiene una colección. Normaliza tanto `{"recurso_en_plural_distinto":[...]}` como
 * `[]` en la raíz (sin resultados) a un array de `T`.
 */
export async function getMany<T>(resource: string, params: PrestashopQueryParams = {}): Promise<T[]> {
  const json = await prestashopGet<unknown>(resource, params);
  return extractArray<T>(json);
}

/**
 * Obtiene un recurso individual por id. Acepta las dos formas que devuelve la API
 * (objeto sin `display`, array con `display`: ver `extractSingle`). Lanza
 * `PrestashopNotFoundError` si la API devuelve 404 o si la respuesta viene vacía.
 */
export async function getOne<T>(
  resource: string,
  id: number | string,
  params: PrestashopQueryParams = {}
): Promise<T> {
  const path = `${resource}/${id}`;
  const json = await prestashopGet<unknown>(path, params);
  const obj = extractSingle<T>(json);
  if (obj === null) {
    throw new PrestashopNotFoundError(path);
  }
  return obj;
}
