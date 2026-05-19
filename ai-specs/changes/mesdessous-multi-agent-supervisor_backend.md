# Plan: Sistema Multi-Agente Supervisor MesDessous

**Fecha**: 2026-04-29  
**Scope**: Backend — DatiHub  
**Prioridad**: Alta  
**Estado**: En revisión (implementación parcial completada hoy)

---

## 1. Resumen ejecutivo

La implementación del 2026-04-29 establece la base correcta (schema, entidad, builder, mapper), pero tiene **4 bloques pendientes críticos** que impiden que el feature funcione end-to-end:

| Bloque | Severidad | Descripción |
|--------|-----------|-------------|
| Factory selección equivocada de servicio | 🔴 CRÍTICO | Si el Flow solo tiene `supervisorAgentId` (sin `agentId`), la factory devuelve `BedrockAIService` en lugar de `BedrockAgentService` |
| Zod schema sin campos supervisor | 🔴 CRÍTICO | No se pueden crear/actualizar flows con supervisor vía API |
| Handlers sin wiring supervisor | 🔴 CRÍTICO | `create-flow` y `update-flow` ignoran los nuevos campos del DTO |
| FlowBaseDTO incompleto | 🔴 CRÍTICO | Los nuevos campos no están en `flow.dto.ts` → mapper.toDTO pierde tipado |
| `mesdessous` en AI_CONFIG | 🟡 ALTO | Dead code — los IDs de sub-agentes nunca se leen de `AI_CONFIG` |
| `any` en use case | 🟡 ALTO | Viola regla "no any" en parámetros de `invokeWithSupervisor` |
| data-model.md no actualizado | 🟡 ALTO | Obligatorio por reglas del proyecto cuando se modifica schema.prisma |
| api-spec.yml no actualizado | 🟠 MEDIO | Documentación de API desincronizada |
| Sin tests | 🟠 MEDIO | `invokeWithSupervisor` sin cobertura |

---

## 2. Análisis de lo implementado

### 2.1 ✅ Lo que está bien y no debe tocarse

**schema.prisma** — Los 3 campos son correctos:
```prisma
supervisorAgentId      String? @db.VarChar(255)
supervisorAgentAliasId String? @db.VarChar(255)
subAgentsConfig        Json?
```
La migración `20260429000000_add_flow_supervisor_multi_agent` fue aplicada manualmente (`migrate resolve --applied`). No se necesita otra migración.

**FlowEntity** (`src/domain/entities/flow.entity.ts`) — Props + getters correctamente tipados. Dominio puro, sin violaciones.

**FlowBuilder** (`src/domain/builders/flow.builder.ts`) — Setters `setSupervisorAgentId`, `setSupervisorAgentAliasId`, `setSubAgentsConfig` y actualizaciones en `setFromEntity` correctos.

**FlowMapper** (`src/infraestructure/database/persistences/mapper/flow.mapper.ts`) — Bidireccional correcto. `toDomain`, `toPersistence`, `toDTO` todos actualizados.

**Lógica de routing** en `generate-ai-response.use-case.ts` — El algoritmo de `invokeWithSupervisor` + `extractAgentName` es correcto conceptualmente. El patrón (supervisor como router → llamada directa al sub-agente) resuelve el problema de parsing de JSON.

### 2.2 ❌ Lo que está mal o incompleto

#### Bug Crítico — AIServiceFactory selecciona servicio incorrecto

**Archivo**: `src/infraestructure/services/ai/ai-service.factory.ts`  
**Método**: `getServiceFromFlowConfig`

En el use case se llama:
```typescript
const aiService = this.aiServiceFactory.getServiceFromFlowConfig({
  provider: conversation.flow.aiProvider,
  agentId: conversation.flow.agentId,         // puede ser null/undefined
  agentAliasId: conversation.flow.agentAliasId, // puede ser null/undefined
});
```

