import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import type { ProductSearchInput, ProductSearchResponse, ProductResult } from "../types";

const CLIENT_ID = "mesdessous";

/** Normaliza string | string[] → string[] siempre */
export function toArray(val: string | string[] | undefined): string[] {
  if (!val) return [];
  return Array.isArray(val) ? val.filter(Boolean) : [val];
}

/** Construye el patrón regex para una talla: "95C" o "95 C" → matchea "95 C (eu 80)" */
function buildSizePattern(size: string): string | null {
  const normalized = size.trim().replace(/\s+/g, "").toUpperCase();
  // Solo aplica regex de copa para tallas de sujetador: número + 1 letra A-J (ej. 95C, 85B)
  const parts = normalized.match(/^(\d+)([A-J])$/);
  if (parts) {
    const [, num, letter] = parts;
    return `(^|,)\\s*${num}\\s*${letter}(\\s*\\([^)]*\\))?(,|$)`;
  }
  return null;
}

interface ProductRow {
  id: number;
  product_id: string;
  base_product_id: string;
  name: string;
  brand: string | null;
  type: string | null;
  sub_type: string | null;
  price: string | null;
  old_price: string | null;
  has_discount: boolean;
  discount_pct: number;
  color: string | null;
  sizes: string | null;
  materials: string | null;
  product_url: string | null;
  image_url: string | null;
  description: string | null;
  quantity: number | null;
}

/** Error lanzado cuando falta el campo obligatorio `type`. */
export class ProductSearchValidationError extends Error {}

/**
 * Busca productos (solo lectura) aplicando filtros. `type` es obligatorio.
 * Lógica compartida entre el endpoint REST y la tool MCP.
 */
