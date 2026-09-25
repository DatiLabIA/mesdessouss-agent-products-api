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
import {
  listRuleSets,
  getRuleSetDetail,
  checkBrandCoverage,
  createRuleDraft,
  setStateGroup,
  setBrandLeadTime,
  setDecisionRule,
  setTemplate,
  setRuleSetting,
  loadRuleSetForSimulation,
  activateRuleSet,
  rollbackRuleSet,
  RuleSetNotFoundError,
  RuleSetStateError,
  RuleSetValidationError,
  RuleSetActivationConflictError,
  RuleSetVersionConflictError,
  STATE_GROUP_CODES,
  STOCK_STATUSES,
  BRAND_COUNTS,
  DELAY_BUCKET_CONDITIONS,
  RULE_OUTCOMES,
  RULE_TEMPLATE_LANGS,
} from "./rule-queries";
import { verifyOrderIdentity } from "./order-identity";
import { consolidateOrder } from "./order-consolidation";
import { computeOrderFacts } from "./order-facts";
import { evaluateRules, buildGuidance } from "./rule-evaluator";
import type { ProductSearchInput } from "../types";

const CLIENT_ID = "mesdessous";

/** Acepta un string o un array de strings (para filtros multi-valor de la tool MCP). */
const stringOrArray = z.union([z.string(), z.array(z.string())]);

/**
 * Convierte cualquier fallo de una tool de reglas en un resultado legible.
 *
 * Los `catch` comprobaban solo los errores tipados del conjunto de reglas y dejaban
 * escapar el resto como excepción cruda. El más probable no es ninguno de los
 * tipados: un corte de la base de datos — esta se cortó cinco veces en una sola
 * sesión de despliegue. Quien opera por MCP recibía un volcado en vez de "reintentá
 * en unos segundos", y no podía distinguir un problema de infraestructura de un
 * error suyo.
 */
