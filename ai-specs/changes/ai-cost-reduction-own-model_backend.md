# Backend Plan: Reducción de Costos IA + Entrenamiento de Modelo Propio

**Date:** 2026-04-06
**Owner:** Backend
**Status:** Propuesto — referencia para implementación futura por fases
**Prioridad:** Alta (impacto directo en costos operativos post-producción)

---

## 1. Contexto y motivación

El sistema actualmente usa **AWS Bedrock con Claude Sonnet 4.5** como único proveedor de IA para *todos* los tipos de consulta, desde routing simple hasta razonamiento complejo. Esto implica:

- Costo de Sonnet: **$3 / 1M input tokens + $15 / 1M output tokens**
- Sin diferenciación por complejidad de tarea
- Sin recolección estructurada de pares pregunta/respuesta
- Sin mecanismo para entrenar un modelo propio en el futuro

La arquitectura actual ya soporta múltiples providers vía `AIServiceFactory` + `AIProvider` enum + `IAIService` interface. El trabajo necesario es *configuración + logging + provider nuevo*, no rediseño.

---

## 2. Inventario del estado actual relevante

| Componente | Archivo | Estado |
|---|---|---|
| Interface genérica | `src/domain/interfaces/ports/ai-service.port.ts` | ✅ Agnóstica de provider |
| Factory de providers | `src/infraestructure/services/ai/ai-service.factory.ts` | ✅ Resuelve por `AIProvider` enum |
| Enum `AIProvider` | `src/domain/value-objects/` + `prisma/schema.prisma` | ✅ `BEDROCK`, `OPENAI`, `ANTHROPIC` |
| Implementación Bedrock | `src/infraestructure/services/ai/bedrock-ai.service.ts` | ✅ Modelo directo |
| Implementación Bedrock Agent | `src/infraestructure/services/ai/bedrock-agent.service.ts` | ✅ Con Knowledge Base |
| Implementación Anthropic Direct | `src/infraestructure/services/ai/claude-api.service.ts` | ✅ |
| Router de modos | `src/infraestructure/services/routing/smart-router.service.ts` | ✅ `FlowType` ROUTER/AI_ONLY/STANDARD |
| Log de ejecución | `prisma/schema.prisma` → `FlowExecutionLog` | ⚠️ Metadatos IA en Json libre |
| Feedback de interacciones | — | ❌ No existe |
| Log estructurado IA | — | ❌ No existe modelo dedicado |
| Provider self-hosted (Ollama) | — | ❌ No existe |

---

## 3. Plan de implementación por fases

---

### FASE 1 — Reducción inmediata de costos (sin código nuevo)

**Objetivo:** Bajar el costo de tokens ~70-91% solo cambiando configuración en la BD.

**Acción**: Cambiar el campo `aiModel` en los Flows de tipo `ROUTER` y FAQ sencillos a Claude 3 Haiku.

| Flow type | Modelo recomendado | Model ID Bedrock | Costo vs Sonnet |
|---|---|---|---|
| `ROUTER` (clasificación/intención) | Claude 3 Haiku | `anthropic.claude-3-haiku-20240307-v1:0` | -91% |
| `AI_ONLY` simple / FAQ | Claude Haiku 3.5 | `anthropic.claude-3-5-haiku-20241022-v1:0` | -70% |
| `AI_ONLY` ventas / razonamiento | Claude Sonnet 4.5 | `anthropic.claude-sonnet-4-5-20250929-v1:0` | sin cambio |

**Cómo aplicarlo:**
```sql
-- Actualizar Flows de tipo ROUTER a Haiku
UPDATE "Flow"
SET "aiModel" = 'anthropic.claude-3-haiku-20240307-v1:0'
WHERE "flowType" = 'ROUTER';
```

No requiere migración ni código. La `AIServiceFactory` ya pasa el `aiModel` del Flow al cliente de Bedrock.

**Commit sugerido:** `chore(config): downgrade router flows to claude-haiku for cost reduction`

---

### FASE 2 — Logging estructurado de interacciones IA

**Objetivo:** Crear la tabla de datos que eventualmente alimentará el fine-tuning. Implementar desde el primer día de producción.

