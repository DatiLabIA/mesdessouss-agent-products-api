/**
 * Comprobación end-to-end de la cadena completa contra PrestaShop REAL:
 * identidad -> consolidación -> hechos -> matriz -> guidance.
 *
 * Existe porque los tests unitarios stubean `fetch`, y un stub solo prueba lo
 * que creemos que devuelve la API. Esta comprobación encontró cuatro fallos que
 * la suite entera en verde no veía: el join de marcas roto por comparar número
 * contra string, la URL de seguimiento sin resolver, el estado de retorno
 * siempre en false, y el nombre de estado viajando como array multiidioma.
 *
 * Uso: pnpm check:pipeline <REFERENCIA> <EMAIL>
 * Requiere PRESTASHOP_API_KEY en el entorno. Solo lee, no escribe nada.
 */
import { verifyOrderIdentity } from "../src/lib/order-identity";
import { consolidateOrder } from "../src/lib/order-consolidation";
import { computeOrderFacts } from "../src/lib/order-facts";
import { evaluateRules, buildGuidance } from "../src/lib/rule-evaluator";
import { normalizeBrandKey } from "../src/lib/brand-normalize";
import { frenchPublicHolidays } from "../src/lib/business-days";
import {
  stateGroupSeed, brandLeadTimeSeed, ruleDecisionSeed, ruleTemplateSeed,
} from "../src/data/order-rules-seed";

const REF = process.argv[2] ?? "LLKVUZDZD";
const EMAIL = process.argv[3] ?? "marie54140@hotmail.fr";

(async () => {
  const id = await verifyOrderIdentity({ reference: REF, email: EMAIL });
  if (id.outcome !== "VERIFIED") { console.log("identidad:", id.outcome); return; }

  const stateGroups = new Map(stateGroupSeed.map((s) => [s.orderStateId, s.groupCode as any]));
  const today = new Date();
  const c = await consolidateOrder({ order: id.order, customer: id.customer, today }, stateGroups);

  const holidays = new Set<string>();
  for (const y of [today.getUTCFullYear() - 1, today.getUTCFullYear(), today.getUTCFullYear() + 1])
    for (const h of frenchPublicHolidays(y)) holidays.add(h.day);

  const facts = computeOrderFacts(c.facts, {
    stateGroups,
    brandLeadDays: new Map(brandLeadTimeSeed.map((b) => [b.brandKey, b.leadDays])),
    holidays, inStockLeadDays: 2, shortDelayMaxDays: 3, returnRefundMaxBusinessDays: 7,
  });

  const verdict = evaluateRules(facts, ruleDecisionSeed);
  const g = buildGuidance(verdict, facts, c.orderContext, ruleTemplateSeed, c.extraContext);

  console.log("pedido     :", c.order.reference, "| estado", c.order.status.id, c.order.status.name, "| grupo", facts.stateGroup);
  console.log("lineas     :", c.lines.map((l: any) => `${l.brand ?? "(sin marca)"}[stock=${l.stockQuantity}]`).join(" "));
  console.log("marcas norm:", c.lines.map((l: any) => l.brand ? normalizeBrandKey(l.brand) : "-").join(" "));
  console.log("stock      :", facts.stockStatus, "| afectadas:", facts.affectedBrands, "| desconocidas:", facts.unknownBrands);
  console.log("plazo      :", facts.leadDays, "| limite:", facts.limitDate?.toISOString().slice(0,10), "| retraso:", facts.delayDays, facts.delayBucket);
  console.log("tracking   :", c.shipping.trackingNumber ?? "(ninguno)", "| url:", c.shipping.trackingUrl ?? "-");
  console.log("retorno    :", JSON.stringify(c.return));
  console.log("reembolso  :", JSON.stringify(c.refund));
  console.log("conversa   : awaitingShopReply =", c.conversation?.awaitingShopReply, "| historyHasInfo =", c.facts.historyHasInfo);
  console.log("---");
  console.log("VEREDICTO  :", verdict.outcome, "|", (verdict as any).reason ?? (verdict as any).trace?.note ?? "");
  console.log("guidance   :", JSON.stringify({
    situation: g.situation, must_escalate: g.must_escalate, lang: g.reply_language,
    facts: g.facts_to_convey, missing: g.missing_facts,
    notify_team: g.notify_team,
    template_text: g.template_text ? `${g.template_text.slice(0, 80)}…` : null,
    return_inquiry: g.return_inquiry ? g.return_inquiry.reference_template : null,
  }, null, 2));
})().catch((e) => { console.error("FALLO:", e); process.exit(1); });
