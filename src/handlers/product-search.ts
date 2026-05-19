import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logQuery } from "../lib/audit";
import type { ProductSearchInput, ProductSearchResponse, ProductResult } from "../types";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitValues(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface ProductRow {
  id: number;
  product_id: string;
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
  product_url: string | null;
  image_url: string | null;
  description: string | null;
}

export async function productSearch(req: Request, res: Response): Promise<void> {
  const start = Date.now();
  try {
    const input = req.body as ProductSearchInput;

    if (!input.type) {
      res.status(400).json({ error: "El campo 'type' es obligatorio", products: [], total: 0 });
      return;
    }

    const clientId = "mesdessous";
    const conditions: Prisma.Sql[] = [
      Prisma.sql`client_id = ${clientId}`,
      Prisma.sql`active = true`,
      Prisma.sql`(image_url LIKE '%.jpg' OR image_url LIKE '%.png' OR image_url LIKE '%.webp')`,
    ];

    conditions.push(
      Prisma.sql`(LOWER(type) LIKE ${`%${input.type.toLowerCase()}%`} OR LOWER(sub_type) LIKE ${`%${input.type.toLowerCase()}%`})`
    );

    if (input.size) {
      // Normalize: "95C" or "95 C" → number + optional space + letter
      // DB format: "95 C (eu 80), 90 B (eu 75), ..."
      const normalized = input.size.trim().replace(/\s+/g, "").toUpperCase();
      const parts = normalized.match(/^(\d+)([A-Z]+)$/);
      if (parts) {
        const [, num, letter] = parts;
        // Matches: start-or-comma, optional spaces, number, optional space, letter, optional (eu XX) suffix, then comma or end
        const sizePattern = `(^|,)\\s*${num}\\s*${letter}(\\s*\\([^)]*\\))?(,|$)`;
        conditions.push(Prisma.sql`sizes ~* ${sizePattern}`);
      } else {
        // Fallback for non-standard formats
        conditions.push(Prisma.sql`LOWER(sizes) LIKE ${`%${input.size.toLowerCase()}%`}`);
      }
    }

    if (input.gender) {
      conditions.push(
        Prisma.sql`(gender = ${input.gender} OR gender IS NULL OR gender = '')`
      );
    }

    if (input.brand) {
      conditions.push(Prisma.sql`LOWER(brand) LIKE ${`%${input.brand.toLowerCase()}%`}`);
    }

    if (input.color) {
      conditions.push(Prisma.sql`LOWER(color) LIKE ${`%${input.color.toLowerCase()}%`}`);
    }

    if (input.max_price !== undefined) {
      conditions.push(Prisma.sql`price <= ${input.max_price}`);
    }

    if (input.sub_type) {
      conditions.push(
        Prisma.sql`(LOWER(sub_type) LIKE ${`%${input.sub_type.toLowerCase()}%`} OR LOWER(name) LIKE ${`%${input.sub_type.toLowerCase()}%`})`
      );
    }

    const whereClause = Prisma.join(conditions, " AND ");

    const rows = await prisma.$queryRaw<ProductRow[]>`
      SELECT id, product_id, name, brand, type, sub_type, price, old_price,
             has_discount, discount_pct, color, sizes, product_url, image_url, description
      FROM products
      WHERE ${whereClause}
      ORDER BY has_discount DESC, price ASC
      LIMIT 10
    `;

    const products: ProductResult[] = rows.map((row) => ({
      id: row.product_id,
      name: row.name,
      brand: row.brand,
      type: row.type,
      sub_type: row.sub_type,
      price: row.price !== null ? parseFloat(row.price) : null,
      old_price: row.old_price !== null ? parseFloat(row.old_price) : null,
      has_discount: row.has_discount,
      discount_percentage: row.discount_pct,
      sizes_available: splitValues(row.sizes),
      colors_available: splitValues(row.color),
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
      response.suggestion = `No se encontraron ${input.type}${input.size ? ` en talla ${input.size}` : ""}. Intenta con otros filtros.`;
    }

    logQuery({ endpoint: "product_search", input: input as unknown as import("@prisma/client").Prisma.InputJsonObject, resultCount: products.length, durationMs: Date.now() - start });
    res.json(response);
  } catch (err) {
    console.error("[product_search] Error:", err);
    res.json({ error: "Error interno al buscar productos", products: [], total: 0 });
  }
}