La factory decide usar `BedrockAgentService` solo si `agentId && agentAliasId`. Pero un Flow supervisor puede **no tener** `agentId/agentAliasId` propios (solo tiene `supervisorAgentId`). En ese caso, la factory devuelve `BedrockAIService` (modelo directo), y cuando `invokeWithSupervisor` llama a `aiService.generateResponse(supervisorInput)` con `config.agentId = supervisorAgentId`, el servicio incorrecto lo maneja.

**Fix**: El call a `getServiceFromFlowConfig` debe hacer fallback a `supervisorAgentId`:
```typescript
const aiService = this.aiServiceFactory.getServiceFromFlowConfig({
  provider: conversation.flow.aiProvider,
  agentId: conversation.flow.agentId ?? conversation.flow.supervisorAgentId,
  agentAliasId: conversation.flow.agentAliasId ?? conversation.flow.supervisorAgentAliasId,
});
```

#### Zod Schema sin campos supervisor

**Archivo**: `src/infraestructure/http/controllers/schemas/flow.schema.ts`  
**Problema**: `FlowBodySchema` no tiene `supervisorAgentId`, `supervisorAgentAliasId`, `subAgentsConfig`. Cualquier petición HTTP para configurar un flow con supervisor fallará silenciosamente (los campos serán descartados por Zod).

#### Handlers sin wiring

**Archivos**: `src/app/commands/flow/create-flow.handler.ts` y `src/app/commands/flow/update-flow.handler.ts`  
**Problema**: Ninguno lee ni pasa al builder los nuevos campos `supervisorAgentId`, `supervisorAgentAliasId`, `subAgentsConfig` del DTO.

#### FlowBaseDTO incompleto

**Archivo**: `src/domain/dtos/flow.dto.ts`  
**Problema**: `FlowBaseDTO` no declara `supervisorAgentId`, `supervisorAgentAliasId`, `subAgentsConfig`. El mapper.toDTO los incluye en el objeto de retorno, pero TypeScript no los tipará correctamente.

#### Dead code en ai.config.ts

**Archivo**: `src/infraestructure/config/ai.config.ts`  
**Problema**: La sección `mesdessous` del `AI_CONFIG` con los 8 env vars se define pero nunca se consume en runtime. Los IDs de agentes se leen de `flow.subAgentsConfig` en BD. Esta sección es dead code.  
**Decisión**: Ver sección 3.

#### `any` en use case

**Archivo**: `src/app/use-cases/ai/generate-ai-response.use-case.ts`  
**Método**: `invokeWithSupervisor`  
```typescript
private async invokeWithSupervisor(params: {
  // ...
  flow: any;     // ← debe ser FlowEntity
  aiConfig: any; // ← debe ser tipado
  aiService: any; // ← debe ser IAIService
}): Promise<AIResponse>
```
Viola la regla de cero `any`.

---

## 3. Decisiones de Diseño

### A. ¿Env vars o dinámico?

**Decisión: Dinámico (BD) en runtime, Env vars solo para seed**

Los IDs de agentes Bedrock son configuración por cliente/flow, no configuración global de sistema. Guardarlos en `AI_CONFIG` como una sección fija crea acoplamiento: si MesDessous cambia un agente, hay que redeploy.

La solución correcta:
- **Runtime**: lee `flow.subAgentsConfig` de la BD (ya implementado correctamente)
- **Seed**: crear `prisma/seed-mesdessous.ts` que lee las env vars y popula el Flow en BD
- **AI_CONFIG**: eliminar la sección `mesdessous` (dead code)
- **Las env vars** (`MESDESSOUS_*`) se mantienen en `.env` solo para el seed script

### B. ¿JSON o tabla dedicada `FlowSubAgent`?

**Decisión: Mantener JSON**

Justificación:
- Los sub-agentes son config bounded (<10 entradas), no datos de negocio independientes
- No hay queries de búsqueda `WHERE subAgent.name = ?` — solo acceso por clave en el map
- Una tabla `FlowSubAgent` requeriría join adicional en cada request de IA
- El JSON con shape documentado es suficiente: `{ [name: string]: { agentId: string; agentAliasId: string } }`

