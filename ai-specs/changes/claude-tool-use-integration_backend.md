# Claude API + Tool Use Integration — DatiHub Backend
## Plan de implementación técnico

**Origen**: [`ai-specs/docs/datihub-architecture-brief_1.md`](../docs/datihub-architecture-brief_1.md)  
**Alcance**: Solo cambios en este repo (`datihub_backend`). El Catalog Service es un repo separado.  
**Estado**: ✅ Completado

---

## Análisis del estado actual

### Lo que YA existe (no hay que crear)

| Componente | Archivo | Estado |
|---|---|---|
| `ClaudeAPIService` | `src/infraestructure/services/ai/claude-api.service.ts` | ✅ Existe pero incompleto para Tool Use |
| `AIProvider.ANTHROPIC` | `src/domain/common/enum/entity-enum.common.ts` | ✅ Ya definido |
| `DI.ClaudeAPIService` | `src/infraestructure/DI/global-symbol.ts` | ✅ Ya registrado |
| `AIServiceFactory` retorna `ClaudeAPIService` | `src/infraestructure/services/ai/ai-service.factory.ts` | ✅ Ya implementado |
| `@anthropic-ai/sdk` | `package.json` | ✅ Ya instalado |
| `FunctionRegistry` (funciones internas) | `src/infraestructure/services/ai/function-registry.service.ts` | ✅ Funciona, se mantiene intacto |
| `systemPrompt` en Flow model (DB) | `prisma/schema.prisma` | ✅ Ya existe |
| `enableFunctions` / `allowedFunctions` en Flow | `prisma/schema.prisma` | ✅ Ya existe |

### Lo que FALTA (esto es lo que vamos a construir)

| Componente | Qué falta | Prioridad |
|---|---|---|
| `ClaudeAPIService.generateResponse()` | No tiene loop de Tool Use (`stop_reason === "tool_use"`) | 🔴 Alta |
| `ClaudeAPIService.generateResponseStream()` | No tiene Tool Use en streaming (usa `messages.stream()` con loop) | 🔴 Alta |
| `ExternalToolExecutor` | No existe — dispatch HTTP a endpoints externos | 🔴 Alta |
| `toolsConfig Json?` en Flow model | No existe — campo para definir tools con endpoints | 🔴 Alta |
| `ToolConfig` interface en `ai.type.ts` | No existe — tipado del campo `toolsConfig` | 🔴 Alta |
| `toolsConfig` en `FlowEntity` | No existe en props/getters | 🔴 Alta |
| `toolsConfig` en `AIGenerationConfig` | No existe — el usecase no pasa las tools | 🔴 Alta |
| Zod schema para `toolsConfig` | No existe | 🟡 Media |
| Migración Prisma para `toolsConfig` | No existe | 🔴 Alta |

---

## Decisiones de arquitectura

### ¿Por qué `ExternalToolExecutor` separado del `FunctionRegistry`?

El `FunctionRegistry` actual maneja **funciones internas de DatiHub** (get_user_info, create_followup, create_webhook). Son handlers TypeScript con acceso directo a repositorios.

Las **tools externas** del brief son distintas en naturaleza:
- Se definen por configuración (JSON en la BD, no código)
- Se ejecutan vía HTTP POST a endpoints del cliente
- No tienen lógica de TypeScript — DatiHub solo es el proxy
- Cada cliente configura sus propias tools en el Flow

→ Dos servicios con responsabilidades claramente separadas.

### ¿Dónde vive el Tool Use loop?

En `ClaudeAPIService`, porque:
- El loop es parte del protocolo Claude API (manejo de `stop_reason`)
- Ya tiene el cliente Anthropic instanciado
- El servicio recibe las tools como parte de `AIGenerationConfig`
- Respeta el contrato de `IAIService` sin cambiar su interfaz pública

### ¿Qué estructura tiene `toolsConfig`?

```typescript
// Ejemplo de valor JSON en la BD para el Flow de MesDessous
{
  "tools": [
    {
      "name": "product_search",
      "description": "Search lingerie catalog by type, size, brand, color, price",
      "endpoint": "https://catalog-api.example.com/mesdessous/product_search",
      "apiKey": "sk-catalog-xxx",          // opcional, se omite si no se necesita auth
      "timeoutMs": 5000,
      "input_schema": {
        "type": "object",
        "properties": {
          "type": { "type": "string", "description": "Product type: culotte, soutien-gorge..." },
          "size": { "type": "string", "description": "Size: XXS, 90C, T5, FR38..." },
          "gender": { "type": "string", "enum": ["female", "male"] },
          "brand": { "type": "string" },
          "color": { "type": "string" },
          "max_price": { "type": "number" },
          "sub_type": { "type": "string" }
        },
        "required": ["type"]
      }
    },
    {
      "name": "size_guide",
      "description": "Get sizing guide and size conversions FR/EU/US/UK",
      "endpoint": "https://catalog-api.example.com/mesdessous/size_guide",
      "input_schema": {
        "type": "object",
        "properties": {
          "product_type": { "type": "string" },
          "brand": { "type": "string" }
        },
        "required": ["product_type"]
      }
    },
    {
      "name": "store_policies",
      "description": "Store policies: shipping, returns, payments, promotions",
      "endpoint": "https://catalog-api.example.com/mesdessous/store_policies",
      "input_schema": {
        "type": "object",
        "properties": {
          "topic": { "type": "string", "enum": ["shipping","returns","payments","orders","promo","company"] }
        },
        "required": ["topic"]
      }
    }
  ]
}
```

---

## Plan de implementación por fases