export async function searchProducts(input: ProductSearchInput): Promise<ProductSearchResponse> {
  const types = toArray(input.type);
  if (types.length === 0) {
    throw new ProductSearchValidationError("El campo 'type' es obligatorio");
  }

  const conditions: Prisma.Sql[] = [
    Prisma.sql`client_id = ${CLIENT_ID}`,
    Prisma.sql`active = true`,
    Prisma.sql`(image_url LIKE '%.jpg' OR image_url LIKE '%.png' OR image_url LIKE '%.webp')`,
  ];

  // type: OR entre todos los valores
  const typeClauses = types.map(
    (t) => Prisma.sql`(LOWER(type) LIKE ${`%${t.toLowerCase()}%`} OR LOWER(sub_type) LIKE ${`%${t.toLowerCase()}%`})`
  );
  conditions.push(Prisma.sql`(${Prisma.join(typeClauses, " OR ")})`);

  // size: OR entre todas las tallas
  const sizes = toArray(input.size);
  if (sizes.length > 0) {
    const sizeClauses = sizes.map((s) => {
      const pattern = buildSizePattern(s);
      return pattern
        ? Prisma.sql`sizes ~* ${pattern}`
        : Prisma.sql`LOWER(sizes) LIKE ${`%${s.toLowerCase()}%`}`;
    });
    conditions.push(Prisma.sql`(${Prisma.join(sizeClauses, " OR ")})`);
  }

  // brand: OR entre todas las marcas
  const brands = toArray(input.brand);
  if (brands.length > 0) {
    const brandClauses = brands.map(
      (b) => Prisma.sql`LOWER(brand) LIKE ${`%${b.toLowerCase()}%`}`
    );
    conditions.push(Prisma.sql`(${Prisma.join(brandClauses, " OR ")})`);
  }

  // color: OR entre todos los colores
  const colors = toArray(input.color);
  if (colors.length > 0) {
    const colorClauses = colors.map(
      (c) => Prisma.sql`LOWER(color) LIKE ${`%${c.toLowerCase()}%`}`
    );
    conditions.push(Prisma.sql`(${Prisma.join(colorClauses, " OR ")})`);
  }

  // sub_type: OR entre todos los subtipos
  const subTypes = toArray(input.sub_type);
  if (subTypes.length > 0) {
    const subClauses = subTypes.map(
      (s) => Prisma.sql`(LOWER(sub_type) LIKE ${`%${s.toLowerCase()}%`} OR LOWER(name) LIKE ${`%${s.toLowerCase()}%`})`
    );
    conditions.push(Prisma.sql`(${Prisma.join(subClauses, " OR ")})`);
  }

  // material: OR entre todos los materiales
  const materials = toArray(input.material);
  if (materials.length > 0) {
    const matClauses = materials.map(
      (m) => Prisma.sql`LOWER(materials) LIKE ${`%${m.toLowerCase()}%`}`
    );
    conditions.push(Prisma.sql`(${Prisma.join(matClauses, " OR ")})`);
  }

  // category: OR entre todas las categorías (join a product_categories vía base_product_id)
  const categories = toArray(input.category);
  if (categories.length > 0) {
    const catClauses = categories.map(
      (c) => Prisma.sql`EXISTS (
        SELECT 1 FROM product_categories pc
        WHERE pc.client_id = products.client_id
          AND pc.base_product_id = products.base_product_id
          AND LOWER(pc.category) LIKE ${`%${c.toLowerCase()}%`}
      )`
    );
    conditions.push(Prisma.sql`(${Prisma.join(catClauses, " OR ")})`);
  }

  if (input.gender) {
    conditions.push(Prisma.sql`gender = ${input.gender}`);
  }

  if (input.min_price !== undefined) {
    conditions.push(Prisma.sql`price >= ${input.min_price}`);
  }

  if (input.max_price !== undefined) {
    conditions.push(Prisma.sql`price <= ${input.max_price}`);
  }

  const whereClause = Prisma.join(conditions, " AND ");

  // Con talla: filas exactas por variación. Sin talla: deduplicar por base_product_id
  const rows = sizes.length > 0
    ? await prisma.$queryRaw<ProductRow[]>`
        SELECT id, product_id, base_product_id, name, brand, type, sub_type, price, old_price,
               has_discount, discount_pct, color, sizes, materials, product_url, image_url, description, quantity
        FROM products
        WHERE ${whereClause}
        ORDER BY (quantity > 0) DESC, quantity DESC NULLS LAST, has_discount DESC, price ASC
        LIMIT 15
      `
    : await prisma.$queryRaw<ProductRow[]>`
        SELECT DISTINCT ON (base_product_id) id, product_id, base_product_id, name, brand, type, sub_type, price, old_price,
               has_discount, discount_pct, color, sizes, materials, product_url, image_url, description, quantity
        FROM products
        WHERE ${whereClause}
        ORDER BY base_product_id, (quantity > 0) DESC, quantity DESC NULLS LAST, has_discount DESC, price ASC
        LIMIT 10
      `;

  const products: ProductResult[] = rows.map((row) => ({
    id: row.product_id,
    base_product_id: row.base_product_id,
    name: row.name,
    brand: row.brand,
    type: row.type,
    sub_type: row.sub_type,
    price: row.price !== null ? parseFloat(row.price) : null,
    old_price: row.old_price !== null ? parseFloat(row.old_price) : null,
    has_discount: row.has_discount,
    discount_percentage: row.discount_pct,
    size: row.sizes ?? null,
    color: row.color ?? null,
    material: row.materials ?? null,
    quantity: row.quantity ?? 0,
    in_stock: (row.quantity ?? 0) > 0,
    url: row.product_url,
    image_url: row.image_url,
    description: row.description,
    categories: [],
  }));

  // Adjuntar las categorías de cada producto (join por base_product_id)
  if (products.length > 0) {
    const baseIds = [...new Set(rows.map((r) => r.base_product_id))];
    const catRows = await prisma.$queryRaw<{ base_product_id: string; category: string }[]>`
      SELECT base_product_id, category
      FROM product_categories
      WHERE client_id = ${CLIENT_ID}
        AND base_product_id IN (${Prisma.join(baseIds)})
      ORDER BY category ASC
    `;
    const catsByBase = new Map<string, string[]>();
    for (const cr of catRows) {
      const list = catsByBase.get(cr.base_product_id) ?? [];
      list.push(cr.category);
      catsByBase.set(cr.base_product_id, list);
    }
    for (const p of products) {
      p.categories = catsByBase.get(p.base_product_id) ?? [];
    }
  }

  const response: ProductSearchResponse = {
    products,
    total: products.length,
    filters_applied: input,
  };

  if (products.length === 0) {
    const typeLabel = types.join(" / ");
    const sizeLabel = sizes.length > 0 ? ` en talla ${sizes.join(" o ")}` : "";
    response.suggestion = `No se encontraron ${typeLabel}${sizeLabel}. Intenta con otros filtros.`;
  }

  return response;
}

// ─── Opciones de catálogo (valores distintos por campo) ────────────────────

export const CATALOG_FIELDS = [
  "type",
  "subType",
  "brand",
  "color",
  "gender",
  "styles",
  "materials",
  "collection",
  "category",
] as const;
export type CatalogField = (typeof CATALOG_FIELDS)[number];

