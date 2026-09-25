import { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { verifyOrderIdentity } from "../lib/order-identity";
import { consolidateOrder } from "../lib/order-consolidation";
import { computeOrderFacts } from "../lib/order-facts";
import { evaluateRules, buildGuidance } from "../lib/rule-evaluator";
import { RuleSetNotFoundError, RuleSetValidationError, type LoadedRuleSet } from "../lib/rule-set-validation";
import { PrestashopUnavailableError } from "../lib/prestashop-client";
import type { OrderLookupRequestBody, OrderLookupResponseBody } from "../types";

/**
 * Handler HTTP de `POST /order_lookup`: la última pieza de la cadena que
 * DatiHub llama para que Lia responda sobre un pedido. Encadena
 * `verifyOrderIdentity -> loadActiveRuleSet -> consolidateOrder ->
 * computeOrderFacts -> evaluateRules -> buildGuidance` y traduce el
 * resultado a HTTP.
 *
 * Nota de orden: el prompt de la tarea describe la cadena como
 * "verifyOrderIdentity → consolidateOrder → loadActiveRuleSet → ...", pero
 * `consolidateOrder` recibe el mapa `stateGroups` del conjunto de reglas como
 * segundo parámetro (lo necesita desde el primer `await`, para resolver el
 * grupo del pedido). Por esa dependencia de datos real, acá se carga el
 * conjunto de reglas ANTES de consolidar: además de ser la única forma de
 * pasarle el mapa, evita golpear PrestaShop con toda la consolidación cuando
 * ni siquiera hay un conjunto de reglas activo (ver el criterio de "503, no
 * 500" para ese caso).
 *
 * La auth Bearer ya es middleware global en `server.ts`: este handler no la
 * reimplementa.
 */

const CLIENT_ID = "mesdessous";

// ─── Límite de intentos fallidos de identidad, por IP ──────────────────────
//
// Un `Map` en memoria con TTL, sin dependencias nuevas. El motivo es concreto:
// con una referencia de pedido conocida (viaja en capturas, reenvíos, tickets
// de soporte) se podrían probar emails hasta acertar, y el premio sería el
// nombre, la dirección y el historial de compra de una persona real. El
// límite no distingue "referencia inexistente" de "email ajeno" — ambas caen
// en `IDENTITY_NOT_VERIFIED` — así que no reintroduce el canal de timing que
// `verifyOrderIdentity` ya cuida.

/** Ventana deslizante de intentos fallidos, en milisegundos. */
export const ORDER_LOOKUP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
/** Intentos fallidos de identidad permitidos por IP dentro de la ventana. */
export const ORDER_LOOKUP_RATE_LIMIT_MAX_FAILURES = 5;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const identityFailuresByIp = new Map<string, RateLimitEntry>();

function isWindowExpired(entry: RateLimitEntry, now: number): boolean {
  return now - entry.windowStart > ORDER_LOOKUP_RATE_LIMIT_WINDOW_MS;
}

function isRateLimited(ip: string, now: number): boolean {
  const entry = identityFailuresByIp.get(ip);
  if (entry === undefined) return false;
  if (isWindowExpired(entry, now)) {
    identityFailuresByIp.delete(ip);
    return false;
  }
  return entry.count >= ORDER_LOOKUP_RATE_LIMIT_MAX_FAILURES;
}

function registerIdentityFailure(ip: string, now: number): void {
  const entry = identityFailuresByIp.get(ip);
  if (entry === undefined || isWindowExpired(entry, now)) {
    identityFailuresByIp.set(ip, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
}

/** Un intento verificado con éxito no debe seguir penalizando errores previos del mismo cliente. */
function resetIdentityFailures(ip: string): void {
  identityFailuresByIp.delete(ip);
}

function cleanupRateLimitState(now: number): void {
  for (const [ip, entry] of identityFailuresByIp) {
    if (isWindowExpired(entry, now)) {
      identityFailuresByIp.delete(ip);
    }
  }
}

// `unref()`: este temporizador nunca debe mantener vivo el proceso (ni el de
// producción al apagarse, ni el runner de tests al terminar).
const cleanupTimer = setInterval(() => cleanupRateLimitState(Date.now()), RATE_LIMIT_CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

function getClientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

// ─── Dependencias inyectables (Prisma) ─────────────────────────────────────
//
// `loadActiveRuleSet` (rule-queries.ts) y `logQuery` (audit.ts) importan
// `../lib/prisma`, que lanza al evaluarse si `DATABASE_URL` no está definida
// (no hay `.env` en este repositorio, y la tarea prohíbe tocar la base). Si
// este módulo las importara de forma estática, cualquier test —incluido uno
// que solo valida "falta `reference`", sin tocar Prisma para nada— reventaría
// al cargar el fichero. Se importan de forma diferida (dinámica), en el punto
// de uso, igual que `getAuthHeader` en `prestashop-client.ts` difiere la
// lectura de `PRESTASHOP_API_KEY`: la garantía de producción no cambia (sigue
// haciendo falta `DATABASE_URL` para poder responder una consulta real), pero
// el alcance de un import roto deja de depender del orden de carga de otros
// ficheros. Los tests inyectan sus propios dobles vía `createOrderLookupHandler`
// y nunca disparan este import real.

interface OrderLookupAuditInput {
  endpoint: string;
  input: Prisma.InputJsonObject;
  resultCount?: number;
  durationMs?: number;
}

export interface OrderLookupDeps {
  loadActiveRuleSet: (clientId: string) => Promise<LoadedRuleSet>;
  logQuery: (opts: OrderLookupAuditInput) => void;
}

async function defaultLoadActiveRuleSet(clientId: string): Promise<LoadedRuleSet> {
  const { loadActiveRuleSet } = await import("../lib/rule-queries");
  return loadActiveRuleSet(clientId);
}

function defaultLogQuery(opts: OrderLookupAuditInput): void {
  // Fire-and-forget, igual que `audit.ts` documenta: no bloquea la respuesta HTTP.
  import("../lib/audit")
    .then(({ logQuery }) => logQuery(opts))
    .catch((err) => {
      console.error("[order_lookup] No se pudo registrar la auditoría:", err);
    });
}

const defaultDeps: OrderLookupDeps = {
  loadActiveRuleSet: defaultLoadActiveRuleSet,
  logQuery: defaultLogQuery,
};

// ─── Mensajes de error ──────────────────────────────────────────────────────

const SERVICE_UNAVAILABLE_MESSAGE = "El servicio de PrestaShop no está disponible en este momento. Reintentá en unos minutos.";
const RULES_NOT_CONFIGURED_MESSAGE =
  "El conjunto de reglas no está configurado para este cliente: no se puede evaluar la consulta.";
const AMBIGUOUS_ESCALATE_REASON =
  "Hay más de un pedido asociado a esta referencia: se escala para que un humano lo resuelva en vez de elegir uno al azar.";

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * Construye el handler de `POST /order_lookup`. Recibe `deps` para poder
 * inyectar dobles de prueba de `loadActiveRuleSet`/`logQuery` (los dos únicos
 * puntos de este módulo que tocan Prisma) sin levantar una base de datos real.
 * En producción se usa `orderLookup`, la instancia ya construida con las
 * dependencias reales, con la misma firma `(req, res)` que el resto de los
 * handlers de `mesdessous.routes.ts`.
 */
export function createOrderLookupHandler(deps: OrderLookupDeps = defaultDeps) {
  return async function orderLookup(req: Request, res: Response): Promise<void> {
    const start = Date.now();
    const ip = getClientIp(req);

    try {
      const body = (req.body ?? {}) as Partial<OrderLookupRequestBody>;
      const { reference, email } = body;

      if (!reference || !email) {
        res.status(400).json({ error: "Los campos 'reference' y 'email' son obligatorios" });
        return;
      }

      // Se comprueba ANTES de llamar a `verifyOrderIdentity`, para no gastar
      // ninguna consulta a PrestaShop en una IP ya bloqueada. El corte es
      // universal por IP (no distingue el motivo del fallo previo), así que
      // no reintroduce ningún canal de timing entre "referencia inexistente"
      // y "email ajeno".
      if (isRateLimited(ip, start)) {
        res.status(429).json({
          error: "Se alcanzó el límite de intentos de verificación de identidad. Probá de nuevo más tarde.",
        });
        return;
      }

      const identity = await verifyOrderIdentity({ reference, email });

      // Se comprueba primero el positivo único (`"VERIFIED"` es el único
      // literal exclusivo de `VerifiedOrderIdentity`): así TypeScript angosta
      // `identity` a `VerifiedOrderIdentity` en el resto de la función sin
      // necesidad de un `as`. `UnverifiedOrderIdentity.outcome` es en cambio
      // una unión de tres literales, y angostar por eliminación secuencial de
      // cada uno por separado (tres `if` sueltos) no colapsa el tipo del objeto.
      if (identity.outcome !== "VERIFIED") {
        if (identity.outcome === "SERVICE_UNAVAILABLE") {
          deps.logQuery({
            endpoint: "order_lookup",
            input: { reference, outcome: identity.outcome },
            resultCount: 0,
            durationMs: Date.now() - start,
          });
          res.status(503).json({ error: SERVICE_UNAVAILABLE_MESSAGE });
          return;
        }

        if (identity.outcome === "AMBIGUOUS_REFERENCE") {
          deps.logQuery({
            endpoint: "order_lookup",
            input: { reference, outcome: identity.outcome },
            resultCount: 0,
            durationMs: Date.now() - start,
          });
          const response: OrderLookupResponseBody = {
            found: false,
            identity_verified: false,
            outcome: "AMBIGUOUS_REFERENCE",
            must_escalate: true,
            escalate_reason: AMBIGUOUS_ESCALATE_REASON,
          };
          res.status(200).json(response);
          return;
        }

        // identity.outcome === "IDENTITY_NOT_VERIFIED"
        registerIdentityFailure(ip, start);
        deps.logQuery({
          endpoint: "order_lookup",
          input: { reference, outcome: identity.outcome },
          resultCount: 0,
          durationMs: Date.now() - start,
        });
        // Una sola forma, sin eco de la referencia ni del email ni dato
        // alguno del pedido: distinguir el motivo permitiría enumerar datos
        // personales de clientes probando referencias (RGPD).
        const response: OrderLookupResponseBody = {
          found: false,
          identity_verified: false,
          outcome: "IDENTITY_NOT_VERIFIED",
        };
        res.status(200).json(response);
        return;
      }

      // identity.outcome === "VERIFIED"
      resetIdentityFailures(ip);

      // CUALQUIER fallo al obtener las reglas es 503, no solo los errores tipados
      // del propio conjunto. Sin reglas no se puede contestar, y la causa nunca es
      // del cliente que pregunta: una base inalcanzable, una tabla que todavía no
      // existe porque la migración no se aplicó, o un pool agotado son todos el
      // mismo caso operativo. Enumerar clases de error dejaba escapar justamente
      // el más probable: verificado contra el entorno real, un error de conexión de
      // Prisma no es `RuleSetNotFoundError` y caía al 500 genérico, reportando un
      // problema de infraestructura como si fuera un bug de nuestra lógica.
      let ruleSet: LoadedRuleSet;
      try {
        ruleSet = await deps.loadActiveRuleSet(CLIENT_ID);
      } catch (err) {
        const typed = err instanceof RuleSetNotFoundError || err instanceof RuleSetValidationError;
        if (!typed) {
          console.error("[order_lookup] No se pudo cargar el conjunto de reglas activo:", err);
        }
        deps.logQuery({
          endpoint: "order_lookup",
          input: { reference, outcome: typed ? "RULES_NOT_CONFIGURED" : "RULES_UNAVAILABLE" },
          resultCount: 0,
          durationMs: Date.now() - start,
        });
        res.status(503).json({ error: RULES_NOT_CONFIGURED_MESSAGE });
        return;
      }

      const today = new Date();
      const consolidation = await consolidateOrder(
        { order: identity.order, customer: identity.customer, today },
        ruleSet.stateGroups
      );

      const facts = computeOrderFacts(consolidation.facts, {
        stateGroups: ruleSet.stateGroups,
        brandLeadDays: ruleSet.brandLeadDays,
        holidays: ruleSet.holidays,
        inStockLeadDays: ruleSet.settings.inStockLeadDays,
        shortDelayMaxDays: ruleSet.settings.shortDelayMaxDays,
        returnRefundMaxBusinessDays: ruleSet.settings.returnRefundMaxBusinessDays,
      });

      const evaluation = evaluateRules(facts, ruleSet.decisions);
      const guidance = buildGuidance(evaluation, facts, consolidation.orderContext, ruleSet.templates, consolidation.extraContext);

      // Última puerta antes de que los datos salgan del servicio: campos
      // explícitos, nunca un spread de un objeto interno (la consolidación ya
      // aplica whitelist, pero un spread futuro de un campo nuevo agregado
      // río arriba pasaría acá sin que nadie lo note).
      const response: OrderLookupResponseBody = {
        found: true,
        identity_verified: true,
        order: {
          id: consolidation.order.id,
          reference: consolidation.order.reference,
          dateAdd: consolidation.order.dateAdd,
          status: { id: consolidation.order.status.id, name: consolidation.order.status.name },
          group: consolidation.order.group,
          totals: {
            totalPaid: consolidation.order.totals.totalPaid,
            shippingPaid: consolidation.order.totals.shippingPaid,
          },
          currency: consolidation.order.currency,
          // Cuándo entró en cada estado. Responde "¿desde cuándo lleva así?", que es
          // literalmente lo que pregunta el cliente cuando un pedido se queda quieto.
          timeline: consolidation.order.timeline.map((change) => ({
            stateId: change.stateId,
            group: change.group,
            date: change.date,
          })),
          // Dirección de entrega, sin calle ni número: dato personal de más en el contexto del
          // modelo, y el agente no lo necesita para responder.
          deliveryAddress: {
            pickupPointName: consolidation.order.deliveryAddress.pickupPointName,
            city: consolidation.order.deliveryAddress.city,
            postcode: consolidation.order.deliveryAddress.postcode,
            countryId: consolidation.order.deliveryAddress.countryId,
            countryIso: consolidation.order.deliveryAddress.countryIso,
          },
        },
        customer: {
          firstname: consolidation.customer.firstname,
          lastname: consolidation.customer.lastname,
          email: consolidation.customer.email,
          idLang: consolidation.customer.idLang,
        },
        lines: consolidation.lines.map((line) => ({
          name: line.name,
          brand: line.brand,
          quantity: line.quantity,
          stockQuantity: line.stockQuantity,
          covered: line.covered,
        })),
        shipping: {
          // Siempre "OUTBOUND": ver el JSDoc de `ConsolidatedShipping.direction`. Se lista
          // explícitamente, igual que el resto de los campos de este objeto, para que un
          // agente nunca la confunda con el seguimiento de un retorno (§ conversación VJWIRCHVQ).
          direction: consolidation.shipping.direction,
          carrierName: consolidation.shipping.carrierName,
          trackingNumber: consolidation.shipping.trackingNumber,
          trackingUrl: consolidation.shipping.trackingUrl,
          shippedWithoutTracking: consolidation.shipping.shippedWithoutTracking,
          shippedAt: consolidation.shipping.shippedAt,
          // Plazo que promete el transportista, ya resuelto al idioma del cliente.
          carrierDelay: consolidation.shipping.carrierDelay,
        },
        refund:
          consolidation.refund === null
            ? null
            : {
                amount: consolidation.refund.amount,
                type: consolidation.refund.type,
                voucherExpiresAt: consolidation.refund.voucherExpiresAt,
                processedDate: consolidation.refund.processedDate,
                // Qué líneas cubrió el avoir: sin esto el payload solo decía "se abonaron X €"
                // sin poder decir de qué producto (caso real LLKVUZDZD, cuatro artículos).
                lines: consolidation.refund.lines.map((line) => ({
                  name: line.name,
                  quantity: line.quantity,
                  amount: line.amount,
                })),
              },
        return: {
          dataAvailable: consolidation.return.dataAvailable,
          reason: consolidation.return.reason,
          completed: consolidation.return.completed,
        },
        conversation: {
          threadId: consolidation.conversation.threadId,
          lastMessage: consolidation.conversation.lastMessage,
          lastMessageDate: consolidation.conversation.lastMessageDate,
          awaitingShopReply: consolidation.conversation.awaitingShopReply,
          // Los últimos 10 mensajes reales de TODOS los hilos del pedido. Sin esto el
          // agente no ve lo que ya se le dijo al cliente y se contradice: en el pedido
          // YOGGHZYXI la tienda había prometido "2 à 5 jours ouvrés" cuando la tabla de
          // plazos de la propia tienda dice 9 para esa marca.
          messages: consolidation.conversation.messages.map((message) => ({
            date: message.date,
            author: message.author,
            authorCertain: message.authorCertain,
            text: message.text,
            threadId: message.threadId,
          })),
        },
        // Responde "¿dónde me devuelven el dinero?": nunca la cadena enmascarada completa,
        // solo los últimos 4 dígitos (ver `computePayment` en order-consolidation.ts).
        payment:
          consolidation.payment === null
            ? null
            : {
                method: consolidation.payment.method,
                cardLast4: consolidation.payment.cardLast4,
                amount: consolidation.payment.amount,
                date: consolidation.payment.date,
              },
        guidance: {
          situation: guidance.situation,
          can_answer: guidance.can_answer,
          must_escalate: guidance.must_escalate,
          escalate_reason: guidance.escalate_reason,
          reply_language: guidance.reply_language,
          facts_to_convey: guidance.facts_to_convey.map((fact) => ({ key: fact.key, value: fact.value })),
          must_not_claim: [...guidance.must_not_claim],
          reference_template: guidance.reference_template,
          template_text: guidance.template_text,
          missing_facts: [...guidance.missing_facts],
          notify_team: guidance.notify_team,
          // Aditivo (T4): `guidance.return_inquiry` está ausente cuando no aplica (grupo R/F) o el
          // conjunto de reglas activo no tiene plantilla MAIL_8 (conjunto viejo, previo a T4). Se
          // hace explícito acá, nunca con un spread, igual que el resto de este objeto.
          ...(guidance.return_inquiry !== undefined
            ? {
                return_inquiry: {
                  reference_template: guidance.return_inquiry.reference_template,
                  template_text: guidance.return_inquiry.template_text,
                  instruction: guidance.return_inquiry.instruction,
                },
              }
            : {}),
        },
      };

      deps.logQuery({
        endpoint: "order_lookup",
        input: { reference, outcome: evaluation.outcome },
        resultCount: 1,
        durationMs: Date.now() - start,
      });

      res.status(200).json(response);
    } catch (err) {
      if (err instanceof PrestashopUnavailableError) {
        // Un fallo transitorio de PrestaShop durante la consolidación (después de
        // verificar la identidad) es el mismo tipo de problema que un fallo
        // transitorio durante la verificación: nunca se disfraza de "no coincide".
        res.status(503).json({ error: SERVICE_UNAVAILABLE_MESSAGE });
        return;
      }
      console.error("[order_lookup] Error:", err);
      res.status(500).json({ error: "Error interno al consultar el pedido" });
    }
  };
}

/** Instancia de producción, con las dependencias reales. Misma firma que el resto de los handlers. */
export const orderLookup = createOrderLookupHandler();