---

### Fase 1 — Tipos y contratos de dominio

**Objetivo**: Definir el tipado que fluye por todas las capas antes de tocar lógica.

#### 1.1 — Agregar `ToolConfig` y actualizar `AIGenerationConfig`

**Archivo**: `src/domain/interfaces/types/ai.type.ts`

Agregar después de `FunctionDefinition`:

```typescript
/**
 * Definición de un tool externo que Claude puede invocar.
 * El endpoint es una URL HTTP a la que DatiHub hará POST con el input generado por Claude.
 */
export interface ExternalToolConfig {
  name: string;
  description: string;
  endpoint: string;
  apiKey?: string;        // Header Authorization: Bearer {apiKey}
  timeoutMs?: number;     // Default: 5000ms
  input_schema: {
    type: "object";
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
      items?: unknown;
    }>;
    required?: string[];
  };
}
```

Agregar en `AIGenerationConfig`:

```typescript
// Tools externos para Claude Tool Use (solo ANTHROPIC provider)
tools?: ExternalToolConfig[];
```

**Nota**: No requiere cambios en `IAIService` — los tools pasan como config, el contrato público no cambia.

---

### Fase 2 — Schema Prisma + Migración

**Objetivo**: Persistir la configuración de tools en la BD.

#### 2.1 — Agregar campo `toolsConfig` al modelo `Flow`

**Archivo**: `prisma/schema.prisma`

En el bloque `// === CONFIGURACIÓN DE IA ===` del modelo `Flow`, agregar después de `allowedFunctions`:

```prisma
// Tools externos para Claude Tool Use — solo aplica cuando aiProvider = ANTHROPIC
// Formato: { "tools": [{ name, description, endpoint, apiKey?, timeoutMs?, input_schema }] }
toolsConfig Json?
```

#### 2.2 — Generar la migración

```bash
pnpm prisma migrate dev --name add-tools-config-to-flow
```

**Importante**: Al ejecutar la migración, actualizar `ai-specs/specs/data-model.md` en el mismo commit (regla del proyecto).

---

### Fase 3 — Dominio: FlowEntity

**Objetivo**: Exponer `toolsConfig` desde el dominio.

#### 3.1 — Actualizar `FlowProps` y `FlowEntity`

**Archivo**: `src/domain/entities/flow.entity.ts`

En `FlowProps`, agregar después de `subAgentsConfig`:

```typescript
/** Tools externos configurados para Claude Tool Use */
toolsConfig?: { tools: ExternalToolConfig[] };
```

Agregar getter en `FlowEntity`:

```typescript
get toolsConfig(): { tools: ExternalToolConfig[] } | undefined {
  return this.props.toolsConfig;
}
```

Importar `ExternalToolConfig` desde `@/domain/interfaces/types/ai.type`.

---

### Fase 4 — Infraestructura: ExternalToolExecutor

**Objetivo**: Servicio que ejecuta HTTP POST a los endpoints del cliente cuando Claude invoca un tool.

#### 4.1 — Crear `ExternalToolExecutor`

**Archivo nuevo**: `src/infraestructure/services/ai/external-tool-executor.service.ts`

```typescript
import { injectable } from "tsyringe";
import { ExternalToolConfig } from "@/domain/interfaces/types/ai.type";
import { ErrorFactory } from "@/domain/common/errors";
import { logger } from "@/shared/libs/winston/logger.lib";

@injectable()
export class ExternalToolExecutor {
  private readonly log = logger.child("ExternalToolExecutor");

  /**
   * Ejecuta un tool externo via HTTP POST al endpoint configurado.
   * Devuelve el resultado como string JSON listo para enviar a Claude como tool_result.
   */
  async execute(
    tool: ExternalToolConfig,
    input: Record<string, unknown>,
    context?: { conversationId?: string },
  ): Promise<string> {
    const timeout = tool.timeoutMs ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      this.log.info(`Executing external tool: ${tool.name}`, {
        feature: "ai" as const,
        endpoint: tool.endpoint,
        conversationId: context?.conversationId,
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Resolver apiKey: si empieza con "$", leer de variable de entorno.
      // Esto permite almacenar "$CATALOG_MESDESSOUS_API_KEY" en la BD sin exponer el secreto.
      const rawKey = tool.apiKey;
      const resolvedKey = rawKey?.startsWith("$")
        ? process.env[rawKey.slice(1)]
        : rawKey;

      if (resolvedKey) {
        headers["Authorization"] = `Bearer ${resolvedKey}`;
      }

      const response = await fetch(tool.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const body = await response.text().catch(() => "(empty)");
        this.log.warn(`Tool endpoint returned ${response.status}`, {
          feature: "ai" as const,
          tool: tool.name,
          status: response.status,
          body,
        });
        // Devolver error como resultado — Claude debe manejar el caso
        return JSON.stringify({
          error: `Tool returned HTTP ${response.status}`,
          status: response.status,
        });
      }

      const result = await response.json();

      this.log.info(`Tool executed successfully: ${tool.name}`, {
        feature: "ai" as const,
        conversationId: context?.conversationId,
      });

      return JSON.stringify(result);
    } catch (error: unknown) {
      clearTimeout(timer);

      const isAbort =
        error instanceof Error && error.name === "AbortError";

      this.log.error(`Error executing tool: ${tool.name}`, {
        feature: "ai" as const,
        error: error instanceof Error ? error.message : String(error),
        timeout: isAbort,
      });

      // Retornar error estructurado — no lanzar, Claude debe manejar
      return JSON.stringify({
        error: isAbort
          ? `Tool timed out after ${timeout}ms`
          : `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