#### 2.1 Nueva tabla en schema.prisma

Agregar al final de `prisma/schema.prisma`, antes del último bloque de modelos:

```prisma
// === LOGGING DE INTERACCIONES IA (Dataset para fine-tuning) ===

model AIInteractionLog {
  id             String  @id @default(uuid())
  conversationId String
  flowId         String

  // Par de entrenamiento (input → output)
  userMessage  String  @db.Text         // Mensaje del usuario
  botResponse  String  @db.Text         // Respuesta generada por la IA
  systemPrompt String? @db.Text         // System prompt usado (contexto)

  // Metadatos de costo y rendimiento
  aiProvider   String  @db.VarChar(50)  // "BEDROCK" | "ANTHROPIC" | "OLLAMA"
  model        String  @db.VarChar(150) // ID exacto del modelo usado
  inputTokens  Int                      // Tokens de entrada consumidos
  outputTokens Int                      // Tokens de salida consumidos
  latencyMs    Int                      // Tiempo de respuesta en ms

  // Señal de calidad (gold data para fine-tuning)
  // null = sin evaluar, 1 = útil, -1 = inútil
  feedback    Int?                      // 1 | -1 | null
  // "AI" = resuelta por IA, "HUMAN" = requirió intervención humana
  resolvedBy  String? @db.VarChar(10)

  createdAt DateTime @default(now())

  @@index([flowId])
  @@index([feedback])
  @@index([createdAt])
  @@index([model])
}
```

**Migración requerida:**
```bash
npx prisma migrate dev --name add_ai_interaction_log
```

**Actualizar `ai-specs/specs/data-model.md`** con la sección del nuevo modelo después de ejecutar la migración.

**Commit sugerido:** `feat(db): add AIInteractionLog model for fine-tuning dataset`

---

#### 2.2 Nueva interfaz de repositorio

**Archivo nuevo:** `src/domain/repositories/ai-interaction-log.repository.ts`

```typescript
export interface AIInteractionLogRepository {
  save(data: {
    conversationId: string;
    flowId: string;
    userMessage: string;
    botResponse: string;
    systemPrompt?: string;
    aiProvider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }): Promise<void>;

  updateFeedback(id: string, feedback: 1 | -1): Promise<void>;

  findTrainingCandidates(filters: {
    feedback?: 1 | -1;
    limit?: number;
    fromDate?: Date;
  }): Promise<AIInteractionLogEntry[]>;
}

export interface AIInteractionLogEntry {
  id: string;
  userMessage: string;
  botResponse: string;
  systemPrompt: string | null;
  model: string;
  feedback: number | null;
}
```

**Commit sugerido:** `feat(domain): add AIInteractionLogRepository interface`

---

#### 2.3 Implementación del repositorio

**Archivo nuevo:** `src/infraestructure/database/prisma/ai-interaction-log.prisma-repository.ts`

```typescript
@injectable()
export class AIInteractionLogPrismaRepository implements AIInteractionLogRepository {
  constructor(@inject(DI.PrismaClient) private prisma: PrismaClient) {}

  async save(data: { ... }): Promise<void> {
    await this.executeSafe(() =>
      this.prisma.aIInteractionLog.create({ data })
    );
  }

  async updateFeedback(id: string, feedback: 1 | -1): Promise<void> {
    await this.executeSafe(() =>
      this.prisma.aIInteractionLog.update({
        where: { id },
        data: { feedback },
      })
    );
  }

  async findTrainingCandidates(filters: { ... }): Promise<AIInteractionLogEntry[]> {
    return this.executeSafe(() =>
      this.prisma.aIInteractionLog.findMany({
        where: {
          ...(filters.feedback ? { feedback: filters.feedback } : {}),
          ...(filters.fromDate ? { createdAt: { gte: filters.fromDate } } : {}),
        },
        take: filters.limit ?? 1000,
        select: {
          id: true,
          userMessage: true,
          botResponse: true,
          systemPrompt: true,
          model: true,
          feedback: true,
        },
      })
    );
  }
}
```