Si en el futuro se necesita gestión CRUD de sub-agentes por separado, se puede migrar.

### C. ¿La lógica de routing pertenece al Use Case?

**Decisión: Sí, con tipado correcto**

`invokeWithSupervisor` es orquestación pura: llama al supervisor, parsea la respuesta, llama al sub-agente. No tiene lógica de persistencia ni de framework. Es análogo a `generateWithRAG` que ya existe en el use case.

No se necesita mover a un adapter de infraestructura. El problema es el tipado débil (`any`), no la ubicación.

---

## 4. Pasos de Implementación

> Orden de ejecución obligatorio: los pasos 1-4 desbloquean el feature end-to-end.

### Paso 1 — Eliminar dead code: ai.config.ts

**Archivo**: `src/infraestructure/config/ai.config.ts`

Eliminar del destructuring de `process.env`:
```typescript
// ELIMINAR estas líneas:
MESDESSOUS_SUPERVISOR_AGENT_ID,
MESDESSOUS_SUPERVISOR_AGENT_ALIAS_ID,
MESDESSOUS_JULIE_AGENT_ID,
MESDESSOUS_JULIE_AGENT_ALIAS_ID,
MESDESSOUS_SOPHIE_AGENT_ID,
MESDESSOUS_SOPHIE_AGENT_ALIAS_ID,
MESDESSOUS_LUCIE_AGENT_ID,
MESDESSOUS_LUCIE_AGENT_ALIAS_ID,
```

Eliminar del objeto `AI_CONFIG`:
```typescript
// ELIMINAR este bloque completo:
mesdessous: {
  supervisor: { ... },
  subAgents: { julie: ..., sophie: ..., lucie: ... },
},
```

Las env vars `MESDESSOUS_*` se definen en `.env` (o `.env.example`) con comentario indicando que son para el seed script, no para runtime.

**Commit**: `chore(config): remove dead mesdessous section from AI_CONFIG`

---

### Paso 2 — Actualizar FlowBaseDTO

**Archivo**: `src/domain/dtos/flow.dto.ts`

Agregar en `FlowBaseDTO`:
```typescript
// Supervisor multi-agente
supervisorAgentId?: string;
supervisorAgentAliasId?: string;
subAgentsConfig?: Record<string, { agentId: string; agentAliasId: string }>;
```

**Commit**: incluir en el commit del paso 3.

---

### Paso 3 — Actualizar Zod Schema

**Archivo**: `src/infraestructure/http/controllers/schemas/flow.schema.ts`

Agregar en `FlowBodySchema` (después de `agentAliasId`):
```typescript
// Supervisor multi-agente
supervisorAgentId: z.string().max(255).optional(),
supervisorAgentAliasId: z.string().max(255).optional(),
subAgentsConfig: z
  .record(
    z.string(),
    z.object({
      agentId: z.string().min(1),
      agentAliasId: z.string().min(1),
    }),
  )
  .optional(),
```

**Commit**: `feat(flow): add supervisor multi-agent fields to flow schema and DTO`

---

### Paso 4 — Actualizar Command Handlers

**Archivo**: `src/app/commands/flow/create-flow.handler.ts`

Después de `if (dto.agentAliasId) flowBuilder.setAgentAliasId(dto.agentAliasId);`, agregar:
```typescript
if (dto.supervisorAgentId) flowBuilder.setSupervisorAgentId(dto.supervisorAgentId);
if (dto.supervisorAgentAliasId) flowBuilder.setSupervisorAgentAliasId(dto.supervisorAgentAliasId);
if (dto.subAgentsConfig) flowBuilder.setSubAgentsConfig(dto.subAgentsConfig);
```

**Archivo**: `src/app/commands/flow/update-flow.handler.ts`