```

**Reglas aplicadas**:
- No usa `throw new Error()` — los errores se devuelven como `tool_result` JSON para que Claude los gestione
- Usa `fetch` nativo (Node.js 20+)
- `AbortController` para timeout sin dependencias externas
- `apiKey` con prefijo `$` se resuelve desde `process.env` — el secreto real nunca vive en la BD
- El valor resuelto del `apiKey` nunca se loguea

#### 4.2 — Registrar el token DI

**Archivo**: `src/infraestructure/DI/global-symbol.ts`

En el bloque `// ── AI ────────────────────────────────────────────────────────────────────`, agregar:

```typescript
ExternalToolExecutor: Symbol.for("ExternalToolExecutor"),
```

#### 4.3 — Registrar en el contenedor DI

**Archivo**: `src/infraestructure/DI/container.ts`

Agregar el registro de `ExternalToolExecutor` junto a los demás servicios de IA. Buscar el bloque donde se registran `BedrockAIService`, `BedrockAgentService`, `ClaudeAPIService` y agregar:

```typescript
container.registerSingleton<ExternalToolExecutor>(
  DI.ExternalToolExecutor,
  ExternalToolExecutor,
);
```

---

### Fase 5 — Tool Use loop en `ClaudeAPIService`

**Objetivo**: Agregar soporte de Tool Use al servicio Claude existente, sin romper el path actual (respuesta simple sin tools).

#### 5.1 — Inyectar `ExternalToolExecutor`

**Archivo**: `src/infraestructure/services/ai/claude-api.service.ts`

Actualizar el constructor para inyectar `ExternalToolExecutor`:

```typescript
constructor(
  @inject(DI.FunctionRegistry)
  private functionRegistry: IFunctionRegistry,
  @inject(DI.KnowledgeBaseLoader)
  private knowledgeBaseLoader: IKnowledgeBaseLoader,
  @inject(DI.ExternalToolExecutor)
  private externalToolExecutor: ExternalToolExecutor,
) { ... }
```

#### 5.2 — Actualizar `generateResponse()` y `generateResponseStream()` para Tool Use

Ambos métodos reciben una rama condicional: si `config.tools` está poblado, delegan a sus respectivos métodos privados con Tool Use.

```typescript
async generateResponse(input: GenerateResponseInput): Promise<AIResponse> {
  const startTime = Date.now();
  try {
    const { config } = input;

    // Si hay tools configurados, delegar al loop de Tool Use (no-streaming)
    if (config.tools && config.tools.length > 0) {
      return await this.generateResponseWithTools(input, startTime);
    }

    // Flujo actual sin tools — sin cambios
    // ...
  }
}

async generateResponseStream(
  input: GenerateResponseInput,
  onChunk: (chunk: string) => void,
): Promise<AIResponse> {
  const startTime = Date.now();

  // Si hay tools configurados, delegar al loop de Tool Use con streaming real
  if (input.config.tools && input.config.tools.length > 0) {
    return await this.generateResponseStreamWithTools(input, onChunk, startTime);
  }

  // Flujo actual sin tools — sin cambios
  // ...
}
```

#### 5.3 — Implementar `generateResponseWithTools()` (método privado)

Agregar como método privado en `ClaudeAPIService`:

```typescript
private async generateResponseWithTools(
  input: GenerateResponseInput,
  startTime: number,
): Promise<AIResponse> {
  const { message, context, config } = input;

  // Construir herramientas en formato Anthropic SDK
  const anthropicTools: Anthropic.Tool[] = config.tools!.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  }));

  // buildSystemWithCache() agrega cache_control: { type: "ephemeral" } a los system blocks.
  // El header `anthropic-beta: prompt-caching-2024-07-31` ya está en el constructor.
  // Computar UNA SOLA VEZ antes del loop — todos los rounds reutilizan la misma referencia
  // y Anthropic aplica el caché a partir del segundo round (~90% ahorro en input tokens).
  const systemBlocks = await this.buildSystemWithCache(
    config.systemPrompt,
    config.knowledgeBaseId,
  );

  // Historial LOCAL al método — construido desde context.messageHistory (inmutable).
  // Los push() de assistant + tool_results durante el loop solo viven aquí.
  // GenerateAIResponseUseCase guarda únicamente aiResponse.text (el texto final),
  // así que los bloques intermedios tool_use/tool_result NUNCA llegan al historial de DatiHub.
  const messages: Anthropic.MessageParam[] = this.buildMessages(
    context.messageHistory,
    message,
  );

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastModel = config.model || process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
  const MAX_TOOL_ROUNDS = 5; // prevenir loops infinitos

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await this.client.messages.create({
      model: lastModel,
      max_tokens: config.maxTokens || 4096,
      temperature: config.temperature ?? 0.1,
      system: systemBlocks,
      messages,
      tools: anthropicTools,
    });

    lastModel = response.model;
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    if (response.stop_reason !== "tool_use") {
      // Claude terminó — extraer texto final
      const textContent = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as Anthropic.TextBlock).text)
        .join("");

      const latency = Date.now() - startTime;

      // Extraer tokens de caché del último response para observabilidad
      const lastUsage = response.usage as ClaudeUsageExtended;
      logger.info("Claude Tool Use response completed", {
        feature: "ai",
        conversationId: context.conversationId,
        rounds: round + 1,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationTokens: lastUsage.cache_creation_input_tokens || 0,
        cacheReadTokens: lastUsage.cache_read_input_tokens || 0,
        cacheHit: (lastUsage.cache_read_input_tokens || 0) > 0,
        latency,
      });

      return {
        success: true,
        text: textContent,
        metadata: {
          model: lastModel,
          tokens: {
            prompt: totalInputTokens,
            completion: totalOutputTokens,
            total: totalInputTokens + totalOutputTokens,
          },
          latency,
          provider: AIProvider.ANTHROPIC,
        },
      };
    }

    // Hay tool calls — ejecutarlas todas
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const toolDef = config.tools!.find((t) => t.name === toolUse.name);

      if (!toolDef) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: `Tool not found: ${toolUse.name}` }),
        });
        continue;
      }

      const result = await this.externalToolExecutor.execute(
        toolDef,
        toolUse.input as Record<string, unknown>,
        { conversationId: context.conversationId },
      );

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // Añadir respuesta del asistente + resultados al historial
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  // Si llegamos aquí, se agotaron los rounds — devolver error controlado
  return {
    success: false,
    error: "Tool Use loop exceeded maximum rounds",
    metadata: {
      model: lastModel,
      tokens: {
        prompt: totalInputTokens,
        completion: totalOutputTokens,
        total: totalInputTokens + totalOutputTokens,
      },
      latency: Date.now() - startTime,
      provider: AIProvider.ANTHROPIC,
    },
  };
}
```