// Campos que son columnas directas de `products` → columna SQL (para raw DISTINCT).
// `category` NO está aquí: vive en la tabla product_categories (manejo aparte).
const COLUMN_MAP: Record<Exclude<CatalogField, "category">, string> = {
  type: "type",
  subType: "sub_type",
  brand: "brand",
  color: "color",
  gender: "gender",
  styles: "styles",
  materials: "materials",
  collection: "collection",
};

export interface CatalogOptionsFilters {
  gender?: string;
  brand?: string;
  type?: string;
  subType?: string;
}

export interface CatalogOptionsResult {
  field: CatalogField;
  filters: CatalogOptionsFilters;
  count: number;
  values: string[];
}

/** Error lanzado cuando el campo pedido no es válido. */
export class CatalogFieldValidationError extends Error {}

/**
 * Devuelve los valores distintos de un campo del catálogo (solo lectura),
 * opcionalmente acotados por filtros. Lógica compartida REST + MCP.
 */
export async function getCatalogOptions(
  field: CatalogField,
  filters: CatalogOptionsFilters = {}
): Promise<CatalogOptionsResult> {
  if (!field || !CATALOG_FIELDS.includes(field)) {
    throw new CatalogFieldValidationError(
      `Campo inválido. Valores permitidos: ${CATALOG_FIELDS.join(", ")}`
    );
  }

  // `category` vive en product_categories; se resuelve con un join opcional a products.
  if (field === "category") {
    return getCategoryOptions(filters);
  }

  const column = COLUMN_MAP[field];

  const conditions: Prisma.Sql[] = [
    Prisma.sql`client_id = ${CLIENT_ID}`,
    Prisma.sql`active = true`,
    Prisma.sql`${Prisma.raw(column)} IS NOT NULL`,
    Prisma.sql`${Prisma.raw(column)} <> ''`,
  ];

  if (filters.gender) conditions.push(Prisma.sql`gender = ${filters.gender}`);
  if (filters.brand) conditions.push(Prisma.sql`LOWER(brand) = LOWER(${filters.brand})`);
  if (filters.type) conditions.push(Prisma.sql`LOWER(type) = LOWER(${filters.type})`);
  if (filters.subType) conditions.push(Prisma.sql`LOWER(sub_type) = LOWER(${filters.subType})`);

  const where = Prisma.join(conditions, " AND ");

  const rows = await prisma.$queryRaw<{ value: string }[]>(
    Prisma.sql`SELECT DISTINCT ${Prisma.raw(column)} AS value
               FROM products
               WHERE ${where}
               ORDER BY ${Prisma.raw(column)} ASC`
  );

  const values = rows.map((r) => r.value).filter(Boolean);

  return { field, filters, count: values.length, values };
}

/**
 * Valores distintos de categoría (tabla product_categories). Si hay filtros,
 * solo considera categorías de productos activos que cumplan esos filtros.
 */
async function getCategoryOptions(filters: CatalogOptionsFilters): Promise<CatalogOptionsResult> {
  const hasFilters = Boolean(filters.gender || filters.brand || filters.type || filters.subType);

  let rows: { value: string }[];
  if (!hasFilters) {
    rows = await prisma.$queryRaw<{ value: string }[]>`
      SELECT DISTINCT category AS value
      FROM product_categories
      WHERE client_id = ${CLIENT_ID}
      ORDER BY category ASC
    `;
  } else {
    const productConds: Prisma.Sql[] = [
      Prisma.sql`p.client_id = ${CLIENT_ID}`,
      Prisma.sql`p.active = true`,
    ];
    if (filters.gender) productConds.push(Prisma.sql`p.gender = ${filters.gender}`);
    if (filters.brand) productConds.push(Prisma.sql`LOWER(p.brand) = LOWER(${filters.brand})`);
    if (filters.type) productConds.push(Prisma.sql`LOWER(p.type) = LOWER(${filters.type})`);
    if (filters.subType) productConds.push(Prisma.sql`LOWER(p.sub_type) = LOWER(${filters.subType})`);
    const where = Prisma.join(productConds, " AND ");

    rows = await prisma.$queryRaw<{ value: string }[]>(
      Prisma.sql`SELECT DISTINCT pc.category AS value
                 FROM product_categories pc
                 JOIN products p
                   ON p.client_id = pc.client_id
                  AND p.base_product_id = pc.base_product_id
                 WHERE ${where}
                 ORDER BY pc.category ASC`
    );
  }

  const values = rows.map((r) => r.value).filter(Boolean);
  return { field: "category", filters, count: values.length, values };
}