Después de `if (dto.agentAliasId) flowBuilder.setAgentAliasId(dto.agentAliasId);`, agregar:
```typescript
if (dto.supervisorAgentId) flowBuilder.setSupervisorAgentId(dto.supervisorAgentId);
if (dto.supervisorAgentAliasId) flowBuilder.setSupervisorAgentAliasId(dto.supervisorAgentAliasId);
if (dto.subAgentsConfig) flowBuilder.setSubAgentsConfig(dto.subAgentsConfig);
```

**Commit**: `feat(flow): wire supervisor fields in create and update handlers`

---

### Paso 5 — Corregir bug de factory en use case

**Archivo**: `src/app/use-cases/ai/generate-ai-response.use-case.ts`

Reemplazar:
```typescript
const aiService = this.aiServiceFactory.getServiceFromFlowConfig({
  provider: conversation.flow.aiProvider,
  agentId: conversation.flow.agentId,
  agentAliasId: conversation.flow.agentAliasId,
});
```

Por:
```typescript
const aiService = this.aiServiceFactory.getServiceFromFlowConfig({
  provider: conversation.flow.aiProvider,
  // Para flows supervisor, agentId/agentAliasId del flow pueden ser null;
  // el fallback a supervisorAgentId garantiza que se use BedrockAgentService
  agentId: conversation.flow.agentId ?? conversation.flow.supervisorAgentId,
  agentAliasId:
    conversation.flow.agentAliasId ?? conversation.flow.supervisorAgentAliasId,
});
```

**Commit**: incluir en el paso 6.

---

### Paso 6 — Eliminar `any` en use case

**Archivo**: `src/app/use-cases/ai/generate-ai-response.use-case.ts`

Agregar import al inicio del archivo:
```typescript
import { IAIService } from "@/domain/interfaces/ports/ai-service.port";
import { FlowEntity } from "@/domain/entities/flow.entity";
```

Reemplazar la firma del método `invokeWithSupervisor`:
```typescript
// ANTES:
private async invokeWithSupervisor(params: {
  message: string;
  context: AIConversationContext;
  aiConfig: any;
  aiService: any;
  conversationId: string;
  flow: any;
}): Promise<AIResponse>

// DESPUÉS:
private async invokeWithSupervisor(params: {
  message: string;
  context: AIConversationContext;
  aiConfig: ReturnType<typeof this.buildAiConfig>;  // o extraer a tipo
  aiService: IAIService;
  conversationId: string;
  flow: FlowEntity;
}): Promise<AIResponse>
```

> **Nota**: Si `buildAiConfig` no existe como método separado, extraer el tipo del objeto `aiConfig` inline como una interface privada en el archivo.

**Alternativa simple** si el tipo de `aiConfig` es complejo de extraer, definir una interface local:
```typescript
interface SupervisorInvokeParams {
  message: string;
  context: AIConversationContext;
  aiConfig: {
    provider: AIProvider;
    agentId?: string;
    agentAliasId?: string;
    sessionId?: string;
    [key: string]: unknown;
  };
  aiService: IAIService;
  conversationId: string;
  flow: FlowEntity;
}
```

**Commit**: `fix(ai): correct service factory selection for supervisor flows; remove any types`

---

### Paso 7 — Crear seed script MesDessous (opcional pero recomendado)

**Archivo nuevo**: `prisma/seed-mesdessous.ts`

Este script lee las env vars `MESDESSOUS_*` y crea/actualiza el Flow de MesDessous con la configuración del supervisor en BD. Se ejecuta una sola vez en producción vía `npx tsx prisma/seed-mesdessous.ts`.