#### 5.4 — Implementar `generateResponseStreamWithTools()` (método privado)

Usa `client.messages.stream()` en cada round del loop. El evento `stream.on("text", ...)` emite chunks en tiempo real. Los rounds de `tool_use` típicamente no emiten texto — `onChunk` solo se dispara en el round final donde Claude genera la respuesta al usuario.

```typescript
private async generateResponseStreamWithTools(
  input: GenerateResponseInput,
  onChunk: (chunk: string) => void,
  startTime: number,
): Promise<AIResponse> {
  const { message, context, config } = input;

  const anthropicTools: Anthropic.Tool[] = config.tools!.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  }));

  // buildSystemWithCache() — computar UNA vez, reutilizar en todos los rounds
  const systemBlocks = await this.buildSystemWithCache(
    config.systemPrompt,
    config.knowledgeBaseId,
  );

  // Historial LOCAL — mismas garantías que generateResponseWithTools()
  const messages: Anthropic.MessageParam[] = this.buildMessages(
    context.messageHistory,
    message,
  );

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastModel = config.model || process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
  let fullText = "";
  const MAX_TOOL_ROUNDS = 5;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = this.client.messages.stream({
      model: lastModel,
      max_tokens: config.maxTokens || 4096,
      temperature: config.temperature ?? 0.1,
      system: systemBlocks,
      messages,
      tools: anthropicTools,
    });

    // Emitir chunks en tiempo real.
    // En rounds de tool_use Claude no emite texto — onChunk solo dispara en el round final.
    stream.on("text", (text) => {
      fullText += text;
      onChunk(text);
    });

    const finalMessage = await stream.finalMessage();
    lastModel = finalMessage.model;
    totalInputTokens += finalMessage.usage.input_tokens;
    totalOutputTokens += finalMessage.usage.output_tokens;

    if (finalMessage.stop_reason !== "tool_use") {
      const lastUsage = finalMessage.usage as ClaudeUsageExtended;
      const latency = Date.now() - startTime;

      logger.info("Claude Tool Use stream completed", {
        feature: "ai",
        conversationId: context.conversationId,
        rounds: round + 1,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationTokens: lastUsage.cache_creation_input_tokens || 0,
        cacheReadTokens: lastUsage.cache_read_input_tokens || 0,
        cacheHit: (lastUsage.cache_read_input_tokens || 0) > 0,
        latency,
      });

      return {
        success: true,
        text: fullText,
        metadata: {
          model: lastModel,
          tokens: {
            prompt: totalInputTokens,
            completion: totalOutputTokens,
            total: totalInputTokens + totalOutputTokens,
          },
          latency,
          provider: AIProvider.ANTHROPIC,
          streaming: true,
        },
      };
    }

    // Ejecutar tool calls — mismo patrón que generateResponseWithTools()
    const toolUseBlocks = finalMessage.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const toolDef = config.tools!.find((t) => t.name === toolUse.name);

      if (!toolDef) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: `Tool not found: ${toolUse.name}` }),
        });
        continue;
      }

      const result = await this.externalToolExecutor.execute(
        toolDef,
        toolUse.input as Record<string, unknown>,
        { conversationId: context.conversationId },
      );

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    messages.push({ role: "assistant", content: finalMessage.content });
    messages.push({ role: "user", content: toolResults });
  }

  return {
    success: false,
    error: "Tool Use stream loop exceeded maximum rounds",
    metadata: {
      model: lastModel,
      tokens: {
        prompt: totalInputTokens,
        completion: totalOutputTokens,
        total: totalInputTokens + totalOutputTokens,
      },
      latency: Date.now() - startTime,
      provider: AIProvider.ANTHROPIC,
      streaming: true,
    },
  };
}
```

---

### Fase 6 — Application layer: pasar `toolsConfig` al use case

**Objetivo**: Que el use case lea `toolsConfig` del flow y lo pase a `AIGenerationConfig`.

#### 6.1 — Actualizar `GenerateAIResponseUseCase`

**Archivo**: `src/app/use-cases/ai/generate-ai-response.use-case.ts`

En el bloque donde se construye `aiConfig` (línea ~130 del archivo actual), agregar el campo `tools`:

```typescript
const aiConfig: AIGenerationConfig = {
  provider: conversation.flow.aiProvider ?? AIProvider.BEDROCK,
  model: conversation.flow.aiModel || "",
  systemPrompt: conversation.flow.systemPrompt || undefined,
  temperature: conversation.flow.temperature || undefined,
  maxTokens: conversation.flow.maxTokens || undefined,
  useRAG: conversation.flow.useRAG || false,
  knowledgeBaseId: conversation.flow.knowledgeBaseId || undefined,
  ragMaxResults: conversation.flow.ragMaxResults || 5,
  enableFunctions: conversation.flow.enableFunctions || false,
  allowedFunctions: (conversation.flow.allowedFunctions as string[]) || [],
  agentId: conversation.flow.agentId || undefined,
  agentAliasId: conversation.flow.agentAliasId || undefined,
  // Tool Use externo — solo se popula cuando hay toolsConfig en el flow
  tools: conversation.flow.toolsConfig?.tools ?? undefined,
};
```

**Nota**: `conversation.flow` aquí es el resultado de `getConversationWithFlow()`. Hay que verificar que el repositorio devuelva el campo `toolsConfig` en el select de Prisma.

#### 6.2 — Verificar el repository query

**Archivo**: Buscar el método `getConversationWithFlow` en `ConversationRepository` e incluir `toolsConfig` en el select de `Flow`.

```typescript
// En el include/select de Flow, agregar:
toolsConfig: true,
```

---

### Fase 7 — Validación Zod (capa de entrada HTTP)

**Objetivo**: Validar el campo `toolsConfig` cuando se crea o actualiza un Flow via API.

#### 7.1 — Crear schema Zod para `toolsConfig`

**Archivo nuevo**: `src/infraestructure/schemas/flow-tools-config.schema.ts`

```typescript
import { z } from "zod";

export const ExternalToolSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  endpoint: z.string().url(),
  apiKey: z.string().optional(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  input_schema: z.object({
    type: z.literal("object"),
    properties: z.record(
      z.string(),
      z.object({
        type: z.string(),
        description: z.string().optional(),
        enum: z.array(z.string()).optional(),
        items: z.unknown().optional(),
      }),
    ),
    required: z.array(z.string()).optional(),
  }),
});

export const ToolsConfigSchema = z.object({
  tools: z.array(ExternalToolSchema).min(1).max(20),
});

export type ToolsConfigInput = z.infer<typeof ToolsConfigSchema>;
```

#### 7.2 — Integrar en el schema de creación/actualización de Flow

**Archivo**: `src/infraestructure/schemas/flow.schema.ts` (o el nombre exacto del schema de Flow)

Agregar al schema de Flow create/update:

```typescript
toolsConfig: ToolsConfigSchema.optional().nullable(),
```

---

### Fase 8 — FlowEntity mapper en Infrastructure

**Objetivo**: Mapear `toolsConfig` desde Prisma a la entidad de dominio.

#### 8.1 — Actualizar el mapper de Flow

**Archivo**: Buscar el FlowMapper en `src/infraestructure/` (probablemente `src/infraestructure/mappers/flow.mapper.ts` o similar).

Agregar en el mapeo de Prisma → Entity:

```typescript
toolsConfig: (data.toolsConfig as { tools: ExternalToolConfig[] } | null) ?? undefined,
```

---

## Diagrama de flujo completo (ANTHROPIC con Tool Use)

```
ConversationSocket.onMessage()
        │
        ▼
GenerateAIResponseUseCase.execute()
        │
        ├─ Lee flow.toolsConfig → AIGenerationConfig.tools
        │
        ▼
AIServiceFactory.getServiceFromFlowConfig()
        │  aiProvider = ANTHROPIC
        │
        ▼
ClaudeAPIService.generateResponse()
        │  config.tools.length > 0
        │
        ▼
ClaudeAPIService.generateResponseWithTools()   ← NUEVO
        │
        ├─[1] client.messages.create({ tools, messages })
        │
        ├─[stop_reason = "tool_use"]
        │        │
        │        ▼
        │   ExternalToolExecutor.execute()      ← NUEVO
        │        │  POST tool.endpoint { input }
        │        │  ← JSON result
        │        │
        │   Append tool_result to messages
        │        │
        │   [2] client.messages.create({ tools, messages })
        │
        └─[stop_reason = "end_turn"]
                 │
                 ▼
         AIResponse { success: true, text: "..." }
                 │
                 ▼
         GenerateAIResponseUseCase → respuesta al socket
```

Path de streaming con Tool Use:

```
ConversationSocket.onMessage()  [WebChat]
        │
        ▼
GenerateAIResponseUseCase.execute()  [onChunk callback]
        │
        ▼
ClaudeAPIService.generateResponseStream()
        │  config.tools.length > 0
        │
        ▼
ClaudeAPIService.generateResponseStreamWithTools()   ← NUEVO
        │
        ├─[1] client.messages.stream({ tools })  ← stream abierto
        │      stream.on("text") → onChunk()  [sin texto en round tool_use]
        │      stream.finalMessage()  → stop_reason = "tool_use"
        │
        ├─ ExternalToolExecutor.execute()  [HTTP POST sincrónico]
        │
        ├─[2] client.messages.stream({ tools, +tool_results })
        │      stream.on("text") → onChunk()  ← texto llega al usuario en tiempo real
        │      stream.finalMessage()  → stop_reason = "end_turn"
        │
        └─ AIResponse { streaming: true, text: fullText }
```

---

## Archivos a crear / modificar (resumen)

### Archivos NUEVOS

