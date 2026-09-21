import { z } from "zod";
import { getMany, getOne, PrestashopNotFoundError, PrestashopUnavailableError } from "./prestashop-client";
import type { OrderIdentityInput, OrderIdentityResult } from "../types";

/**
 * Validación de identidad de pedidos, flujo order-first: la referencia es el
 * filtro de búsqueda (nunca se busca por email, eso convertiría el endpoint en
 * un oráculo de "este email es cliente nuestro"); el email solo valida que
 * quien pregunta es el dueño del pedido encontrado.
 */

// ─── Entrada ────────────────────────────────────────────────────────────

const referenceSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{9}$/, "La referencia debe tener exactamente 9 caracteres alfanuméricos");

const emailSchema = z.email("El email no tiene un formato válido");

/** Esquema de validación de la entrada de `verifyOrderIdentity`. */
export const OrderIdentityInputSchema = z.object({
  reference: referenceSchema,
  email: emailSchema,
});

/**
 * Normaliza un email para comparar: solo `trim` + `toLowerCase`.
 * Prohibido quitar puntos de Gmail o plus-addressing (`user+tag@`): eso
 * ampliaría el match y terminaría validando pedidos que no son del solicitante.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ─── Formas crudas del webservice (whitelist ya aplicada vía `display`) ──

/** Campos de `orders` pedidos con `display=[...]`. */
export interface PrestashopOrderRecord {
  id: number;
  reference: string;
  id_customer: number;
  date_add: string;
  current_state: number;
  /** PrestaShop suele serializar este booleano como `"0"`/`"1"`. */
  valid: string | boolean;
}

/** Campos de `customers` pedidos con `display=[...]`. Whitelist obligatoria: sin ella se exponen `passwd`, `secure_key`, etc. */
interface PrestashopCustomerRecord {
  id: number;
  email: string;
  firstname: string;
  lastname: string;
  id_lang: number;
}

/** Campos de `customer_threads` pedidos con `display=[...]`. */
interface PrestashopCustomerThreadRecord {
  id: number;
  email: string;
}

function toBool(value: string | boolean): boolean {
  return value === true || value === "1";
}

// ─── Paso 1: búsqueda por referencia ──────────────────────────────────────

/** Resultado de buscar un pedido por referencia exacta. */
export type OrderLookupResult =
  | { status: "FOUND"; order: PrestashopOrderRecord }
  | { status: "NOT_FOUND" }
  | { status: "AMBIGUOUS" };

/**
 * Busca un pedido por referencia exacta (`filter[reference]=REF`).
 * Nunca elige `[0]` ante más de un resultado: eso debe escalarse, no resolverse
 * en silencio (0 duplicados observados en 6.263 pedidos, pero la API devuelve
 * array y PrestaShop puede partir pedidos).
 *
 * Lanza `PrestashopUnavailableError` si el webservice no está disponible; el
 * llamador decide cómo mapear eso a un resultado de negocio.
 */
export async function lookupOrderByReference(reference: string): Promise<OrderLookupResult> {
  const orders = await getMany<PrestashopOrderRecord>("orders", {
    filter: { reference },
    display: ["id", "reference", "id_customer", "date_add", "current_state", "valid"],
  });

  if (orders.length === 0) return { status: "NOT_FOUND" };
  if (orders.length > 1) return { status: "AMBIGUOUS" };
  return { status: "FOUND", order: orders[0] };
}

// ─── Resultado uniforme ────────────────────────────────────────────────────
//
// Referencia inexistente y email que no coincide devuelven exactamente el
// mismo objeto: si se distinguieran, probar referencias al azar permitiría
// enumerar qué pedidos existen y con qué cliente están asociados (RGPD).

const IDENTITY_NOT_VERIFIED: OrderIdentityResult = { outcome: "IDENTITY_NOT_VERIFIED" };
const AMBIGUOUS_REFERENCE: OrderIdentityResult = { outcome: "AMBIGUOUS_REFERENCE" };
const SERVICE_UNAVAILABLE: OrderIdentityResult = { outcome: "SERVICE_UNAVAILABLE" };

// ─── Paso 2-4: validación completa ─────────────────────────────────────────