```typescript
import { prisma } from "@/shared/libs/prisma"; // O el cliente correcto del proyecto

async function main() {
  const {
    MESDESSOUS_SUPERVISOR_AGENT_ID,
    MESDESSOUS_SUPERVISOR_AGENT_ALIAS_ID,
    MESDESSOUS_FLOW_ID, // UUID del flow MesDessous ya existente en BD
    // sub-agentes:
    MESDESSOUS_JULIE_AGENT_ID,
    MESDESSOUS_JULIE_AGENT_ALIAS_ID,
    MESDESSOUS_SOPHIE_AGENT_ID,
    MESDESSOUS_SOPHIE_AGENT_ALIAS_ID,
    MESDESSOUS_LUCIE_AGENT_ID,
    MESDESSOUS_LUCIE_AGENT_ALIAS_ID,
  } = process.env;

  if (!MESDESSOUS_FLOW_ID || !MESDESSOUS_SUPERVISOR_AGENT_ID) {
    throw new Error("Missing required MESDESSOUS_* env vars");
  }

  await prisma.flow.update({
    where: { id: MESDESSOUS_FLOW_ID },
    data: {
      supervisorAgentId: MESDESSOUS_SUPERVISOR_AGENT_ID,
      supervisorAgentAliasId: MESDESSOUS_SUPERVISOR_AGENT_ALIAS_ID,
      subAgentsConfig: {
        julie: {
          agentId: MESDESSOUS_JULIE_AGENT_ID,
          agentAliasId: MESDESSOUS_JULIE_AGENT_ALIAS_ID,
        },
        sophie: {
          agentId: MESDESSOUS_SOPHIE_AGENT_ID,
          agentAliasId: MESDESSOUS_SOPHIE_AGENT_ALIAS_ID,
        },
        lucie: {
          agentId: MESDESSOUS_LUCIE_AGENT_ID,
          agentAliasId: MESDESSOUS_LUCIE_AGENT_ALIAS_ID,
        },
      },
    },
  });

  console.log("MesDessous flow supervisor config updated successfully");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

**Commit**: `feat(seed): add mesdessous supervisor flow seed script`

---

### Paso 8 — Actualizar data-model.md (OBLIGATORIO)

**Archivo**: `ai-specs/specs/data-model.md`

En la sección `3.1 Flow`, agregar los campos nuevos en **Fields**:
```markdown
- `supervisorAgentId`: ID del agente Bedrock que actúa como router multi-agente (opcional)
- `supervisorAgentAliasId`: Alias ID del agente supervisor (opcional)
- `subAgentsConfig`: Mapa JSON de sub-agentes: `{ [nombre]: { agentId, agentAliasId } }` (opcional). Ejemplo: `{ "julie": { "agentId": "...", "agentAliasId": "..." } }`

También actualizar los campos de Bedrock Agents:
- `agentId`: ID del agente Bedrock directo (sin supervisor) (opcional)
- `agentAliasId`: Alias ID del agente Bedrock directo (opcional)
```

Agregar nota de arquitectura al final de la sección Flow:
```markdown
**Modo Supervisor Multi-Agente**: Cuando `supervisorAgentId` está configurado, DatiHub implementa un patrón de routing en dos pasos:
1. Se consulta al agente supervisor qué sub-agente debe responder
2. Se llama directamente al sub-agente indicado (preservando el JSON estructurado de su respuesta)
Este patrón evita que el supervisor reescriba el JSON de los sub-agentes como texto plano.
```

**Commit**: `docs(data-model): add supervisor multi-agent fields to Flow model`

---

### Paso 9 — Actualizar api-spec.yml

**Archivo**: `ai-specs/specs/api-spec.yml`

Buscar el schema de `FlowBody` o `CreateFlowRequest` y agregar las propiedades:
```yaml
supervisorAgentId:
  type: string
  maxLength: 255
  description: "ID del agente Bedrock que actúa como router multi-agente"
  example: "ABCD1234EF"
supervisorAgentAliasId:
  type: string
  maxLength: 255
  description: "Alias ID del agente supervisor Bedrock"
  example: "TSTALIASID"