| Archivo | Descripción |
|---|---|
| `src/infraestructure/services/ai/external-tool-executor.service.ts` | HTTP dispatcher para tool calls |
| `src/infraestructure/schemas/flow-tools-config.schema.ts` | Zod schema para validar toolsConfig |
| `prisma/migrations/[timestamp]_add_tools_config_to_flow/` | Migración generada por Prisma |

### Archivos MODIFICADOS

| Archivo | Qué cambia |
|---|---|
| `src/domain/interfaces/types/ai.type.ts` | + `ExternalToolConfig` interface, + `tools?` en `AIGenerationConfig` |
| `src/domain/entities/flow.entity.ts` | + `toolsConfig` en `FlowProps` + getter |
| `src/infraestructure/DI/global-symbol.ts` | + `ExternalToolExecutor` token |
| `src/infraestructure/DI/container.ts` | + registro de `ExternalToolExecutor` |
| `src/infraestructure/services/ai/claude-api.service.ts` | + inyección de `ExternalToolExecutor`, + `generateResponseWithTools()` privado, + rama en `generateResponse()` |
| `src/app/use-cases/ai/generate-ai-response.use-case.ts` | + `tools` en la construcción de `aiConfig` |
| `src/infraestructure/mappers/flow.mapper.ts` (o equivalente) | + mapeo de `toolsConfig` |
| `src/infraestructure/schemas/flow.schema.ts` (o equivalente) | + `toolsConfig` en schema de create/update |
| `prisma/schema.prisma` | + `toolsConfig Json?` en modelo `Flow` |
| `ai-specs/specs/data-model.md` | + documentar campo `toolsConfig` (mandatorio al migrar schema) |

---

## Tests a implementar

**Archivos de test a crear**:

### `test/infraestructure/services/ai/external-tool-executor.service.test.ts`

Casos:
- `execute()` hace POST al endpoint con el input correcto
- `execute()` incluye `Authorization: Bearer {apiKey}` cuando hay apiKey
- `execute()` retorna JSON de error cuando el endpoint falla (HTTP 500)
- `execute()` retorna JSON de error cuando hay timeout (AbortController)
- `execute()` NO lanza excepciones — siempre retorna string JSON

### `test/infraestructure/services/ai/claude-api.service.tool-use.test.ts`

Casos `generateResponse()`:
- Con `tools=[]` llama al flujo simple (sin Tool Use)
- Con tools configurados activa `generateResponseWithTools()`
- El loop llama a `ExternalToolExecutor.execute()` por cada tool_use block
- La respuesta final extrae el texto cuando `stop_reason = "end_turn"`
- El loop respeta `MAX_TOOL_ROUNDS = 5`

Casos `generateResponseStream()`:
- Con `tools=[]` llama al flujo simple de streaming (sin Tool Use)
- Con tools configurados activa `generateResponseStreamWithTools()`
- Los chunks de texto del round final llegan al `onChunk` callback
- Los rounds de tool_use no emiten chunks (no llaman a `onChunk`)
- El loop de stream respeta `MAX_TOOL_ROUNDS = 5`

---

## Variables de entorno requeridas

No se necesitan nuevas variables de entorno en DatiHub para esta feature.

- `ANTHROPIC_API_KEY` — ya requerida por `ClaudeAPIService`
- Los secrets de tools del cliente se configuran en el entorno (ej: `CATALOG_MESDESSOUS_API_KEY`) y se referencian en la BD como `"$CATALOG_MESDESSOUS_API_KEY"` — `ExternalToolExecutor` resuelve el `$` automáticamente

---

## Configuración de MesDessous (ejemplo concreto)

Al implementar esta feature, el Flow de MesDessous en la BD se actualiza así:

```json
{
  "aiProvider": "ANTHROPIC",
  "aiModel": "claude-haiku-4-5-20251001",
  "systemPrompt": "🚨 Tu es Julie, consultante experte en lingerie...",
  "temperature": 0.1,
  "maxTokens": 2048,
  "supervisorAgentId": null,
  "supervisorAgentAliasId": null,
  "subAgentsConfig": null,
  "toolsConfig": {
    "tools": [
      {
        "name": "product_search",
        "description": "Search lingerie catalog by type, size, brand, color, price range",
        "endpoint": "https://catalog-api.mesdessous.fr/product_search",
        "apiKey": "sk-catalog-...",
        "timeoutMs": 8000,
        "input_schema": {
          "type": "object",
          "properties": {
            "type": { "type": "string", "description": "culotte, soutien-gorge, boxer, shorty, corset, combinaison..." },
            "size": { "type": "string", "description": "XXS, XS, S, M, L, XL, 85B, 90C, 95D, FR34, T5..." },
            "gender": { "type": "string", "enum": ["female", "male"] },
            "brand": { "type": "string" },
            "color": { "type": "string" },
            "max_price": { "type": "number" },
            "sub_type": { "type": "string", "description": "avec armatures, sans armatures, taille haute, push-up..." }
          },
          "required": ["type"]
        }
      },
      {
        "name": "size_guide",
        "description": "Sizing guide: how to take measurements and size conversions FR/EU/US/UK",
        "endpoint": "https://catalog-api.mesdessous.fr/size_guide",
        "timeoutMs": 3000,
        "input_schema": {
          "type": "object",
          "properties": {
            "product_type": { "type": "string" },
            "brand": { "type": "string" }
          },
          "required": ["product_type"]
        }
      },
      {
        "name": "store_policies",
        "description": "Store policies: shipping delays, returns, payment methods, current promotions",
        "endpoint": "https://catalog-api.mesdessous.fr/store_policies",
        "timeoutMs": 3000,
        "input_schema": {
          "type": "object",
          "properties": {
            "topic": { "type": "string", "enum": ["shipping","returns","payments","orders","promo","company"] }
          },
          "required": ["topic"]
        }
      }
    ]
  }
}
```

