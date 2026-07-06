import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { logQuery } from "../lib/audit";
import {
  getCatalogOptions,
  CatalogFieldValidationError,
  type CatalogField,
  type CatalogOptionsFilters,
} from "../lib/product-queries";

interface CatalogOptionsInput {
  field: CatalogField;
  filters?: CatalogOptionsFilters;
}

export async function catalogOptions(req: Request, res: Response): Promise<void> {
  const start = Date.now();
  try {
    const { field, filters = {} } = req.body as CatalogOptionsInput;

    const result = await getCatalogOptions(field, filters);

    logQuery({
      endpoint: "catalog_options",
      input: { field, filters } as unknown as Prisma.InputJsonObject,
      resultCount: result.count,
      durationMs: Date.now() - start,
    });

    res.json(result);
  } catch (err) {
    if (err instanceof CatalogFieldValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("[catalog_options] Error:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
}