function ruleToolError(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const conocido =
    err instanceof RuleSetNotFoundError ||
    err instanceof RuleSetStateError ||
    err instanceof RuleSetValidationError ||
    err instanceof RuleSetActivationConflictError;
  const detalle = err instanceof Error ? err.message.split("\n")[0] : String(err);
  return {
    content: [
      {
        type: "text",
        text: conocido
          ? detalle
          : `No se pudo completar la operación por un fallo de la base de datos, no por los datos enviados. Reintentá en unos segundos. Detalle: ${detalle}`,
      },
    ],
    isError: true,
  };
}


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

  // ═══════════════════════════════════════════════════════════════════════
  //  MOTOR DE REGLAS DE PEDIDOS — LECTURA
  // ═══════════════════════════════════════════════════════════════════════

  // ─── list_rule_sets ──────────────────────────────────────────────────────
  server.tool(
    "list_rule_sets",
    "Lista todos los conjuntos de reglas del motor de pedidos (borrador, activo y archivados) con su versión, estado, nota y fechas. Usala para ver el historial antes de crear un borrador nuevo o antes de un rollback.",
    {},
    async () => {
      const rows = await listRuleSets(CLIENT_ID);
      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: "No hay ningún conjunto de reglas todavía. Sembralo con `pnpm seed:rules`." }],
        };
      }
      const lines = rows.map(
        (r) =>
          `- v${r.version} [${r.status}]${r.note ? ` — ${r.note}` : ""} ` +
          `(creado: ${r.createdAt.toISOString()}${r.activatedAt ? `, activado: ${r.activatedAt.toISOString()}` : ""})`
      );
      return { content: [{ type: "text", text: `${rows.length} conjunto(s):\n\n${lines.join("\n")}` }] };
    }
  );

  // ─── get_rules ───────────────────────────────────────────────────────────
  server.tool(
    "get_rules",
    "Muestra el contenido completo de un conjunto de reglas: grupos de estado, plazos por marca, matriz de decisión, plantillas, ajustes y festivos. Sin 'version' muestra el conjunto ACTIVO. Muestra el contenido tal cual está en base, incluso si un borrador todavía no es válido (para verificar eso está simulate_rules).",
    {
      version: z.number().int().optional().describe("Versión a inspeccionar. Si se omite, se muestra el conjunto activo."),
    },
    async ({ version }) => {
      try {
        const detail = await getRuleSetDetail(CLIENT_ID, version);
        return { content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(detail, null, 2)}\n\`\`\`` }] };
      } catch (err) {
        if (err instanceof RuleSetNotFoundError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        return ruleToolError(err);
      }
    }
  );

  // ─── check_brand_coverage ────────────────────────────────────────────────
  server.tool(
    "check_brand_coverage",
    "Compara las marcas reales del catálogo de PrestaShop contra las que tienen plazo de expedición definido en el conjunto ACTIVO, y devuelve las que no tienen plazo, con su cantidad de productos activos (de mayor a menor impacto). Una marca sin plazo fuerza escalar cualquier pedido sin stock que la incluya (§2.4, §7.4 del documento de reglas): usala para encontrar esos huecos antes de que los encuentre un cliente real.",
    {},
    async () => {
      try {
        const gaps = await checkBrandCoverage(CLIENT_ID);
        if (gaps.length === 0) {
          return { content: [{ type: "text", text: "Todas las marcas del catálogo tienen plazo de expedición definido." }] };
        }
        const lines = gaps.map((g) => `- ${g.brand} (${g.brandKey}): ${g.activeProductCount} producto(s) activo(s), sin plazo`);
        return { content: [{ type: "text", text: `${gaps.length} marca(s) sin plazo:\n\n${lines.join("\n")}` }] };
      } catch (err) {
        if (err instanceof RuleSetNotFoundError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        return ruleToolError(err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  //  MOTOR DE REGLAS DE PEDIDOS — EDICIÓN (siempre sobre un BORRADOR)
  //
  //  Ninguna de estas tools puede modificar el conjunto ACTIVO: el único
  //  camino es create_rule_draft → set_* sobre esa versión → simulate_rules
  //  para verificar contra pedidos reales → activate_rule_set para publicar.
  // ═══════════════════════════════════════════════════════════════════════

  // ─── create_rule_draft ───────────────────────────────────────────────────
  server.tool(
    "create_rule_draft",
    "Crea un borrador nuevo clonando el conjunto de reglas ACTIVO (o la siembra inicial si todavía no hay ninguno activo). Es el único punto de entrada para editar reglas: nunca se edita el conjunto activo directamente. Flujo completo: create_rule_draft → set_state_group/set_brand_lead_time/set_decision_rule/set_template/set_rule_setting sobre la versión devuelta → simulate_rules contra pedidos reales → activate_rule_set.",
    {
      note: z.string().min(1).describe("Motivo del borrador, obligatorio para poder auditar por qué se creó."),
    },
    async ({ note }) => {
      try {
        const result = await createRuleDraft(CLIENT_ID, note);
        const origen =
          result.clonedFrom === "active" ? "el conjunto activo" : "la siembra inicial (no había ningún conjunto activo)";
        return {
          content: [{
            type: "text",
            text:
              `✓ Borrador v${result.version} creado, clonado de ${origen}.\n` +
              `Editalo con los set_* pasando version=${result.version}, después corré simulate_rules antes de activate_rule_set.`,
          }],
        };
      } catch (err) {
        if (err instanceof RuleSetValidationError || err instanceof RuleSetVersionConflictError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        return ruleToolError(err);
      }
    }
  );

  // ─── set_state_group ─────────────────────────────────────────────────────
  server.tool(
    "set_state_group",
    "Asigna el grupo del árbol de decisión a un estado de PrestaShop, dentro de un BORRADOR (create_rule_draft primero). A=no expedido, B=expedido, C=expedición parcial, D=resto/escalar siempre, R=bloque retorno. Alta o actualización (upsert) por order_state_id. No se puede editar el conjunto activo.",
    {
      version: z.number().int().describe("Versión del borrador a editar (nunca la activa; usá create_rule_draft si no tenés una)."),
      orderStateId: z
        .number()
        .int()
        .describe("id del estado en PrestaShop (order_states.id). El mapeo es siempre por id, nunca por nombre: los nombres de estado cambian."),
      stateName: z.string().nullable().describe("Nombre del estado, solo para lectura humana. Nunca se usa para matchear."),
      groupCode: z.enum(STATE_GROUP_CODES).describe("Grupo del árbol de decisión: A, B, C, D o R."),
    },
    async ({ version, orderStateId, stateName, groupCode }) => {
      try {
        await setStateGroup(CLIENT_ID, version, { orderStateId, stateName, groupCode });
        return { content: [{ type: "text", text: `✓ Estado ${orderStateId} → grupo ${groupCode} guardado en el borrador v${version}.` }] };
      } catch (err) {
        if (err instanceof RuleSetNotFoundError || err instanceof RuleSetStateError || err instanceof RuleSetValidationError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        return ruleToolError(err);
      }
    }
  );

  // ─── set_brand_lead_time ─────────────────────────────────────────────────
  server.tool(
    "set_brand_lead_time",
    "Asigna el plazo de expedición (en días hábiles) de una marca, dentro de un BORRADOR (create_rule_draft primero). La clave de búsqueda se calcula automáticamente con la misma normalización que usa el runtime al leer un pedido real (sin acentos, sin espacios, minúsculas): no se recibe del llamador, para que no pueda desalinearse. Alta o actualización (upsert) por marca normalizada. Una marca sin plazo fuerza escalar cualquier pedido sin stock que la incluya. No se puede editar el conjunto activo.",
    {
      version: z.number().int().describe("Versión del borrador a editar (nunca la activa; usá create_rule_draft si no tenés una)."),
      brand: z.string().min(1).describe("Nombre de la marca tal como aparece en PrestaShop (ej: 'Simone Pérèle')."),
      leadDays: z.number().int().min(0).describe("Plazo de expedición en días hábiles."),
    },
    async ({ version, brand, leadDays }) => {
      try {
        await setBrandLeadTime(CLIENT_ID, version, { brand, leadDays });
        return {
          content: [{ type: "text", text: `✓ Marca "${brand}" → ${leadDays} día(s) hábil(es) guardado en el borrador v${version}.` }],
        };
      } catch (err) {
        if (err instanceof RuleSetNotFoundError || err instanceof RuleSetStateError || err instanceof RuleSetValidationError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        return ruleToolError(err);
      }
    }
  );

  // ─── set_decision_rule ───────────────────────────────────────────────────
  server.tool(
    "set_decision_rule",
    "Da de alta o actualiza una fila de la matriz de decisión (§4 del documento de reglas), dentro de un BORRADOR (create_rule_draft primero). Se evalúa por 'priority' ascendente: gana la primera fila que matchea. Cada condición es un enum cerrado o null = 'cualquiera'; no hay expresiones ni operadores, así que una fila mala solo puede elegir un mail equivocado, nunca ejecutar comportamiento arbitrario. Alta o actualización (upsert) por priority. No se puede editar el conjunto activo.",
    {
      version: z.number().int().describe("Versión del borrador a editar (nunca la activa; usá create_rule_draft si no tenés una)."),
      priority: z.number().int().describe("Orden de evaluación, ascendente. Gana la primera fila que matchea los hechos del pedido."),
      stateGroup: z.enum(STATE_GROUP_CODES).nullable().describe("Grupo requerido, o null = cualquiera."),
      stockStatus: z.enum(STOCK_STATUSES).nullable().describe("Estado de stock del pedido requerido, o null = cualquiera."),
      brandCount: z
        .enum(BRAND_COUNTS)
        .nullable()
        .describe("Cardinalidad de marcas afectadas requerida (contadas solo sobre líneas sin stock, §2.3), o null = cualquiera."),
      delayBucket: z
        .enum(DELAY_BUCKET_CONDITIONS)
        .nullable()
        .describe("Tramo de retraso requerido. POSITIVE = cualquier retraso (SHORT o LONG), para filas que no distinguen. null = cualquiera."),
      hasTracking: z.boolean().nullable().describe("Si requiere número de seguimiento presente (true) o ausente (false), o null = cualquiera."),
      historyHasInfo: z
        .boolean()
        .nullable()
        .describe("Si requiere que el historial de mensajes tenga información útil (true) o esté vacío (false), o null = cualquiera."),
      refundIssued: z
        .boolean()
        .nullable()
        .describe(
          "Si requiere que ya haya un reembolso registrado (true) o que no lo haya (false), o null = cualquiera. Solo lo usan las filas del grupo R (bloque RETORNO)."
        ),
      outcome: z.enum(RULE_OUTCOMES).describe("Desenlace de esta fila: qué mail corresponde, o ESCALATE."),
      note: z
        .string()
        .min(1)
        .describe("Motivo legible de la fila, obligatorio: se usa para explicar la decisión en simulate_rules y en una escalada."),
    },
    async ({ version, ...rest }) => {
      try {
        await setDecisionRule(CLIENT_ID, version, rest);
        return {
          content: [{ type: "text", text: `✓ Fila de prioridad ${rest.priority} → ${rest.outcome} guardada en el borrador v${version}.` }],
        };
      } catch (err) {
        if (err instanceof RuleSetNotFoundError || err instanceof RuleSetStateError || err instanceof RuleSetValidationError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        return ruleToolError(err);
      }
    }
  );

  // ─── set_template ────────────────────────────────────────────────────────
  server.tool(
    "set_template",
    "Da de alta o actualiza la plantilla de un desenlace (outcome), dentro de un BORRADOR (create_rule_draft primero): el texto base aprobado, los datos que Lia tiene que transmitir (facts_to_convey), las afirmaciones que tiene prohibido hacer (must_not_claim) y si el desenlace tiene que marcarse para que el equipo lo revise (notify_team). Alta o actualización (upsert) por outcome+lang. No se puede editar el conjunto activo.",
    {
      version: z.number().int().describe("Versión del borrador a editar (nunca la activa; usá create_rule_draft si no tenés una)."),
      outcome: z.enum(RULE_OUTCOMES).describe("Desenlace al que corresponde esta plantilla."),
      lang: z.enum(RULE_TEMPLATE_LANGS).describe("Idioma de la plantilla. Hoy el runtime solo usa 'fr'."),
      body: z.string().describe("Texto base aprobado. Puede quedar vacío si todavía no hay texto aprobado para este desenlace."),
      factsToConvey: z
        .array(z.string())
        .describe("Claves de los datos que Lia tiene que transmitir en este desenlace (ej: 'order_reference', 'tracking_url')."),
      mustNotClaim: z.array(z.string()).describe("Afirmaciones que Lia tiene prohibido hacer para este desenlace."),
      notifyTeam: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Si este desenlace tiene que marcarse para que el equipo lo revise (viaja como guidance.notify_team). " +
            "Esto SOLO pone la bandera: el servicio nunca envía ninguna notificación por su cuenta. Por defecto false."
        ),
    },
    async ({ version, outcome, lang, body, factsToConvey, mustNotClaim, notifyTeam }) => {
      try {
        await setTemplate(CLIENT_ID, version, { outcome, lang, body, factsToConvey, mustNotClaim, notifyTeam });
        return { content: [{ type: "text", text: `✓ Plantilla ${outcome}/${lang} guardada en el borrador v${version}.` }] };
      } catch (err) {
        if (err instanceof RuleSetNotFoundError || err instanceof RuleSetStateError || err instanceof RuleSetValidationError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        return ruleToolError(err);
      }
    }
  );

  // ─── set_rule_setting ────────────────────────────────────────────────────
  server.tool(
    "set_rule_setting",
    "Da de alta o actualiza un ajuste configurable (ej: 'in_stock_lead_days', 'short_delay_max_days'), dentro de un BORRADOR (create_rule_draft primero). Los puntos abiertos de la política de plazos se resuelven cambiando un ajuste acá, no desplegando código. Alta o actualización (upsert) por key. No se puede editar el conjunto activo.",
    {
      version: z.number().int().describe("Versión del borrador a editar (nunca la activa; usá create_rule_draft si no tenés una)."),
      key: z.string().min(1).describe("Clave del ajuste (ej: 'in_stock_lead_days', 'short_delay_max_days', 'date_format')."),
      value: z.union([z.string(), z.number(), z.boolean()]).describe("Valor del ajuste."),
      note: z.string().nullable().optional().describe("Nota opcional explicando el ajuste."),
    },
    async ({ version, key, value, note }) => {
      try {
        await setRuleSetting(CLIENT_ID, version, { key, value, note: note ?? undefined });
        return { content: [{ type: "text", text: `✓ Ajuste "${key}" = ${JSON.stringify(value)} guardado en el borrador v${version}.` }] };
      } catch (err) {
        if (err instanceof RuleSetNotFoundError || err instanceof RuleSetStateError || err instanceof RuleSetValidationError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        return ruleToolError(err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  //  MOTOR DE REGLAS DE PEDIDOS — VERIFICACIÓN Y PUBLICACIÓN
  // ═══════════════════════════════════════════════════════════════════════

  // ─── get_order_status ────────────────────────────────────────────────────
  //
  // Hermana de `simulate_rules`, y no un duplicado: responden preguntas distintas.
  // `simulate_rules` responde "¿qué regla disparó y por qué?" y sirve para afinar la
  // matriz antes de publicar un borrador. Esta responde "¿qué pasa con el pedido de
  // este cliente?" y sirve para atender una queja: devuelve el pedido consolidado
  // entero —líneas, seguimiento, abonos, estado de la conversación— que la otra no
  // trae. Es el mismo contenido que recibe DatiHub por HTTP, sin levantar un curl.
  server.tool(
    "get_order_status",
    "Consulta el estado completo de un pedido real y devuelve lo mismo que recibe el agente por HTTP: el pedido consolidado (estado, líneas con marca y stock, número y enlace de seguimiento, abonos con su tipo vale/dinero, estado de la devolución, estado de la conversación) más el bloque guidance con lo que hay que decirle al cliente y lo que está prohibido afirmar. Solo lectura: no envía nada a nadie ni escribe en base. Úsala para investigar una consulta o una queja concreta ('¿qué le vamos a responder a quien pregunta por SURVHLYRI?'). Si lo que querés es afinar la matriz de decisión antes de publicar un borrador, usá simulate_rules en su lugar. Requiere referencia Y email: sin los dos no se entrega información.",
    {
      reference: z.string().describe("Referencia del pedido (9 caracteres alfanuméricos)."),
      email: z.string().describe("Email asociado al pedido. Obligatorio: es la protección de datos personales, no un trámite."),
    },
    async ({ reference, email }) => {
      const identity = await verifyOrderIdentity({ reference, email });
      if (identity.outcome !== "VERIFIED") {
        return {
          content: [
            {
              type: "text",
              text:
                identity.outcome === "IDENTITY_NOT_VERIFIED"
                  ? "No se entrega información: la referencia no existe o el email no corresponde a ese pedido. Los dos casos dan la misma respuesta a propósito, para que nadie pueda averiguar qué referencias existen probando correos."
                  : `No se pudo consultar el pedido: ${identity.outcome}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const ruleSet = await loadRuleSetForSimulation(CLIENT_ID);
        const today = new Date();
        const consolidated = await consolidateOrder(
          { order: identity.order, customer: identity.customer, today },
          ruleSet.stateGroups
        );

        const facts = computeOrderFacts(consolidated.facts, {
          stateGroups: ruleSet.stateGroups,
          brandLeadDays: ruleSet.brandLeadDays,
          holidays: ruleSet.holidays,
          inStockLeadDays: ruleSet.settings.inStockLeadDays,
          shortDelayMaxDays: ruleSet.settings.shortDelayMaxDays,
          returnRefundMaxBusinessDays: ruleSet.settings.returnRefundMaxBusinessDays,
        });

        const evaluation = evaluateRules(facts, ruleSet.decisions);
        const guidance = buildGuidance(
          evaluation,
          facts,
          consolidated.orderContext,
          ruleSet.templates,
          consolidated.extraContext
        );

        const payload = {
          order: consolidated.order,
          customer: consolidated.customer,
          lines: consolidated.lines,
          shipping: consolidated.shipping,
          refund: consolidated.refund,
          return: consolidated.return,
          conversation: consolidated.conversation,
          // `order`/`refund` viajan como el objeto completo, así que sus campos nuevos
          // (deliveryAddress, refund.lines) ya llegan solos. `payment` es un campo nuevo de
          // primer nivel en `OrderConsolidationResult`: sin listarlo acá explícitamente, este
          // payload no lo tendría aunque el handler HTTP sí lo exponga.
          payment: consolidated.payment,
          guidance,
        };

        return { content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`` }] };
      } catch (err) {
        if (err instanceof RuleSetNotFoundError || err instanceof RuleSetValidationError) {
          return {
            content: [
              {
                type: "text",
                text: `${err.message}\n\nMientras no haya un conjunto de reglas ACTIVO no se puede evaluar la consulta. Publicá uno con activate_rule_set.`,
              },
            ],
            isError: true,
          };
        }
        return ruleToolError(err);
      }
    }
  );

  // ─── simulate_rules ──────────────────────────────────────────────────────
  server.tool(
    "simulate_rules",
    "Corre la cadena completa (identidad → consolidación → hechos → matriz de decisión → guidance) para un pedido real, contra el conjunto de reglas indicado por 'version' o el ACTIVO si se omite. No envía nada a nadie ni escribe en base: es de solo lectura. Devuelve los hechos calculados, qué fila de la matriz ganó (con su nota) o el motivo de la escalada, y el bloque guidance completo. Es la tool que responde '¿por qué le dijimos esto?', y el paso obligatorio antes de activate_rule_set: simulá un borrador contra pedidos reales para verificar que hace lo que se espera antes de publicarlo.",
    {
      reference: z.string().describe("Referencia del pedido (9 caracteres alfanuméricos)."),
      email: z.string().describe("Email del solicitante, para verificar que es el dueño del pedido."),
      version: z.number().int().optional().describe("Versión del conjunto de reglas a simular (típicamente un borrador). Si se omite, se usa el conjunto ACTIVO."),
    },
    async ({ reference, email, version }) => {
      const identity = await verifyOrderIdentity({ reference, email });
      if (identity.outcome !== "VERIFIED") {
        return {
          content: [{ type: "text", text: `No se pudo verificar la identidad del pedido: ${identity.outcome}` }],
          isError: true,
        };
      }

      try {
        const ruleSet = await loadRuleSetForSimulation(CLIENT_ID, version);
        const today = new Date();
        const consolidated = await consolidateOrder(
          { order: identity.order, customer: identity.customer, today },
          ruleSet.stateGroups
        );

        const facts = computeOrderFacts(consolidated.facts, {
          stateGroups: ruleSet.stateGroups,
          brandLeadDays: ruleSet.brandLeadDays,
          holidays: ruleSet.holidays,
          inStockLeadDays: ruleSet.settings.inStockLeadDays,
          shortDelayMaxDays: ruleSet.settings.shortDelayMaxDays,
          returnRefundMaxBusinessDays: ruleSet.settings.returnRefundMaxBusinessDays,
        });

        const evaluation = evaluateRules(facts, ruleSet.decisions);
        const guidance = buildGuidance(evaluation, facts, consolidated.orderContext, ruleSet.templates, consolidated.extraContext);

        const payload = {
          rule_set_version: ruleSet.version,
          facts,
          matched_rule: evaluation.matchedRule,
          outcome: evaluation.outcome,
          escalate_reason: evaluation.escalateReason,
          guidance,
        };

        return { content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`` }] };
      } catch (err) {
        if (err instanceof RuleSetNotFoundError || err instanceof RuleSetValidationError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        return ruleToolError(err);
      }
    }
  );

  // ─── activate_rule_set ───────────────────────────────────────────────────
  server.tool(
    "activate_rule_set",
    "Publica un borrador: lo valida ENTERO primero (si una fila no es válida, rechaza y dice exactamente cuál) y, si valida, archiva el conjunto activo actual y activa este, en una única transacción. Corré simulate_rules contra pedidos reales antes de esto. Requiere confirm=true, igual que delete_knowledge_base.",
    {
      version: z.number().int().describe("Versión del borrador a activar."),
      confirm: z.literal(true).describe("Debe ser true para confirmar la publicación."),
    },
    async ({ version, confirm: _ }) => {
      try {
        const result = await activateRuleSet(CLIENT_ID, version);
        return {
          content: [{
            type: "text",
            text: `✓ Conjunto v${result.version} activado (${result.activatedAt.toISOString()}). El conjunto anterior quedó archivado.`,
          }],
        };
      } catch (err) {
        if (
          err instanceof RuleSetNotFoundError ||
          err instanceof RuleSetStateError ||
          err instanceof RuleSetValidationError ||
          err instanceof RuleSetActivationConflictError
        ) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        return ruleToolError(err);
      }
    }
  );

  // ─── rollback_rule_set ───────────────────────────────────────────────────
  server.tool(
    "rollback_rule_set",
    "Reactiva una versión archivada (rollback), por si el conjunto activo actual tiene un problema detectado después de publicar. Archiva el activo actual y reactiva la versión indicada, en una única transacción. Requiere confirm=true, igual que delete_knowledge_base.",
    {
      version: z.number().int().describe("Versión archivada a reactivar."),
      confirm: z.literal(true).describe("Debe ser true para confirmar el rollback."),
    },
    async ({ version, confirm: _ }) => {
      try {
        const result = await rollbackRuleSet(CLIENT_ID, version);
        return {
          content: [{
            type: "text",
            text: `✓ Conjunto v${result.version} reactivado (${result.activatedAt.toISOString()}). El conjunto anterior quedó archivado.`,
          }],
        };
      } catch (err) {
        if (err instanceof RuleSetNotFoundError || err instanceof RuleSetStateError || err instanceof RuleSetActivationConflictError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        return ruleToolError(err);
      }
    }
  );

  return server;
}
