import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logQuery } from "../lib/audit";

const CLIENT_ID = "mesdessous";

const VALID_FIELDS = ["type", "subType", "brand", "color", "gender", "styles", "materials", "collection"] as const;
type ValidField = (typeof VALID_FIELDS)[number];

// Campo Prisma → columna SQL (para raw DISTINCT)
const COLUMN_MAP: Record<ValidField, string> = {
  type: "type",
  subType: "sub_type",
  brand: "brand",
  color: "color",
  gender: "gender",
  styles: "styles",
  materials: "materials",
  collection: "collection",
};

interface CatalogOptionsInput {
  field: ValidField;
  filters?: {
    gender?: string;
    brand?: string;
    type?: string;
    subType?: string;
  };
}

export async function catalogOptions(req: Request, res: Response): Promise<void> {
  const start = Date.now();
  try {
    const { field, filters = {} } = req.body as CatalogOptionsInput;

    if (!field || !VALID_FIELDS.includes(field)) {
      res.status(400).json({
        error: `Campo inválido. Valores permitidos: ${VALID_FIELDS.join(", ")}`,
      });
      return;
    }

    const column = COLUMN_MAP[field];

    // Condiciones adicionales en SQL seguro con Prisma.sql
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

    logQuery({
      endpoint: "catalog_options",
      input: { field, filters },
      resultCount: values.length,
      durationMs: Date.now() - start,
    });

    res.json({ field, filters, count: values.length, values });
  } catch (err) {
    console.error("[catalog_options] Error:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
}