/**
 * Verifica que `email` pertenece al dueño del pedido `reference`.
 *
 * Flujo order-first:
 * 1. Busca el pedido por referencia (única vía de búsqueda).
 * 2. Lee la cuenta del cliente del pedido (whitelist obligatoria).
 * 3. Lee los hilos de mensajería de ESE pedido (un cliente que cambió de
 *    correo sigue siendo el dueño: verificado en el pedido 93686, con hilos
 *    con dos emails distintos).
 * 4. Compara el email normalizado contra { email de cuenta } ∪ { emails de esos hilos }.
 *
 * Los pasos 2 y 3 se lanzan juntos y SIEMPRE se resuelven ambos antes de
 * decidir (no se cortocircuita al primer match ni al primer fallo), para no
 * filtrar por timing si el email coincidió vía cuenta o vía hilo.
 *
 * Si el pedido o el email de entrada no son válidos, o si la referencia no
 * existe, el resultado es el mismo objeto uniforme `IDENTITY_NOT_VERIFIED`
 * que si el email no coincide: un formato inválido nunca puede corresponder
 * a un pedido real, así que tratarlo aparte no aporta y complicaría el
 * contrato de salida.
 */
export async function verifyOrderIdentity(input: OrderIdentityInput): Promise<OrderIdentityResult> {
  const parsed = OrderIdentityInputSchema.safeParse(input);
  if (!parsed.success) {
    return IDENTITY_NOT_VERIFIED;
  }

  const reference = parsed.data.reference.toUpperCase();
  const requestedEmail = normalizeEmail(parsed.data.email);

  let lookup: OrderLookupResult;
  try {
    lookup = await lookupOrderByReference(reference);
  } catch (err) {
    if (err instanceof PrestashopUnavailableError) return SERVICE_UNAVAILABLE;
    throw err;
  }

  if (lookup.status === "AMBIGUOUS") return AMBIGUOUS_REFERENCE;
  if (lookup.status === "NOT_FOUND") return IDENTITY_NOT_VERIFIED;

  const order = lookup.order;

  const [customerResult, threadsResult] = await Promise.allSettled([
    getOne<PrestashopCustomerRecord>("customers", order.id_customer, {
      display: ["id", "email", "firstname", "lastname", "id_lang"],
    }),
    getMany<PrestashopCustomerThreadRecord>("customer_threads", {
      filter: { id_order: order.id },
      display: ["id", "email"],
    }),
  ]);

  // La cuenta del cliente es decisiva: sin ella no hay identidad contra la que comparar.
  if (customerResult.status === "rejected") {
    // Un fallo transitorio (incluido un timeout) nunca se disfraza de "identidad no
    // verificada": eso le negaría el pedido a un cliente legítimo.
    if (customerResult.reason instanceof PrestashopUnavailableError) return SERVICE_UNAVAILABLE;
    // Anomalía de datos, por ejemplo que el cliente del pedido ya no exista: se trata
    // igual que "no coincide", sin distinguir el motivo.
    if (customerResult.reason instanceof PrestashopNotFoundError) return IDENTITY_NOT_VERIFIED;
    // Cualquier otro error no es un resultado de negocio: se deja propagar.
    throw customerResult.reason;
  }

  const customer = customerResult.value;
  const accountEmail = normalizeEmail(customer.email);

  // Los hilos SOLO amplían el conjunto válido; nunca lo deciden. Si el recurso no
  // estuviera expuesto por los permisos del webservice, su 404 no puede rechazar al
  // dueño cuyo email de cuenta ya coincide: eso negaría el pedido a todos los clientes
  // legítimos, y el llamador lo leería como un veredicto de negocio en vez de un fallo.
  let threads: PrestashopCustomerThreadRecord[] = [];
  if (threadsResult.status === "fulfilled") {
    threads = threadsResult.value;
  } else if (threadsResult.reason instanceof PrestashopUnavailableError) {
    // Transitorio: solo es decisivo si el email de cuenta no zanja ya la cuestión.
    if (accountEmail !== requestedEmail) return SERVICE_UNAVAILABLE;
  } else if (!(threadsResult.reason instanceof PrestashopNotFoundError)) {
    throw threadsResult.reason;
  }

  const validEmails = new Set<string>([
    accountEmail,
    ...threads.map((thread) => normalizeEmail(thread.email)),
  ]);

  if (!validEmails.has(requestedEmail)) {
    return IDENTITY_NOT_VERIFIED;
  }

  return {
    outcome: "VERIFIED",
    order: {
      id: order.id,
      reference: order.reference,
      dateAdd: order.date_add,
      currentState: order.current_state,
      valid: toBool(order.valid),
    },
    customer: {
      id: customer.id,
      email: customer.email,
      firstname: customer.firstname,
      lastname: customer.lastname,
      idLang: customer.id_lang,
    },
  };
}
