import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { logQuery } from "../lib/audit";
import type { StorePoliciesInput } from "../types";

export async function storePolicies(req: Request, res: Response): Promise<void> {
  const start = Date.now();
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
      logQuery({ endpoint: "store_policies", input: { topic }, resultCount: 0, durationMs: Date.now() - start });
      res.json({
        topic,
        content: null,
        message: `No hay información disponible para el tema '${topic}'.`,
      });
      return;
    }

    logQuery({ endpoint: "store_policies", input: { topic }, resultCount: 1, durationMs: Date.now() - start });
    res.json({ topic: policy.topic, content: policy.content });
  } catch (err) {
    console.error("[store_policies] Error:", err);
    res.json({ error: "Error interno al obtener la política", topic: req.body.topic });
  }
}
