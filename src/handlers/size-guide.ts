import { Request, Response } from "express";
import { logQuery } from "../lib/audit";
import { getSizeGuide } from "../lib/policy-queries";
import type { SizeGuideInput } from "../types";

export async function sizeGuide(req: Request, res: Response): Promise<void> {
  const start = Date.now();
  try {
    const { product_type, brand } = req.body as SizeGuideInput;

    if (!product_type && !brand) {
      res.status(400).json({ error: "Se requiere 'product_type' o 'brand'" });
      return;
    }

    const result = await getSizeGuide(product_type, brand);

    logQuery({
      endpoint: "size_guide",
      input: { product_type, brand },
      resultCount: result.content !== null ? 1 : 0,
      durationMs: Date.now() - start,
    });
    res.json(result);
  } catch (err) {
    console.error("[size_guide] Error:", err);
    res.json({ error: "Erreur interne lors de la récupération du guide de tailles" });
  }
}
