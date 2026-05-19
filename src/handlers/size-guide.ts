import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import type { SizeGuideInput } from "../types";

const CLIENT_ID = "mesdessous";

/** Product types that belong to men's underwear — used to select the fallback guide. */
const MALE_PRODUCT_TYPES = new Set([
  "boxer", "slip homme", "caleçon", "t-shirt homme",
  "sous-vêtement homme", "underwear homme", "chaussettes homme",
]);

function normalizeBrand(brand: string): string {
  return brand.toLowerCase().replace(/[\s-]+/g, "_").replace(/_+/g, "_");
}

export async function sizeGuide(req: Request, res: Response): Promise<void> {
  try {
    const { product_type, brand } = req.body as SizeGuideInput;

    if (!product_type && !brand) {
      res.status(400).json({ error: "Se requiere 'product_type' o 'brand'" });
      return;
    }

    const isHomme = MALE_PRODUCT_TYPES.has((product_type ?? "").toLowerCase());
    const fallbackTopic = isHomme ? "guide_mesure_homme" : "guide_mesure_femme";

    // Try brand-specific guide first
    if (brand) {
      const brandTopic = `guide_tailles_${normalizeBrand(brand)}`;
      const policy = await prisma.storePolicy.findUnique({
        where: { clientId_topic: { clientId: CLIENT_ID, topic: brandTopic } },
      });

      if (policy) {
        res.json({ topic: policy.topic, brand, product_type: product_type ?? null, content: policy.content });
        return;
      }
    }

    // Fallback: generic measurement guide
    const fallback = await prisma.storePolicy.findUnique({
      where: { clientId_topic: { clientId: CLIENT_ID, topic: fallbackTopic } },
    });

    if (fallback) {
      res.json({
        topic: fallback.topic,
        brand: brand ?? null,
        product_type: product_type ?? null,
        content: fallback.content,
        ...(brand ? { note: `Guide spécifique pour '${brand}' non disponible. Guide général fourni.` } : {}),
      });
      return;
    }

    res.json({
      topic: null,
      brand: brand ?? null,
      product_type: product_type ?? null,
      content: null,
      message: "Aucun guide de tailles disponible pour cette recherche.",
    });
  } catch (err) {
    console.error("[size_guide] Error:", err);
    res.json({ error: "Erreur interne lors de la récupération du guide de tailles" });
  }
}
