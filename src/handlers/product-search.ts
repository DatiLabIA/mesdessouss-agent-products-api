import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { logQuery } from "../lib/audit";
import { searchProducts, ProductSearchValidationError } from "../lib/product-queries";
import type { ProductSearchInput } from "../types";

export async function productSearch(req: Request, res: Response): Promise<void> {
  const start = Date.now();
  try {
    const input = req.body as ProductSearchInput;
    const response = await searchProducts(input);

    logQuery({
      endpoint: "product_search",
      input: input as unknown as Prisma.InputJsonObject,
      resultCount: response.total,
      durationMs: Date.now() - start,
    });
    res.json(response);
  } catch (err) {
    if (err instanceof ProductSearchValidationError) {
      res.status(400).json({ error: err.message, products: [], total: 0 });
      return;
    }
    console.error("[product_search] Error:", err);
    res.json({ error: "Error interno al buscar productos", products: [], total: 0 });
  }
}