---

### Fase 9 — Rutas HTTP para gestión de tools desde la UI

**Objetivo**: Exponer endpoints REST dedicados para que el frontend pueda leer, configurar y eliminar `toolsConfig` de un Flow sin necesidad de enviar el payload completo del Flow.

**Estrategia**: Reutilizar `UpdateFlowCommand` (ya existente) con un payload parcial `{ id, toolsConfig }`. No se necesitan nuevos commands ni handlers.

---

#### 9.1 — Agregar `toolsConfig` a `FlowBaseDTO`

**Archivo**: `src/domain/dtos/flow.dto.ts`

En `FlowBaseDTO`, agregar después de `subAgentsConfig`:

```typescript
// Claude Tool Use — tools externos configurados por el cliente
toolsConfig?: { tools: ExternalToolConfig[] } | null;
```

Importar `ExternalToolConfig` desde `@/domain/interfaces/types/ai.type`.

**Nota**: Al estar en `FlowBaseDTO`, `UpdateFlowDTO` (que es `Partial<FlowBaseDTO>`) ya soporta el campo automáticamente — no hay que tocar el command ni el handler.

---

#### 9.2 — Crear schema Zod para las rutas de tools

**Archivo**: `src/infraestructure/http/controllers/schemas/flow.schema.ts`

Agregar al final del archivo (o importar desde `flow-tools-config.schema.ts` creado en Fase 7):

```typescript
// Schema para PUT /flows/:id/tools
export const UpdateFlowToolsSchema = z.object({
  params: UUIDParamsSchema.shape.params,
  body: ToolsConfigSchema,  // importar desde flow-tools-config.schema.ts
});

// Schema para DELETE /flows/:id/tools — solo params
export const DeleteFlowToolsSchema = z.object({
  params: UUIDParamsSchema.shape.params,
});
```

---

#### 9.3 — Agregar métodos al `FlowController`

**Archivo**: `src/infraestructure/http/controllers/flows/flow-query.controller.ts`

Agregar tres métodos al `FlowController` existente:

```typescript
// GET /flows/:id/tools — lee toolsConfig del flow
getTools = async (req: Request, res: Response) => {
  const { params } = UUIDDQuerySchema.parse({ params: req.params });

  const flow = await this.queryBus.query(new GetFlowByIdQuery(params.id));

  const response = SuccessFactory.create("executed", {
    toolsConfig: flow.toolsConfig ?? null,
  });

  ResponseBuilder.sendSuccess(res, response);
};

// PUT /flows/:id/tools — reemplaza toolsConfig completo
updateTools = async (req: Request, res: Response) => {
  const { params, body } = UpdateFlowToolsSchema.parse({
    params: req.params,
    body: req.body,
  });

  const result = await this.commandBus.dispatch(
    new UpdateFlowCommand({ id: params.id, toolsConfig: body }),
  );

  const response = SuccessFactory.create(
    "updated",
    { toolsConfig: result.toolsConfig },
    `Tools del flow ${params.id} actualizados`,
  );

  ResponseBuilder.sendSuccess(res, response);
};

// DELETE /flows/:id/tools — elimina la configuración de tools
deleteTools = async (req: Request, res: Response) => {
  const { params } = DeleteFlowToolsSchema.parse({ params: req.params });

  await this.commandBus.dispatch(
    new UpdateFlowCommand({ id: params.id, toolsConfig: null }),
  );

  const response = SuccessFactory.create(
    "deleted",
    null,
    `Tools del flow ${params.id} eliminados`,
  );

  ResponseBuilder.sendSuccess(res, response);
};
```

**Nota de seguridad**: El `UpdateFlowCommand` ya pasa por el `AuthGuard` — no hay que agregar validaciones de autenticación adicionales en los métodos.

---

#### 9.4 — Registrar las rutas en `FlowRoute`

**Archivo**: `src/infraestructure/http/routes/flow/flow.routes.ts`

Agregar las tres rutas dentro de `get routes()`, antes del cierre del método:

```typescript
// ── Tool Use Config ──────────────────────────────────────────────────────
documentRoute({
  path: "/flows/{id}/tools",
  method: "get",
  tag: "Flows",
  summary: "Obtener configuración de tools del flow",
  hasAuth: true,
  params: UUIDParamsSchema,
});
router.get("/:id/tools", this.guard.validate, this.controller.getTools);

documentRoute({
  path: "/flows/{id}/tools",
  method: "put",
  tag: "Flows",
  summary: "Configurar tools externos para Claude Tool Use",
  hasAuth: true,
  params: UUIDParamsSchema,
  body: UpdateFlowToolsSchema.shape.body,
});
router.put("/:id/tools", this.guard.validate, this.controller.updateTools);

documentRoute({
  path: "/flows/{id}/tools",
  method: "delete",
  tag: "Flows",
  summary: "Eliminar configuración de tools del flow",
  hasAuth: true,
  params: UUIDParamsSchema,
});
router.delete("/:id/tools", this.guard.validate, this.controller.deleteTools);
```

---

#### 9.5 — Asegurar que `UpdateFlowHandler` persiste `toolsConfig`

**Archivo**: `src/app/commands/flow/update-flow.handler.ts`

Verificar que el handler pasa `toolsConfig` al repositorio. Si el handler mapea los campos del DTO explícitamente (no usa spread), hay que agregar:

```typescript
// En el bloque de construcción del update payload:
...(dto.toolsConfig !== undefined && { toolsConfig: dto.toolsConfig }),
```

---

#### 9.6 — Asegurar que el FlowRepository persiste el campo

**Archivo**: `src/infraestructure/database/persistences/repositories/flow.prisma.repository.ts`

Verificar que el método `update()` incluye `toolsConfig` en el objeto que pasa a `prisma.flow.update()`. Si usa spread del DTO, ya funciona. Si es explícito, agregar:

```typescript
toolsConfig: dto.toolsConfig ?? undefined,
```

---

#### 9.7 — Actualizar `api-spec.yml`

**Archivo**: `ai-specs/specs/api-spec.yml`

Agregar las tres rutas nuevas bajo el tag `Flows`:

```yaml
/flows/{id}/tools:
  get:
    summary: Obtener toolsConfig del flow
    tags: [Flows]
    security: [{ bearerAuth: [] }]
    parameters:
      - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
    responses:
      '200':
        description: toolsConfig actual o null si no está configurado
  put:
    summary: Configurar tools externos (Claude Tool Use)
    tags: [Flows]
    security: [{ bearerAuth: [] }]
    parameters:
      - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ToolsConfig'
    responses:
      '200':
        description: toolsConfig actualizado
      '422':
        description: Validación Zod fallida (endpoint inválido, tool sin description, etc.)
  delete:
    summary: Eliminar configuración de tools del flow
    tags: [Flows]
    security: [{ bearerAuth: [] }]
    parameters:
      - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
    responses:
      '200':
        description: toolsConfig eliminado (flow queda sin tools)
```

---

### Resumen de rutas de la Fase 9

| Método | Ruta | Descripción | Auth |
|---|---|---|---|
| `GET` | `/flows/:id/tools` | Leer `toolsConfig` actual | ✅ |
| `PUT` | `/flows/:id/tools` | Reemplazar `toolsConfig` completo | ✅ |
| `DELETE` | `/flows/:id/tools` | Eliminar `toolsConfig` (poner `null`) | ✅ |

**Flujo UI típico**:
1. Al abrir configuración IA del Flow → `GET /flows/:id/tools`
2. El usuario agrega/edita tools en el formulario → `PUT /flows/:id/tools` con el JSON validado
3. El usuario desactiva Tool Use → `DELETE /flows/:id/tools`

**Commits sugeridos**:
- `feat(api): add flow tools config endpoints (GET/PUT/DELETE)`
- `feat(domain): add toolsConfig to FlowBaseDTO`

---

## Checklist de validación (antes de PR)

- [ ] Esquemas Zod en `infra/schemas/` (`flow-tools-config.schema.ts`)
- [ ] `ExternalToolExecutor` usa `fetch` nativo + `AbortController` (no dependencias extra)
- [ ] `ExternalToolExecutor` NUNCA lanza excepciones — retorna JSON de error
- [ ] `ClaudeAPIService.generateResponseWithTools()` es método privado
- [ ] Loop de Tool Use tiene `MAX_TOOL_ROUNDS = 5` como guardia
- [ ] `@inject(DI.ExternalToolExecutor)` en constructor de `ClaudeAPIService`
- [ ] Nuevo token `DI.ExternalToolExecutor` en `global-symbol.ts`
- [ ] `toolsConfig` en `FlowProps`, `FlowEntity` getter y mapper
- [ ] Migración Prisma generada y `data-model.md` actualizado
- [ ] Tests de `ExternalToolExecutor` cubren timeout y error HTTP
- [ ] `buildSystemWithCache()` se llama UNA vez antes del loop (no dentro)
- [ ] `messages` array en `generateResponseWithTools()` es local — `context.messageHistory` no se muta
- [ ] Historial de DatiHub solo recibe `aiResponse.text` (el texto final, nunca bloques tool_use/tool_result)
- [ ] `generateResponseStream()` con tools delega a `generateResponseStreamWithTools()` (streaming real con loop)
- [ ] `generateResponseStreamWithTools()` usa `client.messages.stream()` + `stream.on("text")` en cada round
- [ ] `ExternalToolExecutor` resuelve `apiKey` con prefijo `$` desde `process.env` — no loguea el valor resuelto
- [ ] Bedrock path (`supervisorAgentId`, `BedrockAgentService`) sin cambios
- [ ] `toolsConfig` en `FlowBaseDTO` (para que `UpdateFlowDTO` lo soporte automáticamente)
- [ ] Rutas `GET/PUT/DELETE /flows/:id/tools` registradas en `FlowRoute`
- [ ] Métodos `getTools`, `updateTools`, `deleteTools` en `FlowController`
- [ ] `UpdateFlowHandler` y `FlowRepository` persisten `toolsConfig` (incluyendo `null`)
- [ ] `api-spec.yml` actualizado con las 3 rutas nuevas
- [ ] Commit sigue Conventional Commits: `feat(ai): add claude tool use with external executor`
- [ ] Commit sigue Conventional Commits: `feat(api): add flow tools config endpoints (GET/PUT/DELETE)`

---

## Fuera de alcance (otro repo)

Los siguientes componentes son parte del **Catalog Service** (repo separado):

- Tabla `products` en PostgreSQL separado
- Endpoints `/product_search`, `/size_guide`, `/store_policies`
- Lógica de búsqueda con filtros exactos de talla (regex SQL)
- Sync periódico desde PrestaShop
- Prompt de Julie adaptado para Tool Use

---

*Última actualización: plan inicial*  
*Estado: ⏳ Pendiente de implementación*
