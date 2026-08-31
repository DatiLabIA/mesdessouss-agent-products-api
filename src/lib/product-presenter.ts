/**
 * Adaptador al formato de la convención de productos para microservicios
 * (docs/convencion-productos-microservicios.md).
 *
 * El producto se reparte en tres cajones:
 *   - núcleo       → identidad, foto, precio, enlace. Se pinta siempre.
 *   - `attributes` → lista ORDENADA por importancia y ya escrita. DatiHub la pinta
 *                    tal cual y recorta por el final si no cabe.
 *   - `details`    → NUNCA se pinta: es el contexto que necesita el modelo para
 *                    conversar ("¿es de encaje?", "¿queda stock?").
 *
 * Para mesdessous: `attributes` = talla, color, material; `details` = composición
 * estructurada, material crudo, categorías, subtipo, stock y descripción.
 */
import { stripAccents } from "./material-parser";
import type { CatalogProduct, MaterialComposition, ProductAttribute, ProductDetails } from "../types";

/** Todo el catálogo de mesdessous factura en euros. El precio va crudo; DatiHub lo formatea. */
export const CURRENCY = "EUR";

/**
 * Nombres de tejido (no de fibra) que aparecen al principio de la composición cruda:
 * "DENTELLE:73% POLYAMIDE…", "dentelle 100% Polyester|maille 100% Polyamide".
 * Es lo que el cliente reconoce de un vistazo, mucho más que "Polyamide".
 * Clave normalizada (minúsculas, sin acentos) → etiqueta que se pinta.
 */
const FABRIC_LABELS: Record<string, string> = {
  dentelle: "Dentelle", guipure: "Guipure", broderie: "Broderie", plumetis: "Plumetis",
  tulle: "Tulle", resille: "Résille", microfibre: "Microfibre", satin: "Satin",
  velours: "Velours", jersey: "Jersey", maille: "Maille", mousseline: "Mousseline",
  gaze: "Gaze", popeline: "Popeline", molleton: "Molleton", eponge: "Éponge",
  crepe: "Crêpe",
};

/** Fibra canónica del parser → etiqueta que se pinta (acentuada, en francés). */
const FIBER_LABELS: Record<string, string> = {
  coton: "Coton", polyamide: "Polyamide", elasthanne: "Élasthanne", polyester: "Polyester",
  polyurethane: "Polyuréthane", viscose: "Viscose", soie: "Soie", modal: "Modal",
  micromodal: "Micromodal", laine: "Laine", lyocell: "Lyocell", microfibre: "Microfibre",
  dentelle: "Dentelle", lin: "Lin", acrylique: "Acrylique", metallise: "Métallisé",
  polypropylene: "Polypropylène", aramide: "Aramide", cachemire: "Cachemire",
  angora: "Angora", mohair: "Mohair", bambou: "Bambou", acetate: "Acétate",
};

// Alternación ordenada por longitud desc para que el nombre largo gane al corto.
const FABRIC_RE = new RegExp(
  String.raw`\b(${Object.keys(FABRIC_LABELS).sort((a, b) => b.length - a.length).join("|")})\b`
);

/**
 * Etiqueta corta de material para la ficha. El string crudo ("DENTELLE: 89% Polyamide
 * 11% Elasthanne") son 40 caracteres de ruido en un caption de WhatsApp: se resume al
 * tejido principal y el detalle completo viaja en `details`.
 *
 * 1. Primer tejido nombrado en el crudo (el de más a la izquierda es el principal).
 * 2. Si no hay tejido, la fibra dominante del cuerpo (o del forro, si solo hay forro).
 * 3. Si no hay nada legible, no se manda el atributo.
 */
export function materialLabel(
  raw: string | null,
  composition: MaterialComposition[]
): string | null {
  if (raw) {
    const fabric = stripAccents(raw.toLowerCase()).match(FABRIC_RE);
    if (fabric) return FABRIC_LABELS[fabric[1]];
  }

  const corps = composition.filter((c) => c.zone === "corps");
  const pool = corps.length > 0 ? corps : composition;
  if (pool.length === 0) return null;

  const dominant = pool.reduce((best, c) => (c.pct > best.pct ? c : best));
  return FIBER_LABELS[dominant.fiber] ?? dominant.fiber[0].toUpperCase() + dominant.fiber.slice(1);
}

/** Añade el atributo solo si tiene valor: un atributo vacío se descarta igual. */
function push(attributes: ProductAttribute[], label: string, value: string | null): void {
  const trimmed = value?.trim();
  if (trimmed) attributes.push({ label, value: trimmed });
}

/** Fila de `products` con lo que el presentador necesita. */
export interface PresentableRow {
  product_id: string;
  base_product_id: string;
  name: string;
  brand: string | null;
  type: string | null;
  sub_type: string | null;
  price: string | null;
  old_price: string | null;
  color: string | null;
  sizes: string | null;
  materials: string | null;
  product_url: string | null;
  image_url: string | null;
  description: string | null;
  quantity: number | null;
}

/**
 * Convierte una fila del catálogo al producto de la convención.
 * Devuelve `null` si le falta algún campo obligatorio del núcleo (imagen, enlace o
 * precio): sin ellos no hay ficha que pintar. La query ya los exige; esto es la red.
 */
export function toCatalogProduct(
  row: PresentableRow,
  categories: string[],
  composition: MaterialComposition[]
): CatalogProduct | null {
  const price = row.price !== null ? parseFloat(row.price) : NaN;
  if (!row.image_url || !row.product_url || !Number.isFinite(price)) return null;

  const attributes: ProductAttribute[] = [];
  push(attributes, "Taille", row.sizes);
  push(attributes, "Couleur", row.color);
  push(attributes, "Matière", materialLabel(row.materials, composition));

  const oldPrice = row.old_price !== null ? parseFloat(row.old_price) : NaN;
  const stock = row.quantity ?? 0;

  const details: ProductDetails = {
    baseProductId: row.base_product_id,
    stock,
    ...(row.type ? { type: row.type } : {}),
    ...(row.sub_type ? { subType: row.sub_type } : {}),
    ...(row.materials ? { rawMaterial: row.materials } : {}),
    ...(composition.length > 0 ? { composition } : {}),
    ...(categories.length > 0 ? { categories } : {}),
    ...(row.description ? { description: row.description } : {}),
  };

  return {
    id: row.product_id,
    title: row.name,
    ...(row.brand ? { subtitle: row.brand } : {}),
    image: row.image_url,
    url: row.product_url,
    price,
    currency: CURRENCY,
    // Solo si hay descuento real: DatiHub pinta el tachado cuando oldPrice > price.
    ...(Number.isFinite(oldPrice) && oldPrice > price ? { oldPrice } : {}),
    available: stock > 0,
    attributes,
    details,
  };
}
