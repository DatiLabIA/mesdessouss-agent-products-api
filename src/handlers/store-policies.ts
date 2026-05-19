import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import type { StorePoliciesInput } from "../types";

export async function storePolicies(req: Request, res: Response): Promise<void> {
  try {
    const { topic } = req.body as StorePoliciesInput;

    if (!topic) {
      res.status(400).json({ error: "El campo 'topic' es obligatorio" });
      return;
    }

    const policy = await prisma.storePolicy.findUnique({
      where: { clientId_topic: { clientId: "mesdessous", topic } },
    });

    if (!policy) {
      res.json({
        topic,
        content: null,
        message: `No hay información disponible para el tema '${topic}'.`,
      });
      return;
    }

    res.json({ topic: policy.topic, content: policy.content });
  } catch (err) {
    console.error("[store_policies] Error:", err);
    res.json({ error: "Error interno al obtener la política", topic: req.body.topic });
  }
}
