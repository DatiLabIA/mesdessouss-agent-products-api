import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prisma } from "./prisma";

const CLIENT_ID = "mesdessous";

/** Crea y configura una instancia de McpServer con todas las tools de knowledge base. */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "mesdessous-knowledge-base",
    version: "1.0.0",
  });

  // ─── list_knowledge_bases ────────────────────────────────────────────────
  server.tool(
    "list_knowledge_bases",
    "Lista todos los topics almacenados en la base de conocimientos (políticas de tienda, guías de tallas, FAQs).",
    {},
    async () => {
      const policies = await prisma.storePolicy.findMany({
        where: { clientId: CLIENT_ID },
        select: { id: true, topic: true, updatedAt: true },
        orderBy: { topic: "asc" },
      });
      const rows = policies
        .map((p) => `- ${p.topic}  (id: ${p.id}, actualizado: ${p.updatedAt.toISOString()})`)
        .join("\n");
      return {
        content: [{
          type: "text",
          text: policies.length > 0
            ? `Se encontraron ${policies.length} topics:\n\n${rows}`
            : "No hay topics almacenados.",
        }],
      };
    }
  );

  // ─── get_all_knowledge_bases ─────────────────────────────────────────────
  server.tool(
    "get_all_knowledge_bases",
    "Devuelve el contenido completo de TODOS los topics almacenados. Útil para hacer un inventario completo o migrar datos.",
    {},
    async () => {
      const policies = await prisma.storePolicy.findMany({
        where: { clientId: CLIENT_ID },
        orderBy: { topic: "asc" },
      });
      if (policies.length === 0) {
        return { content: [{ type: "text", text: "No hay topics almacenados." }] };
      }
      const rows = policies
        .map(
          (p) =>
            `### ${p.topic}\n_Actualizado: ${p.updatedAt.toISOString()}_\n\n\`\`\`json\n${JSON.stringify(p.content, null, 2)}\n\`\`\``
        )
        .join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: `# Base de conocimientos — ${policies.length} topics\n\n${rows}` }],
      };
    }
  );

  // ─── get_knowledge_base ──────────────────────────────────────────────────
  server.tool(
    "get_knowledge_base",
    "Obtiene el contenido completo de un topic específico de la base de conocimientos.",
    {
      topic: z.string().describe("Nombre del topic a consultar (ej: livraison, retours, guide_tailles_aubade)"),
    },
    async ({ topic }) => {
      const policy = await prisma.storePolicy.findUnique({
        where: { clientId_topic: { clientId: CLIENT_ID, topic } },
      });
      if (!policy) {
        return {
          content: [{ type: "text", text: `Topic '${topic}' no encontrado. Usa list_knowledge_bases para ver los disponibles.` }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "text",
          text: `**Topic:** ${policy.topic}\n**Actualizado:** ${policy.updatedAt.toISOString()}\n\n**Contenido:**\n\`\`\`json\n${JSON.stringify(policy.content, null, 2)}\n\`\`\``,
        }],
      };
    }
  );

  // ─── create_knowledge_base ───────────────────────────────────────────────
  server.tool(
    "create_knowledge_base",
    "Crea un nuevo topic en la base de conocimientos. Si el topic ya existe, devuelve un error en lugar de sobreescribirlo (usa update_knowledge_base para reemplazar contenido existente).",
    {
      topic: z.string().describe("Nombre del nuevo topic (ej: livraison, retours, guide_tailles_aubade)"),
      content: z
        .union([
          z.record(z.string(), z.unknown()),
          z.array(z.unknown()),
          z.string(),
        ])
        .describe("Contenido del topic: puede ser un objeto JSON, un array o un string de texto"),
    },
    async ({ topic, content }) => {
      const existing = await prisma.storePolicy.findUnique({
        where: { clientId_topic: { clientId: CLIENT_ID, topic } },
      });
      if (existing) {
        return {
          content: [{ type: "text", text: `El topic '${topic}' ya existe. Usa update_knowledge_base para reemplazarlo o patch_knowledge_base para modificarlo parcialmente.` }],
          isError: true,
        };
      }
      const policy = await prisma.storePolicy.create({
        data: { clientId: CLIENT_ID, topic, content: content as never },
      });
      return {
        content: [{
          type: "text",
          text: `✓ Topic '${policy.topic}' creado correctamente.\nCreado: ${policy.updatedAt.toISOString()}`,
        }],
      };
    }
  );

  // ─── update_knowledge_base ───────────────────────────────────────────────
  server.tool(
    "update_knowledge_base",
    "Crea o reemplaza completamente el contenido de un topic. Si no existe, lo crea. Acepta cualquier valor JSON: objeto, array o string.",
    {
      topic: z.string().describe("Nombre del topic (ej: livraison, retours, guide_tailles_aubade)"),
      content: z
        .union([
          z.record(z.string(), z.unknown()),
          z.array(z.unknown()),
          z.string(),
        ])
        .describe("Contenido del topic: puede ser un objeto JSON, un array o un string de texto"),
    },
    async ({ topic, content }) => {
      const policy = await prisma.storePolicy.upsert({
        where: { clientId_topic: { clientId: CLIENT_ID, topic } },
        update: { content: content as never },
        create: { clientId: CLIENT_ID, topic, content: content as never },
      });
      return {
        content: [{
          type: "text",
          text: `✓ Topic '${policy.topic}' guardado correctamente.\nActualizado: ${policy.updatedAt.toISOString()}`,
        }],
      };
    }
  );

  // ─── patch_knowledge_base ────────────────────────────────────────────────
  server.tool(
    "patch_knowledge_base",
    "Actualiza parcialmente un topic existente haciendo merge del contenido. Solo modifica los campos indicados.",
    {
      topic: z.string().describe("Nombre del topic a modificar"),
      fields: z.record(z.string(), z.unknown()).describe("Campos a actualizar (se fusionan con el contenido existente)"),
    },
    async ({ topic, fields }) => {
      const existing = await prisma.storePolicy.findUnique({
        where: { clientId_topic: { clientId: CLIENT_ID, topic } },
      });
      if (!existing) {
        return {
          content: [{ type: "text", text: `Topic '${topic}' no encontrado. Usa update_knowledge_base para crearlo.` }],
          isError: true,
        };
      }
      const merged =
        typeof existing.content === "object" && !Array.isArray(existing.content)
          ? { ...(existing.content as object), ...fields }
          : fields;
      const updated = await prisma.storePolicy.update({
        where: { clientId_topic: { clientId: CLIENT_ID, topic } },
        data: { content: merged as object },
      });
      return {
        content: [{
          type: "text",
          text: `✓ Topic '${updated.topic}' actualizado parcialmente.\nActualizado: ${updated.updatedAt.toISOString()}\n\nContenido resultante:\n\`\`\`json\n${JSON.stringify(updated.content, null, 2)}\n\`\`\``,
        }],
      };
    }
  );

  // ─── delete_knowledge_base ───────────────────────────────────────────────
  server.tool(
    "delete_knowledge_base",
    "Elimina un topic de la base de conocimientos. Esta acción es irreversible.",
    {
      topic: z.string().describe("Nombre del topic a eliminar"),
      confirm: z.literal(true).describe("Debe ser true para confirmar la eliminación"),
    },
    async ({ topic, confirm: _ }) => {
      const existing = await prisma.storePolicy.findUnique({
        where: { clientId_topic: { clientId: CLIENT_ID, topic } },
      });
      if (!existing) {
        return {
          content: [{ type: "text", text: `Topic '${topic}' no encontrado.` }],
          isError: true,
        };
      }
      await prisma.storePolicy.delete({
        where: { clientId_topic: { clientId: CLIENT_ID, topic } },
      });
      return {
        content: [{ type: "text", text: `✓ Topic '${topic}' eliminado correctamente.` }],
      };
    }
  );

  // ─── search_knowledge_bases ──────────────────────────────────────────────
  server.tool(
    "search_knowledge_bases",
    "Busca topics cuyo nombre o contenido contenga el texto indicado.",
    {
      query: z.string().describe("Texto a buscar en el nombre del topic o en su contenido"),
    },
    async ({ query }) => {
      const all = await prisma.storePolicy.findMany({
        where: { clientId: CLIENT_ID },
        orderBy: { topic: "asc" },
      });
      const q = query.toLowerCase();
      const matches = all.filter(
        (p) =>
          p.topic.toLowerCase().includes(q) ||
          JSON.stringify(p.content).toLowerCase().includes(q)
      );
      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `No se encontraron topics que contengan '${query}'.` }],
        };
      }
      const rows = matches
        .map((p) => `### ${p.topic}\n\`\`\`json\n${JSON.stringify(p.content, null, 2)}\n\`\`\``)
        .join("\n\n");
      return {
        content: [{ type: "text", text: `Se encontraron ${matches.length} topics:\n\n${rows}` }],
      };
    }
  );

  return server;
}