**Registrar en DI container** (`src/infraestructure/DI/container.ts`):
```typescript
container.registerSingleton(DI.AIInteractionLogRepository, AIInteractionLogPrismaRepository);
```

**Agregar símbolo en** `src/infraestructure/DI/global-symbol.ts`:
```typescript
AIInteractionLogRepository: Symbol.for("AIInteractionLogRepository"),
```

**Commit sugerido:** `feat(infra): implement AIInteractionLogPrismaRepository`

---

#### 2.4 Punto de integración — dónde guardar el log

Los logs se deben guardar en `GenerateAIResponseUseCase` (o el Use Case equivalente que llama a `IAIService.generateResponse`), después de obtener la respuesta:

```typescript
// DESPUÉS de recibir la respuesta de IA:
const start = Date.now();
const aiResponse = await this.aiService.generateResponse(input);
const latencyMs = Date.now() - start;

// Guardar log sin bloquear el flujo (fire-and-forget)
this.aiInteractionLog.save({
  conversationId: input.conversationId,
  flowId: input.flowId,
  userMessage: input.message,
  botResponse: aiResponse.response,
  systemPrompt: input.systemPrompt,
  aiProvider: flow.aiProvider,
  model: flow.aiModel ?? 'unknown',
  inputTokens: aiResponse.inputTokens ?? 0,
  outputTokens: aiResponse.outputTokens ?? 0,
  latencyMs,
}).catch(err => logger.warn('Failed to save AI interaction log', { error: err.message }));
```

**Nota importante:** Verificar que `AIResponse` en `src/domain/interfaces/types.ts` exponga `inputTokens` y `outputTokens`. Si no los tiene, agregarlos como opcionales. Bedrock ya los devuelve en el response.

**Commit sugerido:** `feat(app): log ai interactions in generate-response use case`

---

#### 2.5 Endpoint de feedback (opcional, para fase 2+)

**Archivo nuevo:** `src/infraestructure/http/schemas/ai-feedback.schema.ts`
```typescript
export const AIFeedbackSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ feedback: z.union([z.literal(1), z.literal(-1)]) }),
});
```

**Endpoint:** `POST /ai-interactions/:id/feedback`  
Llama a `AIInteractionLogRepository.updateFeedback()`.

**Commit sugerido:** `feat(api): add feedback endpoint for AI interactions`

---

### FASE 3 — Script de export para fine-tuning

**Objetivo:** Exportar los pares con feedback positivo a JSONL, el formato estándar para fine-tuning.

**Archivo nuevo:** `scripts/export-training-data.ts`

```typescript
// Genera un archivo training-data.jsonl con el formato:
// {"messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}

async function exportTrainingData() {
  const logs = await prisma.aIInteractionLog.findMany({
    where: { feedback: 1 },  // Solo los marcados como útiles
    select: { userMessage: true, botResponse: true, systemPrompt: true },
  });

  const lines = logs.map(log => JSON.stringify({
    messages: [
      ...(log.systemPrompt ? [{ role: 'system', content: log.systemPrompt }] : []),
      { role: 'user', content: log.userMessage },
      { role: 'assistant', content: log.botResponse },
    ]
  }));

  fs.writeFileSync('training-data.jsonl', lines.join('\n'));
  console.log(`Exported ${lines.length} training examples`);
}
```

**Uso:**
```bash
npx ts-node scripts/export-training-data.ts
```

Genera `training-data.jsonl` listo para subir a:
- AWS Bedrock → Custom Model Job (cargar a S3 primero)
- HuggingFace AutoTrain (subir directamente)
- Cualquier pipeline de fine-tuning de Mistral/Llama

**Commit sugerido:** `feat(scripts): add training data export script`

---

### FASE 4 — Integración de Ollama (modelo self-hosted)

**Objetivo:** Agregar soporte para modelos locales (fine-tuneados o base) a costo ~$0 por token.

**Cuándo implementar:** Solo después de tener un modelo fine-tuneado o al querer experimentar con Llama 3 / Mistral 7B en desarrollo.

#### 4.1 Agregar OLLAMA al enum

