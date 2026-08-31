/**
 * Clasificación y normalización de las categorías del feed de Prestashop.
 *
 * El feed mete en la misma bolsa cuatro cosas distintas (1232 valores):
 *   - taxonomía real ("Soutiens-Gorge Grandes Tailles", "Lingerie Coton") — 57% de los pares
 *   - marcas ("Aubade", "Slips Eminence", "Marques") — 20%, ya cubiertas por el campo `brand`
 *   - colecciones y páginas de color ("Every Curve (Frozen Grey)", "Amourette") — 19%
 *   - promo/temporada ("Saint-Valentin", "PROMOS Destockage") — 6%
 *
 * Nada se descarta: cada categoría se etiqueta con su `kind` y recibe la grafía
 * canónica de su concepto, para que "Boxers, shorties" y "Boxers & shorties" dejen
 * de ser dos categorías que no se encuentran entre sí.
 *
 * La decisión se toma por CONCEPTO, no por grafía: si dos formas del mismo concepto
 * cayeran en clases distintas, el filtro daría un resultado u otro según cómo se
 * escribiera el término.
 */

export type CategoryKind = "taxonomia" | "marca" | "coleccion" | "promo";

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Minúsculas, sin acentos, espacios colapsados. */
export function normalizeName(s: string): string {
  return stripAccents(s.toLowerCase().trim()).replace(/\s+/g, " ");
}

/** Partículas que no distinguen un concepto: "Laine & Soie" ≡ "Laine et Soie". */
const STOPWORDS = new Set([
  "a", "au", "aux", "de", "des", "du", "d", "en", "et", "l", "la", "le", "les", "pour", "sur",
]);

/**
 * Clave de concepto: ignora mayúsculas, acentos, puntuación, partículas y ORDEN de
 * las palabras. "Culottes, slips, strings" y "Slips, Culottes, Strings" caen en la
 * misma clave. Es una clave interna de agrupación, nunca se muestra.
 */
export function conceptKey(name: string): string {
  return normalizeName(name)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .sort()
    .join(" ");
}

/** Temporadas, promociones y operativa de tienda: no describen el producto. */
const PROMO_RE =
  /\b(promo|promos|destockage|soldes|noel|saint-valentin|black friday|outlet|bons plans|nouveaut|derniere chance|fete des meres|cadeau|offre|selection)\b/;

/** Un paréntesis en el nombre siempre marca colección o color: "Danse des Sens (Noir)". */
const PARENS_RE = /\(.+\)/;

/** Sufijo de universo que el feed añade a las gammas: "La Bohème - Bain". */
const UNIVERSE_SUFFIX_RE = / - (bain|femme|homme)$/;

/** Lo observado sobre el feed completo que hace falta para clasificar. */
export interface CategoryFacts {
  /** Nombre tal cual viene del feed → nº de productos que lo llevan. */
  counts: Map<string, number>;
  /** Nombre del feed → marcas distintas de sus productos. */
  brandsPerName: Map<string, Set<string>>;
}

export interface ClassifiedCategory {
  kind: CategoryKind;
  canonical: string;
}

/** ¿El nombre solo repite una marca del catálogo? ("Aubade", "Slips Eminence") */
function looksLikeBrand(normalized: string, brands: Set<string>): boolean {
  if (normalized === "marques" || brands.has(normalized)) return true;
  // Se exigen 4+ caracteres para no marcar "HOM" dentro de cualquier palabra.
  for (const b of brands) {
    if (b.length < 4) continue;
    if (
      normalized.startsWith(b + " ") ||
      normalized.endsWith(" " + b) ||
      normalized === b.replace(/ /g, "")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Clasifica todas las categorías del feed y les asigna su grafía canónica.
 *
 * @param facts        recuento y marcas por nombre, observados sobre el feed completo
 * @param brands       marcas del catálogo (`products.brand`), normalizadas
 * @param collections  gammas del catálogo (`products.collection`), normalizadas
 */
export function classifyCatalog(
  facts: CategoryFacts,
  brands: Set<string>,
  collections: Set<string>
): Map<string, ClassifiedCategory> {
  // 1. Agrupar las grafías por concepto.
  const groups = new Map<string, string[]>();
  for (const name of facts.counts.keys()) {
    const key = conceptKey(name);
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }

  const result = new Map<string, ClassifiedCategory>();

  for (const names of groups.values()) {
    // 2. Grafía canónica: la más legible. Primero las que no van en mayúsculas
    //    sostenidas, luego la más frecuente y, a igualdad, la primera alfabética.
    const canonical = [...names].sort((a, b) => {
      const capsA = a === a.toUpperCase() ? 1 : 0;
      const capsB = b === b.toUpperCase() ? 1 : 0;
      if (capsA !== capsB) return capsA - capsB;
      const diff = (facts.counts.get(b) ?? 0) - (facts.counts.get(a) ?? 0);
      return diff !== 0 ? diff : a.localeCompare(b);
    })[0];

    // 3. El concepto se clasifica una sola vez, mirando todas sus grafías.
    const conceptBrands = new Set<string>();
    for (const n of names) for (const b of facts.brandsPerName.get(n) ?? []) conceptBrands.add(b);
    const norm = normalizeName(canonical);
    const isGamme = names.some((n) =>
      collections.has(normalizeName(n).replace(UNIVERSE_SUFFIX_RE, "").trim())
    );

    let kind: CategoryKind;
    if (names.some((n) => PARENS_RE.test(n))) {
      kind = "coleccion";
    } else if (PROMO_RE.test(norm)) {
      kind = "promo";
    } else if (looksLikeBrand(norm, brands)) {
      kind = "marca";
    } else if (isGamme && conceptBrands.size <= 1) {
      // Una gamma pertenece a una sola marca. Un eje de taxonomía que por casualidad
      // se llama igual que una gamma ("Invisibles", "Chaussettes", "Culottes
      // sculptantes") lo comparten varias marcas, y así no se pierde.
      kind = "coleccion";
    } else {
      kind = "taxonomia";
    }

    for (const n of names) result.set(n, { kind, canonical });
  }

  return result;
}