subAgentsConfig:
  type: object
  description: "Mapa de sub-agentes: nombre → { agentId, agentAliasId }"
  additionalProperties:
    type: object
    required: [agentId, agentAliasId]
    properties:
      agentId:
        type: string
      agentAliasId:
        type: string
  example:
    julie:
      agentId: "JULIE_AGENT_ID"
      agentAliasId: "JULIE_ALIAS_ID"
```

**Commit**: `docs(api-spec): add supervisor multi-agent fields to flow schema`

---

## 5. Tests requeridos (Vitest)

### 5.1 Archivo nuevo: `test/app/use-cases/ai/generate-ai-response.use-case.spec.ts`

Los tests deben cubrir las 4 ramas del bloque de decisión en `execute()`:

```typescript
describe("GenerateAIResponseUseCase — supervisor routing", () => {
  describe("when flow has supervisorAgentId configured", () => {
    it("should call supervisor first, then route to indicated sub-agent", async () => {
      // Arrange: flow con supervisorAgentId, supervisorAgentAliasId, subAgentsConfig
      // mockSupervisorResponse.text = '{"agent":"julie"}'
      // Assert: aiService.generateResponse llamado 2 veces:
      //   1. con config.agentId = supervisorAgentId
      //   2. con config.agentId = subAgentsConfig.julie.agentId
    });

    it("should return supervisor response directly when no agent name extracted", async () => {
      // Arrange: supervisorResponse.text = "Hola, ¿en qué puedo ayudarte?"
      // Assert: aiService.generateResponse llamado solo 1 vez
    });

    it("should fallback to supervisor response when routed agent not in subAgentsConfig", async () => {
      // Arrange: supervisorResponse indica "marc" (no existe en subAgentsConfig)
      // Assert: devuelve supervisorResponse directamente
    });

    it("should add routedAgent metadata to final response", async () => {
      // Assert: response.metadata.routedAgent === "julie"
    });
  });

  describe("extractAgentName", () => {
    it("should parse JSON format { agent: 'julie' }", () => { ... });
    it("should parse JSON format { agente: 'sophie' }", () => { ... });
    it("should match plain text 'lucie'", () => { ... });
    it("should match agent name within longer text", () => { ... });
    it("should return null for unrecognized text", () => { ... });
    it("should return null for failed supervisor call", () => { ... });
  });
});
```

### 5.2 Archivo nuevo: `test/app/commands/flow/create-flow-supervisor.spec.ts`

```typescript
describe("CreateFlowCommandHandler — supervisor fields", () => {
  it("should persist supervisorAgentId, supervisorAgentAliasId, subAgentsConfig", async () => {
    // Arrange: DTO con los 3 campos supervisor
    // Assert: flowRepository.createWithSteps llamado con flow.supervisorAgentId === valor esperado
  });
});
```

**Commit**: `test(ai): add supervisor routing coverage for GenerateAIResponseUseCase`

---

## 6. Requisito operacional: System Prompt del Supervisor

El agente supervisor en Bedrock **debe** estar configurado con un system prompt que garantice output JSON estructurado. Sin esto, `extractAgentName` depende de heurísticas frágiles de texto.

**System prompt recomendado para el supervisor (configurar en Bedrock Console)**:
```
Eres un agente router. Tu única función es determinar qué especialista debe responder al usuario.
Responde SIEMPRE con JSON puro en este formato exacto: {"agent": "<nombre>"}
Los agentes disponibles son: julie (recomendaciones de productos), sophie (guías de tallas), lucie (soporte al cliente).
Si no estás seguro, usa: {"agent": "lucie"}
NO agregues texto adicional. Solo el JSON.
```

Documentar este requisito en: `docs/guides/multi-agent-architecture.md` (sección nueva "Configuración del Supervisor MesDessous").

**Commit**: `docs(guides): document supervisor system prompt requirement for MesDessous`

---

## 7. Cambios a revertir o corregir de lo hecho hoy

| Archivo | Acción requerida |
|---------|-----------------|
| `src/infraestructure/config/ai.config.ts` | Eliminar sección `mesdessous` del `AI_CONFIG` y las 8 vars del destructuring |
| `src/app/use-cases/ai/generate-ai-response.use-case.ts` | (a) Corregir llamada a `getServiceFromFlowConfig` con fallback a supervisorAgentId; (b) reemplazar `any` por tipos correctos |

**Nada debe revertirse en**: schema.prisma, FlowEntity, FlowBuilder, FlowMapper — están correctos.

---

## 8. Commits sugeridos (Conventional Commits)

```bash
# 1 — Dead code
git commit -m "chore(config): remove dead mesdessous section from AI_CONFIG"