**`prisma/schema.prisma`** — agregar al enum `AIProvider`:
```prisma
enum AIProvider {
  BEDROCK
  OPENAI
  ANTHROPIC
  OLLAMA  // Self-hosted via Ollama (costo ~$0 por token)
}
```

**`src/domain/value-objects/ai-provider.value-object.ts`** (o donde viva el enum de dominio):
```typescript
export enum AIProvider {
  BEDROCK = 'BEDROCK',
  OPENAI = 'OPENAI',
  ANTHROPIC = 'ANTHROPIC',
  OLLAMA = 'OLLAMA',
}
```

**Migración requerida:**
```bash
npx prisma migrate dev --name add_ollama_provider
```

**Commit sugerido:** `feat(db): add OLLAMA to AIProvider enum`

---

#### 4.2 Implementación OllamaAIService

**Archivo nuevo:** `src/infraestructure/services/ai/ollama-ai.service.ts`

```typescript
@injectable()
export class OllamaAIService implements IAIService {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  }

  async generateResponse(input: GenerateResponseInput): Promise<AIResponse> {
    const start = Date.now();
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model ?? 'llama3',
        messages: [
          ...(input.systemPrompt ? [{ role: 'system', content: input.systemPrompt }] : []),
          ...input.messageHistory,
          { role: 'user', content: input.message },
        ],
        stream: false,
        options: {
          temperature: input.temperature ?? 0.7,
          num_predict: input.maxTokens ?? 1000,
        },
      }),
    });

    if (!res.ok) {
      throw ErrorFactory.create('service-unavailable', `Ollama error: ${res.statusText}`);
    }

    const data = await res.json();
    return {
      response: data.message.content,
      provider: AIProvider.OLLAMA,
      model: data.model,
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
      latencyMs: Date.now() - start,
    };
  }

  async generateResponseStream(
    input: GenerateResponseInput,
    onChunk: (chunk: string) => void
  ): Promise<AIResponse> {
    // Implementar streaming via Ollama /api/chat con stream: true
    // Similar a BedrockAIService.generateResponseStream
    throw ErrorFactory.create('not-implemented', 'Ollama streaming not implemented yet');
  }

  async detectIntent(input: IntentDetectionInput): Promise<IntentDetectionResult> {
    // Reusar generateResponse con un system prompt de clasificación
    // Misma lógica que BedrockAIService.detectIntent
    throw ErrorFactory.create('not-implemented', 'Ollama intent detection not implemented yet');
  }

  async generateWithRAG(input: GenerateResponseInput, query: string): Promise<AIResponse> {
    // Ollama no tiene RAG nativo — se puede inyectar el contexto
    // manualmente en el system prompt (Context Stuffing igual que KnowledgeBaseLoader)
    throw ErrorFactory.create('not-implemented', 'Ollama RAG not implemented yet');
  }

  async queryKnowledgeBase(_query: string, _kbId: string): Promise<RAGQueryResult> {
    throw ErrorFactory.create('not-implemented', 'Ollama does not support native knowledge bases');
  }

  async executeFunction(_functionCall: FunctionCall): Promise<any> {
    throw ErrorFactory.create('not-implemented', 'Ollama function calling not implemented yet');
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
```

**Variables de entorno a agregar en `.env.example`:**
```env
# Ollama (self-hosted)
OLLAMA_BASE_URL=http://localhost:11434
```

**Commit sugerido:** `feat(infra): implement OllamaAIService for self-hosted models`

---

#### 4.3 Registrar en DI y Factory

**`src/infraestructure/DI/global-symbol.ts`** — agregar:
```typescript
OllamaAIService: Symbol.for("OllamaAIService"),
```

**`src/infraestructure/DI/container.ts`** — agregar:
```typescript
container.registerSingleton<IAIService>(DI.OllamaAIService, OllamaAIService);
```

**`src/infraestructure/services/ai/ai-service.factory.ts`** — agregar al constructor y switch:
```typescript
// Constructor
@inject(DI.OllamaAIService) private ollamaService: IAIService,

// Switch
case AIProvider.OLLAMA:
  return this.ollamaService;
```

