/**
 * Parser de composición de material (texto libre de Prestashop → estructura).
 *
 * NO se llama en cada query: se ejecuta offline en el sync de materiales, una vez
 * por string distinto (cacheado por raw_string). El campo `materials` crudo NO se toca.
 *
 * Estrategia clave (formato-consciente): la composición viene en dos órdenes mezclados
 *   - "47% Coton/39% Polyamide"      (porcentaje ANTES de la fibra)
 *   - "Polyester 33% Coton 7%"        (porcentaje DESPUÉS de la fibra)
 * Parsear a ciegas con ambos patrones mal-atribuye (ej: "elasthanne 9% coton 7%" → coton=9).
 * Solución: parsear en las dos interpretaciones y quedarse con la que suma ≈100 por zona.
 */

export type MaterialZone = "corps" | "doublure";
export type ParseStatus = "ok" | "needs_review" | "failed";

export interface ParsedFiber {
  fiber: string; // canónico, ej: "coton"
  pct: number;
  zone: MaterialZone;
}

export interface ParsedComposition {
  fibers: ParsedFiber[];
  status: ParseStatus;
}

/** Sinónimo (normalizado, sin acentos) → fibra canónica. */
const FIBER_SYNONYMS: Record<string, string> = {
  coton: "coton", cotton: "coton", algodon: "coton",
  polyamide: "polyamide", poliamida: "polyamide", nylon: "polyamide", pa: "polyamide",
  elasthanne: "elasthanne", elasthane: "elasthanne", elastanne: "elasthanne",
  elastane: "elasthanne", elastano: "elasthanne", lycra: "elasthanne", ea: "elasthanne",
  polyester: "polyester", poliester: "polyester", pes: "polyester",
  polyurethane: "polyurethane", polyurethanne: "polyurethane", pu: "polyurethane",
  viscose: "viscose", rayonne: "viscose", rayon: "viscose", cupro: "viscose", ecovero: "viscose",
  soie: "soie", silk: "soie", seda: "soie",
  modal: "modal", micromodal: "micromodal",
  laine: "laine", wool: "laine", lana: "laine", merinos: "laine",
  lyocell: "lyocell", lyocel: "lyocell", tencel: "lyocell",
  microfibre: "microfibre",
  dentelle: "dentelle",
  lin: "lin", linen: "lin", lino: "lin",
  acrylique: "acrylique", acrylic: "acrylique",
  metallise: "metallise", metallique: "metallise", metal: "metallise", metallic: "metallise",
  polypropylene: "polypropylene",
  aramide: "aramide",
  cachemire: "cachemire", cashmere: "cachemire",
  angora: "angora", mohair: "mohair", bambou: "bambou", bamboo: "bambou",
  acetate: "acetate",
  // "autres"/"other": no es filtrable pero cuenta para validar que la suma ≈100.
  autres: "autres", autre: "autres", other: "autres", others: "autres",
};

/** Fibras que existen solo para cuadrar la suma; no se almacenan ni se filtran. */
const NON_FILTERABLE = new Set(["autres"]);

// Alternación de sinónimos ordenada por longitud desc (para que "micromodal" gane a "modal").
const FIBER_ALT = Object.keys(FIBER_SYNONYMS)
  .sort((a, b) => b.length - a.length)
  .join("|");