# 2+3 — DTO + Zod (juntos porque son el contrato del mismo feature)
git commit -m "feat(flow): add supervisor multi-agent fields to DTO and Zod schema"

# 4 — Handlers
git commit -m "feat(flow): wire supervisor fields in create and update handlers"

# 5+6 — Bug fix + tipos (relacionados en el mismo use case)
git commit -m "fix(ai): correct service factory selection for supervisor flows; remove any types"

# 7 — Seed
git commit -m "feat(seed): add mesdessous supervisor flow seed script"

# 8 — Documentación (puede ir en el mismo commit si se hace junto)
git commit -m "docs(data-model): add supervisor multi-agent fields to Flow model"

# 9
git commit -m "docs(api-spec): add supervisor multi-agent fields to flow schema"

# 10 — Tests
git commit -m "test(ai): add supervisor routing coverage for GenerateAIResponseUseCase"
```

---

## 9. Checklist de validación final

Antes de considerar el feature completo:

- [ ] `src/infraestructure/config/ai.config.ts` — sección `mesdessous` eliminada
- [ ] `src/domain/dtos/flow.dto.ts` — campos supervisor en `FlowBaseDTO`
- [ ] `src/infraestructure/http/controllers/schemas/flow.schema.ts` — campos supervisor en `FlowBodySchema`
- [ ] `src/app/commands/flow/create-flow.handler.ts` — wiring supervisor fields
- [ ] `src/app/commands/flow/update-flow.handler.ts` — wiring supervisor fields
- [ ] `src/app/use-cases/ai/generate-ai-response.use-case.ts` — factory call con fallback; sin `any`
- [ ] `ai-specs/specs/data-model.md` — campos nuevos documentados
- [ ] `ai-specs/specs/api-spec.yml` — campos nuevos en schema OpenAPI
- [ ] Tests vitest — `invokeWithSupervisor` y `extractAgentName` cubiertos
- [ ] `prisma/seed-mesdessous.ts` creado
- [ ] Bedrock supervisor: system prompt de JSON puro configurado en consola AWS
- [ ] `docs/guides/multi-agent-architecture.md` — sección sobre prompt del supervisor agregada

---

## 10. Diagrama del flujo (resumen)

```
Cliente → DatiHub
  ↓
execute() en GenerateAIResponseUseCase
  ↓
¿flow.supervisorAgentId existe?
  ├─ Sí → invokeWithSupervisor()
  │         ├─ 1. Llama supervisor → {"agent": "julie"}
  │         ├─ 2. extractAgentName → "julie"
  │         ├─ 3. Busca subAgentsConfig["julie"]
  │         └─ 4. Llama directamente a Julie → JSON puro preservado ✅
  └─ No → flujo normal (RAG o generateResponse directo)
```

---

> **Nota para el implementador**: El bug más peligroso es el de la factory (Paso 5). Si el Flow MesDessous solo tiene `supervisorAgentId` configurado (y `agentId` es null), el sistema llamará a `BedrockAIService` (modelo LLM directo) en lugar de `BedrockAgentService` (Bedrock Agents API). Esto generará errores HTTP 400 desde AWS porque el payload esperado es diferente. Implementar Paso 5 primero antes de hacer pruebas en staging.