**Commit sugerido:** `feat(infra): register OllamaAIService in DI container and factory`

---

## 4. Variables de entorno necesarias (por fase)

| Variable | Fase | Descripción |
|---|---|---|
| `OLLAMA_BASE_URL` | Fase 4 | URL del servidor Ollama (default: `http://localhost:11434`) |

El resto de la Fase 1 opera con las variables existentes de Bedrock.

---

## 5. Actualización de `api-spec.yml`

Si se implementa el endpoint de feedback (Fase 2.5):

```yaml
/ai-interactions/{id}/feedback:
  post:
    summary: Registrar feedback de una interacción IA
    tags: [AI]
    parameters:
      - name: id
        in: path
        required: true
        schema:
          type: string
          format: uuid
    requestBody:
      content:
        application/json:
          schema:
            type: object
            properties:
              feedback:
                type: integer
                enum: [1, -1]
    responses:
      '200':
        $ref: '#/components/responses/SuccessResponse'
      '404':
        $ref: '#/components/responses/NotFoundError'
```

---

## 6. Orden de implementación recomendado

```
Hoy (pre-producción)
└── Fase 1: SQL update de aiModel en Flows de tipo ROUTER → -91% costo inmediato

Día 1 de producción
└── Fase 2: Migración + AIInteractionLogRepository + integración en Use Case
    └── Recolectar datos desde el primer mensaje real

Mes 3-6 (con datos suficientes: ~5k-10k conversaciones)
└── Fase 3: Ejecutar export-training-data.ts → JSONL → fine-tune en Bedrock Custom Models

Mes 6+ (modelo fine-tuneado disponible)
└── Fase 4: OllamaAIService → configurar Flows a AIProvider.OLLAMA → costo ~$0
```

---

## 7. Commits sugeridos (resumen)

| Orden | Comando | Descripción |
|---|---|---|
| 1 | `chore(config): downgrade router flows to claude-haiku for cost reduction` | SQL en DB, sin cambios de código |
| 2 | `feat(db): add AIInteractionLog model for fine-tuning dataset` | Schema + migración |
| 3 | `feat(domain): add AIInteractionLogRepository interface` | Contrato de dominio |
| 4 | `feat(infra): implement AIInteractionLogPrismaRepository` | Implementación Prisma |
| 5 | `feat(app): log ai interactions in generate-response use case` | Fire-and-forget en use case |
| 6 | `feat(api): add feedback endpoint for AI interactions` | Endpoint opcional |
| 7 | `feat(scripts): add training data export script` | Export JSONL |
| 8 | `feat(db): add OLLAMA to AIProvider enum` | Schema + migración |
| 9 | `feat(infra): implement OllamaAIService for self-hosted models` | Nuevo provider |
| 10 | `feat(infra): register OllamaAIService in DI container and factory` | DI wiring |

---

## 8. Notas importantes para el implementador

1. **`AIResponse` en `src/domain/interfaces/types.ts`** probablemente no tenga `inputTokens`/`outputTokens` como campos explícitos — están en `metadata` o no existen. Verificar antes de la Fase 2 e integrarlos si hace falta.

2. **El log de IA es fire-and-forget**: nunca debe bloquear el envío de la respuesta al usuario. Envolver siempre en `.catch()` para que un fallo de logging no rompa la conversación.

3. **Fase 1 no requiere deploy**: solo un UPDATE en la BD de producción. Se puede hacer en cualquier momento antes o después del primer deploy.

4. **Ollama en producción** requiere ya sea un servidor con GPU (mínimo 8GB VRAM para modelos 7B) o usar una instancia `g4dn.xlarge` en EC2 (~$0.526/hr en us-east-1). Con ~300k tokens/día de tráfico, el break-even frente a Haiku es aproximadamente 3-4 meses.

5. **Fine-tuning en Bedrock Custom Models**: el job cuesta ~$4/1M tokens de entrenamiento (una sola vez). El modelo resultante se cobra por hora de aprovisionamiento ($1.25/hr `Provisioned Throughput`) o por token si se usa `On-Demand`. Con volumen moderado, conviene `On-Demand` hasta estabilizar el tráfico.
