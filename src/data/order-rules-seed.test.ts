import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBrandKey } from "../lib/brand-normalize";
import { matchesDelayBucket, type DelayBucket as FactDelayBucket } from "../lib/order-facts";
import {
  brandLeadTimeSeed,
  ruleDecisionSeed,
  ruleTemplateSeed,
  stateGroupSeed,
} from "./order-rules-seed";

/**
 * Tests de la costura entre la siembra y el runtime.
 *
 * La siembra y el cálculo de hechos se escribieron por separado, y el riesgo de
 * esa separación no está dentro de ninguna de las dos: está en que dejen de
 * hablar el mismo idioma. Un desajuste acá no rompe el build ni lanza un error,
 * solo hace que a un cliente se le escale en vez de contestarle. Estos tests
 * existen para que ese desajuste falle en CI y no en producción.
 */

const FACT_BUCKETS: FactDelayBucket[] = ["NONE", "SHORT", "LONG"];

describe("siembra ↔ runtime: claves de marca", () => {
  test("cada brandKey sembrada es la que produce la normalización del runtime", () => {
    for (const row of brandLeadTimeSeed) {
      assert.equal(
        row.brandKey,
        normalizeBrandKey(row.brand),
        `la clave sembrada de "${row.brand}" no coincide con normalizeBrandKey`
      );
    }
  });

  test("no hay dos marcas distintas colapsando en la misma clave", () => {
    const vistas = new Map<string, string>();
    for (const row of brandLeadTimeSeed) {
      const previa = vistas.get(row.brandKey);
      assert.equal(previa, undefined, `"${row.brand}" y "${previa}" comparten clave ${row.brandKey}`);
      vistas.set(row.brandKey, row.brand);
    }
  });

  test("las submarcas reales del catálogo están cubiertas", () => {
    // Sin estas, 311 productos activos caerían en "marca desconocida → escalar".
    const claves = new Set(brandLeadTimeSeed.map((r) => r.brandKey));
    for (const marca of ["Prima Donna Twist", "Prima Donna Bain", "Aubade Men", "Simone Perele", "Eden Park"]) {
      assert.ok(claves.has(normalizeBrandKey(marca)), `falta plazo para "${marca}"`);
    }
  });
});

describe("siembra ↔ runtime: tramos de retraso", () => {
  test("POSITIVE cubre SHORT y LONG pero no NONE", () => {
    assert.equal(matchesDelayBucket("NONE", "POSITIVE"), false);
    assert.equal(matchesDelayBucket("SHORT", "POSITIVE"), true);
    assert.equal(matchesDelayBucket("LONG", "POSITIVE"), true);
  });

  test("null en una fila significa cualquiera", () => {
    for (const b of FACT_BUCKETS) assert.equal(matchesDelayBucket(b, null), true);
  });

  test("ninguna condición sembrada es inalcanzable", () => {
    // Una fila cuya condición no pueda matchear ningún hecho es una fila muerta:
    // el pedido cae al fail-safe y escala en silencio en vez de recibir su mail.
    for (const regla of ruleDecisionSeed) {
      if (regla.delayBucket === null || regla.delayBucket === undefined) continue;
      const alcanzable = FACT_BUCKETS.some((b) => matchesDelayBucket(b, regla.delayBucket!));
      assert.ok(
        alcanzable,
        `la fila ${regla.priority} (${regla.outcome}) exige delayBucket=${regla.delayBucket}, que ningún hecho produce`
      );
    }
  });
});

