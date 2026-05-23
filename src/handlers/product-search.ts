import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logQuery } from "../lib/audit";
import type { ProductSearchInput, ProductSearchResponse, ProductResult } from "../types";

/** Normaliza string | string[] → string[] siempre */
function toArray(val: string | string[] | undefined): string[] {
  if (!val) return [];
  return Array.isArray(val) ? val.filter(Boolean) : [val];
}

function splitValues(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
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

export async function productSearch(req: Request, res: Response): Promise<void> {
  const start = Date.now();
  try {
    const input = req.body as ProductSearchInput;

    const types = toArray(input.type);
    if (types.length === 0) {
      res.status(400).json({ error: "El campo 'type' es obligatorio", products: [], total: 0 });
      return;
    }

    const clientId = "mesdessous";
    const conditions: Prisma.Sql[] = [
      Prisma.sql`client_id = ${clientId}`,
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
    }));

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

    logQuery({ endpoint: "product_search", input: input as unknown as import("@prisma/client").Prisma.InputJsonObject, resultCount: products.length, durationMs: Date.now() - start });
    res.json(response);
  } catch (err) {
    console.error("[product_search] Error:", err);
    res.json({ error: "Error interno al buscar productos", products: [], total: 0 });
  }
}
