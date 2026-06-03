import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

const CLIENT_ID = "mesdessous";

/** GET /admin/policies — lista todos los topics */
export async function listPolicies(_req: Request, res: Response): Promise<void> {
  try {
    const policies = await prisma.storePolicy.findMany({
      where: { clientId: CLIENT_ID },
      select: { id: true, topic: true, updatedAt: true },
      orderBy: { topic: "asc" },
    });
    res.json({ policies });
  } catch (err) {
    console.error("[admin/policies] listPolicies error:", err);
    res.status(500).json({ error: "Error al obtener las políticas" });
  }
}

/** GET /admin/policies/:topic — obtiene el contenido de un topic */
export async function getPolicy(req: Request, res: Response): Promise<void> {
  try {
    const topic = String(req.params.topic);
    const policy = await prisma.storePolicy.findUnique({
      where: { clientId_topic: { clientId: CLIENT_ID, topic } },
    });
    if (!policy) {
      res.status(404).json({ error: `Topic '${topic}' no encontrado` });
      return;
    }
    res.json(policy);
  } catch (err) {
    console.error("[admin/policies] getPolicy error:", err);
    res.status(500).json({ error: "Error al obtener la política" });
  }
}

/** PUT /admin/policies/:topic — crea o reemplaza un topic */
export async function upsertPolicy(req: Request, res: Response): Promise<void> {
  try {
    const topic = String(req.params.topic);
    const { content } = req.body;

    if (content === undefined || content === null) {
      res.status(400).json({ error: "El campo 'content' es obligatorio" });
      return;
    }

    const policy = await prisma.storePolicy.upsert({
      where: { clientId_topic: { clientId: CLIENT_ID, topic } },
      update: { content },
      create: { clientId: CLIENT_ID, topic, content },
    });

    res.json({ ok: true, topic: policy.topic, updatedAt: policy.updatedAt });
  } catch (err) {
    console.error("[admin/policies] upsertPolicy error:", err);
    res.status(500).json({ error: "Error al guardar la política" });
  }
}

/** PATCH /admin/policies/:topic — actualiza parcialmente el contenido */
export async function patchPolicy(req: Request, res: Response): Promise<void> {
  try {
    const topic = String(req.params.topic);
    const { content } = req.body;

    if (content === undefined || content === null) {
      res.status(400).json({ error: "El campo 'content' es obligatorio" });
      return;
    }

    const existing = await prisma.storePolicy.findUnique({
      where: { clientId_topic: { clientId: CLIENT_ID, topic } },
    });
    if (!existing) {
      res.status(404).json({ error: `Topic '${topic}' no encontrado` });
      return;
    }

    // Merge content si es objeto, reemplaza si es string/array
    const merged =
      typeof existing.content === "object" &&
      !Array.isArray(existing.content) &&
      typeof content === "object" &&
      !Array.isArray(content)
        ? { ...(existing.content as object), ...content }
        : content;

    const updated = await prisma.storePolicy.update({
      where: { clientId_topic: { clientId: CLIENT_ID, topic } },
      data: { content: merged },
    });

    res.json({ ok: true, topic: updated.topic, updatedAt: updated.updatedAt });
  } catch (err) {
    console.error("[admin/policies] patchPolicy error:", err);
    res.status(500).json({ error: "Error al actualizar la política" });
  }
}

/** DELETE /admin/policies/:topic — elimina un topic */
export async function deletePolicy(req: Request, res: Response): Promise<void> {
  try {
    const topic = String(req.params.topic);

    const existing = await prisma.storePolicy.findUnique({
      where: { clientId_topic: { clientId: CLIENT_ID, topic } },
    });
    if (!existing) {
      res.status(404).json({ error: `Topic '${topic}' no encontrado` });
      return;
    }

    await prisma.storePolicy.delete({
      where: { clientId_topic: { clientId: CLIENT_ID, topic } },
    });

    res.json({ ok: true, deleted: topic });
  } catch (err) {
    console.error("[admin/policies] deletePolicy error:", err);
    res.status(500).json({ error: "Error al eliminar la política" });
  }
}