describe("integridad de la matriz", () => {
  test("las prioridades son únicas", () => {
    const p = ruleDecisionSeed.map((r) => r.priority);
    assert.equal(new Set(p).size, p.length, "hay prioridades repetidas: el orden de evaluación sería ambiguo");
  });

  test("la última fila es un cajón de sastre que escala", () => {
    const ordenadas = [...ruleDecisionSeed].sort((a, b) => a.priority - b.priority);
    const ultima = ordenadas[ordenadas.length - 1];
    assert.equal(ultima.outcome, "ESCALATE");
    for (const cond of [
      ultima.stateGroup,
      ultima.stockStatus,
      ultima.brandCount,
      ultima.delayBucket,
      ultima.hasTracking,
      ultima.historyHasInfo,
      ultima.refundIssued,
    ]) {
      assert.equal(cond ?? null, null, "el cajón de sastre no puede llevar condiciones");
    }
  });

  test("todo desenlace de la matriz tiene plantilla, salvo ESCALATE", () => {
    const conPlantilla = new Set(ruleTemplateSeed.map((t) => t.outcome));
    for (const regla of ruleDecisionSeed) {
      if (regla.outcome === "ESCALATE") continue;
      assert.ok(conPlantilla.has(regla.outcome), `${regla.outcome} sale de la matriz pero no tiene plantilla`);
    }
  });

  test("MAIL_8 es la única plantilla sembrada sin fila propia en la matriz, a propósito (T4)", () => {
    // El resto de plantillas sembradas corresponden 1:1 a una fila real de la matriz. MAIL_8
    // (retorno en curso, texto A.5) es la excepción deliberada: `order_lookup` no sabe si la
    // pregunta del cliente es sobre una devolución, así que `buildGuidance` la entrega siempre
    // como el bloque adicional `return_inquiry`, nunca como el desenlace principal (§ JSDoc de
    // `RuleOutcome` en este fichero). Este test documenta esa excepción en vez de dejarla pasar
    // en silencio: si alguna otra plantilla queda huérfana en el futuro, debe fallar acá.
    const outcomesConFila = new Set(ruleDecisionSeed.map((r) => r.outcome));
    const plantillasHuerfanas = ruleTemplateSeed.filter((t) => !outcomesConFila.has(t.outcome));
    assert.deepEqual(plantillasHuerfanas.map((t) => t.outcome), ["MAIL_8"]);
  });

  test("notifyTeam: solo MAIL_15 lo pide, ninguna otra plantilla sembrada (T4)", () => {
    // Guarda de regresión concreta: MAIL_15 es el único texto sembrado que promete un seguimiento
    // del equipo ("nous reviendrons vers vous dans un délai de 48 heures ouvrées", § hallazgo 7).
    const conNotifyTeam = ruleTemplateSeed.filter((t) => t.notifyTeam).map((t) => t.outcome);
    assert.deepEqual(conNotifyTeam, ["MAIL_15"]);
  });

  test("los grupos de estado sembrados son los verificados contra PrestaShop", () => {
    const porGrupo = new Map<string, number[]>();
    for (const s of stateGroupSeed) {
      porGrupo.set(s.groupCode, [...(porGrupo.get(s.groupCode) ?? []), s.orderStateId].sort((a, b) => a - b));
    }
    assert.deepEqual(porGrupo.get("A"), [2, 3, 9, 17, 18]);
    // Estado 5 "Livré" (T5): ya estaba a mano en el conjunto de reglas v2 en base, faltaba en esta
    // siembra (67 pedidos de los últimos 8.000 vistos por estado actual).
    assert.deepEqual(porGrupo.get("B"), [4, 5, 10, 31]);
    assert.deepEqual(porGrupo.get("C"), [14]);
    assert.deepEqual(porGrupo.get("R"), [61]);
    // Grupo F (reembolso): 83/68/7 con volumen real verificado (§ hallazgo "Mejora E"),
    // 39/63 sembrados igual aunque sin volumen visto todavía.
    assert.deepEqual(porGrupo.get("F"), [7, 39, 63, 68, 83]);
  });

  test("las filas del grupo R son las dos únicas que usan refundIssued, con true y false", () => {
    const filasR = ruleDecisionSeed.filter((r) => r.stateGroup === "R");
    assert.equal(filasR.length, 2);
    assert.deepEqual(
      filasR.map((r) => r.refundIssued).sort(),
      [false, true]
    );
    for (const regla of ruleDecisionSeed) {
      if (regla.stateGroup === "R") continue;
      assert.equal(regla.refundIssued, null, `la fila ${regla.priority} (${regla.outcome}) no es del grupo R y no debería exigir refundIssued`);
    }
  });
});
