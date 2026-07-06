import { Request, Response } from "express";
import { logQuery } from "../lib/audit";
import { getStorePolicy } from "../lib/policy-queries";
import type { StorePoliciesInput } from "../types";

export async function storePolicies(req: Request, res: Response): Promise<void> {
  const start = Date.now();
  try {
    const { topic } = req.body as StorePoliciesInput;

    if (!topic) {
      res.status(400).json({ error: "El campo 'topic' es obligatorio" });
      return;
    }

    const result = await getStorePolicy(topic);

    if (result.content === null) {
      logQuery({ endpoint: "store_policies", input: { topic, resolvedTopic: result.resolvedTopic }, resultCount: 0, durationMs: Date.now() - start });
      res.json({ topic: result.topic, content: null, message: result.message });
      return;
    }

    logQuery({ endpoint: "store_policies", input: { topic }, resultCount: 1, durationMs: Date.now() - start });
    res.json({ topic: result.topic, content: result.content });
  } catch (err) {
    console.error("[store_policies] Error:", err);
    res.json({ error: "Error interno al obtener la política", topic: req.body.topic });
  }
}
