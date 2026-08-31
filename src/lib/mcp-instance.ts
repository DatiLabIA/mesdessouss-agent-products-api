import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prisma } from "./prisma";
import {
  searchProducts,
  getCatalogOptions,
  ProductSearchValidationError,
  CatalogFieldValidationError,
  CATALOG_FIELDS,
} from "./product-queries";
import { getStorePolicy, getSizeGuide } from "./policy-queries";
import type { ProductSearchInput } from "../types";

const CLIENT_ID = "mesdessous";

/** Acepta un string o un array de strings (para filtros multi-valor de la tool MCP). */
const stringOrArray = z.union([z.string(), z.array(z.string())]);

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

  // ═══════════════════════════════════════════════════════════════════════
  //  PRODUCTOS — SOLO LECTURA (búsquedas y catálogo, sin edición)
  // ═══════════════════════════════════════════════════════════════════════

  // ─── search_products ─────────────────────────────────────────────────────
  server.tool(
    "search_products",
    "Busca productos del catálogo (solo lectura) aplicando filtros. El campo 'type' es obligatorio. Los filtros multi-valor (type, size, brand, color, material, sub_type, category) aceptan un string o un array y se combinan con OR. Cada producto viene en el formato de la convención: núcleo (id, title, subtitle, image, url, price, currency, oldPrice, available), 'attributes' (talla, color y material ya escritos, que es lo que se pinta en la ficha) y 'details' (composición estructurada fibra/%/zona, material crudo, categorías, subtipo, stock y descripción: NO se pinta, es para responder preguntas). Cuando se pide un material, los resultados se ORDENAN por % real de esa fibra (mayor primero); usa min_material_pct para exigir un mínimo (ej: 'de algodón de verdad' → material='coton', min_material_pct=30).",
    {
      type: stringOrArray.describe("OBLIGATORIO. Tipo(s) de producto a buscar (ej: 'soutien-gorge', 'boxer', ['culotte','string'])"),
      size: stringOrArray.optional().describe("Talla(s) (ej: '95C', 'M', ['85B','90B'])"),
      gender: z.enum(["female", "male"]).optional().describe("Género del producto"),
      brand: stringOrArray.optional().describe("Marca(s) (ej: 'Aubade', ['Chantelle','Triumph'])"),
      color: stringOrArray.optional().describe("Color(es) (ej: 'noir', ['rouge','blanc'])"),
      material: stringOrArray.optional().describe("Material(es)/fibra(s) (ej: 'coton', 'soie', 'dentelle'). Los resultados se ordenan por % real de la fibra"),
      sub_type: stringOrArray.optional().describe("Subtipo(s) o texto a buscar también en el nombre"),
      category: stringOrArray.optional().describe("Categoria(s) del producto. Cubre ejes que 'type' no tiene: talla grande ('Soutiens-Gorge Grandes Tailles'), universo ('Maillots de Bain', 'Lingerie de Nuit'), uso ('Invisibles', 'Sculptants', 'Lingerie Sport', 'Soutiens-gorge allaitement') y material ('Lingerie Coton', 'Laine et Soie'). Tambien acepta temporada ('Saint-Valentin', 'Soldes') y nombres de coleccion o marca. Usa get_catalog_options con field='category' para ver las disponibles"),
      min_material_pct: z.number().min(0).max(100).optional().describe("% mínimo de la fibra pedida en 'material' (cuerpo o forro). Requiere 'material'. Ej: 30 = solo prendas con ≥30% de esa fibra"),
      min_price: z.number().optional().describe("Precio mínimo"),
      max_price: z.number().optional().describe("Precio máximo"),
    },
    async (input) => {
      try {
        const response = await searchProducts(input as ProductSearchInput);
        if (response.products.length === 0) {
          return {
            content: [{ type: "text", text: response.suggestion ?? "No se encontraron productos con esos filtros." }],
          };
        }
        return {
          content: [{
            type: "text",
            text: `Se encontraron ${response.total} producto(s):\n\n\`\`\`json\n${JSON.stringify(response.products, null, 2)}\n\`\`\``,
          }],
        };
      } catch (err) {
        if (err instanceof ProductSearchValidationError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        throw err;
      }
    }
  );

  // ─── get_catalog_options ─────────────────────────────────────────────────
  server.tool(
    "get_catalog_options",
    `Devuelve los valores distintos disponibles de un campo del catalogo (solo lectura). Util para descubrir que tipos, marcas, colores o categorias existen antes de buscar. Campos validos: ${CATALOG_FIELDS.join(", ")}. Con field='category' devuelve los ejes de busqueda (taxonomia y temporada) ya unificados: una sola entrada por concepto, sin nombres de coleccion ni de marca. Se puede acotar con filtros opcionales.`,
    {
      field: z.enum(CATALOG_FIELDS).describe("Campo del que se quieren los valores distintos (ej: 'type', 'brand', 'color')"),
      filters: z
        .object({
          gender: z.string().optional().describe("Acotar por género (female/male)"),
          brand: z.string().optional().describe("Acotar por marca"),
          type: z.string().optional().describe("Acotar por tipo"),
          subType: z.string().optional().describe("Acotar por subtipo"),
        })
        .optional()
        .describe("Filtros opcionales para acotar los valores devueltos"),
    },
    async ({ field, filters }) => {
      try {
        const result = await getCatalogOptions(field, filters ?? {});
        return {
          content: [{
            type: "text",
            text: result.count > 0
              ? `Campo '${result.field}' — ${result.count} valor(es):\n\n${result.values.map((v) => `- ${v}`).join("\n")}`
              : `No hay valores disponibles para '${result.field}' con esos filtros.`,
          }],
        };
      } catch (err) {
        if (err instanceof CatalogFieldValidationError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        throw err;
      }
    }
  );

  // ─── get_size_guide ──────────────────────────────────────────────────────
  server.tool(
    "get_size_guide",
    "Obtiene el guía de tallas (solo lectura). Intenta primero el guía específico de la marca y, si no existe, devuelve el guía genérico de medidas (mujer u hombre según el tipo de producto). Requiere 'product_type' o 'brand'.",
    {
      product_type: z.string().optional().describe("Tipo de producto (ej: 'soutien-gorge', 'boxer')"),
      brand: z.string().optional().describe("Marca para obtener su guía específica (ej: 'Aubade')"),
    },
    async ({ product_type, brand }) => {
      if (!product_type && !brand) {
        return { content: [{ type: "text", text: "Se requiere 'product_type' o 'brand'." }], isError: true };
      }
      const result = await getSizeGuide(product_type, brand);
      if (result.content === null) {
        return { content: [{ type: "text", text: result.message ?? "No hay guía de tallas disponible." }] };
      }
      const note = result.note ? `_${result.note}_\n\n` : "";
      return {
        content: [{
          type: "text",
          text: `**Guía:** ${result.topic}\n${note}\`\`\`json\n${JSON.stringify(result.content, null, 2)}\n\`\`\``,
        }],
      };
    }
  );

  // ─── get_store_policy ────────────────────────────────────────────────────
  server.tool(
    "get_store_policy",
    "Obtiene una política/tema de la tienda (livraison, retours, paiement, etc.) resolviendo automáticamente aliases en inglés/español/francés. Solo lectura. Para listar todos los temas disponibles usa list_knowledge_bases.",
    {
      topic: z.string().describe("Tema a consultar. Acepta aliases, ej: 'delivery', 'devoluciones', 'retours', 'payment'"),
    },
    async ({ topic }) => {
      const result = await getStorePolicy(topic);
      if (result.content === null) {
        return { content: [{ type: "text", text: result.message ?? `Tema '${topic}' no encontrado.` }] };
      }
      return {
        content: [{
          type: "text",
          text: `**Tema:** ${result.topic}\n\n\`\`\`json\n${JSON.stringify(result.content, null, 2)}\n\`\`\``,
        }],
      };
    }
  );

  return server;
}