// Marcadores de zona: a partir de aquí, las fibras son forro/doublure.
const LINING_RE = /\b(doublure|fond|forro|lining|face interne)\b/;

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Normaliza el string crudo: minúsculas, sin acentos, sin prefijos, separadores unificados. */
function normalize(raw: string): string {
  let s = stripAccents(raw.toLowerCase());
  s = s.replace(/mati[eè]res?\s*(principale)?\s*:?/g, " ");
  s = s.replace(/composition\s*:?/g, " ");
  s = s.replace(/[\/,;+:]/g, " "); // separadores → espacio (incluye ':' de "Coton:15%")
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Extrae pares (fibra, pct) de un segmento asumiendo un orden/formato concreto. */
function extractPairs(segment: string, order: "before" | "after" | "dash"): { fiber: string; pct: number }[] {
  let re: RegExp;
  if (order === "before") {
    // "47% Coton"
    re = new RegExp(`(\\d{1,3})\\s*%\\s*(?:de\\s+|d['’]\\s*)?(${FIBER_ALT})`, "g");
  } else if (order === "after") {
    // "Coton 7%", "Polyamide-38%", "Coton:15%" (':' ya normalizado a espacio)
    re = new RegExp(`(${FIBER_ALT})[\\s'’a-z.-]*?(\\d{1,3})\\s*%`, "g");
  } else {
    // "PA-Polyamide-72" (código-fibra-número, SIN '%')
    re = new RegExp(`(${FIBER_ALT})\\s*-\\s*(\\d{1,3})(?![\\d%])`, "g");
  }
  const pairs: { fiber: string; pct: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    const pctStr = order === "before" ? m[1] : m[2];
    const fiberTok = order === "before" ? m[2] : m[1];
    const pct = parseInt(pctStr, 10);
    const fiber = FIBER_SYNONYMS[fiberTok];
    if (fiber && pct > 0 && pct <= 100) pairs.push({ fiber, pct });
  }
  return pairs;
}

/** Consolida fibras repetidas (misma fibra dos veces en la zona → suma). */
function consolidate(pairs: { fiber: string; pct: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of pairs) map.set(p.fiber, (map.get(p.fiber) ?? 0) + p.pct);
  return map;
}

function sum(map: Map<string, number>): number {
  let t = 0;
  for (const v of map.values()) t += v;
  return t;
}

/** Elige la interpretación (before/after) cuya suma esté más cerca de 100. */
function parseSegment(segment: string): { map: Map<string, number>; valid: boolean } {
  const before = consolidate(extractPairs(segment, "before"));
  const after = consolidate(extractPairs(segment, "after"));
  const dash = consolidate(extractPairs(segment, "dash"));

  const candidates = [before, after, dash]
    .filter((m) => m.size > 0)
    .map((m) => ({ map: m, dist: Math.abs(sum(m) - 100) }))
    .sort((a, b) => a.dist - b.dist);

  if (candidates.length === 0) return { map: new Map(), valid: false };
  const best = candidates[0];
  return { map: best.map, valid: best.dist <= 2 };
}

/**
 * Parsea una composición cruda a fibras estructuradas con zona y estado.
 * Determinista y sin dependencias externas.
 */
export function parseComposition(raw: string): ParsedComposition {
  if (!raw || !raw.trim()) return { fibers: [], status: "failed" };

  const norm = normalize(raw);

  // Separar cuerpo vs. forro por el primer marcador de zona.
  const liningMatch = norm.match(LINING_RE);
  let corpsPart = norm;
  let liningPart = "";
  if (liningMatch && liningMatch.index !== undefined) {
    corpsPart = norm.slice(0, liningMatch.index);
    liningPart = norm.slice(liningMatch.index);
  }

  const corps = parseSegment(corpsPart);
  const lining = liningPart ? parseSegment(liningPart) : { map: new Map<string, number>(), valid: true };

  // Solo se conservan las fibras de una zona si esa zona valida (suma ≈100). Las zonas
  // con % poco fiables se descartan para no contaminar el ranking → el producto cae al
  // comportamiento substring actual. Aun así se marca needs_review para vigilar drift.
  const fibers: ParsedFiber[] = [];
  let anyExtracted = false;
  let anyInvalid = false;

  for (const [zoneName, seg] of [["corps", corps], ["doublure", lining]] as const) {
    if (seg.map.size === 0) continue;
    anyExtracted = true;
    if (!seg.valid) { anyInvalid = true; continue; }
    for (const [fiber, pct] of seg.map) {
      if (!NON_FILTERABLE.has(fiber)) fibers.push({ fiber, pct, zone: zoneName });
    }
  }

  if (!anyExtracted) return { fibers: [], status: "failed" };

  const status: ParseStatus = anyInvalid ? "needs_review" : "ok";
  return { fibers, status };
}

/** Normaliza el término de material recibido en la búsqueda a fibra canónica (o null). */
export function canonicalFiber(term: string): string | null {
  const key = stripAccents(term.toLowerCase().trim());
  return FIBER_SYNONYMS[key] ?? null;
}
