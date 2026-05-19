# Plan de Optimización de Repositories + Embeddings

**Proyecto**: datihub_backend  
**Fecha**: 2026-04-11  
**Estado**: ✅ Fase 1 Completada

---

## Resumen Ejecutivo

Este documento presenta un plan para:

1. **Optimizar** los repositories con problemas de rendimiento
2. **Evaluar** la conveniencia de implementar embeddings para el sistema RAG

---

## 1. Problemas de Rendimiento Identificados

### ✅ Fase 1 Completada (2026-04-11)

| Archivo                            | Método              | Problema                                            | Estado        |
| ---------------------------------- | ------------------- | --------------------------------------------------- | ------------- |
| `flow.prisma.repository.ts`        | `createWithSteps`   | Loop secuencial con await individual para cada step | ✅ Optimizado |
| `flow.prisma.repository.ts`        | `updateWithSteps`   | Múltiples loops secuenciales + N+1 en options       | ✅ Optimizado |
| `flow-metric.prisma.repository.ts` | `getByConversation` | Trae TODOS los eventos y filtra en memoria          | ✅ Optimizado |
| `flow-metric.prisma.repository.ts` | `getByPhone`        | Mismo problema - filter en memoria                  | ✅ Optimizado |
| `flow-metric.prisma.repository.ts` | `getByKeyword`      | Mismo problema                                      | ✅ Optimizado |
| `flow-metric.prisma.repository.ts` | `getEventOverview`  | 3 queries secuenciales                              | ✅ Optimizado |

### ✅ Mejoras Adicionales

| Archivo                  | Método      | Mejora                                 | Estado          |
| ------------------------ | ----------- | -------------------------------------- | --------------- |
| `flow.builder.ts`        | `setFrom()` | Nuevo método para merge DTO + existing | ✅ Implementado |
| `update-flow.handler.ts` | handle()    | Reducido de 103 a ~70 líneas           | ✅ Optimizado   |

### 🟡 Pendiente

| Archivo                             | Método               | Problema               | Severidad |
| ----------------------------------- | -------------------- | ---------------------- | --------- |
| `conversation.prisma.repository.ts` | `createConversation` | 3 queries secuenciales | Media     |

---

## 2. Sistema RAG Actual

| Aspecto            | Estado                                  |
| ------------------ | --------------------------------------- |
| **Almacenamiento** | Texto plano (PostgreSQL `content` TEXT) |
| **Búsqueda**       | Ninguna — **Context Stuffing**          |
| **Embeddings**     | ❌ NO implementado                      |
| **Límite actual**  | ~200k tokens (Claude Sonnet)            |

### Cómo funciona actualmente:

```
1. KB → trae TODOS los documentos activos (concat)
2. Prompt → inyecta todo el contenido
3. LLM → filtra lo relevante
```

### Limitaciones:

- Si la KB supera los ~200k tokens → truncado o error
- No hay búsqueda semántica
- No hay deduplicación semántica

---

## 3. Evaluación: ¿Conviene Trabajar con Embeddings?

### ✅ SÍ, y es necesario.

**Razones técnicas:**

1. **Escalabilidad**: Cuando la KB crezca, el context stuffing ya no va a funcionar
2. **pgvector disponible**: PostgreSQL ya lo soporta
3. **Prompt caching**: Los embeddings son para búsqueda, el texto completo sigue sirviendo para contexto
4. **Calidad**: Semantic search retorna chunks relevantes vs texto completo

### Arquitectura propuesta:

```
[User Query]
      ↓
[Embedding Model] → Vector Search (pgvector)
      ↓
Top-K Chunks (con texto completo)
      ↓
[LLM] → Context + Prompt
```

---

## 4. Plan de Implementación

### Fase 1: Optimización de Repositories (Inmediato)

| #   | Tarea                                        | Esfuerzo | Impacto |
| --- | -------------------------------------------- | -------- | ------- |
| 1.1 | `createWithSteps` → `createMany`             | Bajo     | Alto    |
| 1.2 | `updateWithSteps` → parallel + batch         | Medio    | Alto    |
| 1.3 | `flow-metric` → raw queries JSON             | Medio    | Alto    |
| 1.4 | `getEventOverview` → 1 query con aggregation | Bajo     | Medio   |

### Fase 2: Embeddings (Cuando la KB lo justifique)

| #   | Tarea                                 | Esfuerzo | Impacto   |
| --- | ------------------------------------- | -------- | --------- |
| 2.1 | Agregar `pgvector` al schema          | Medio    | Requerido |
| 2.2 | Crear tabla `DocumentChunk`           | Medio    | Requerido |
| 2.3 | Embedding service (AWS Bedrock/Titan) | Alto     | Requerido |
| 2.4 | Hybrid search (vector + keyword)      | Alto     | Alto      |

---

## 5. Recomendación

**Inmediato**: Implementar Fase 1 (optimización de repositories)

**Medio plazo**: Los embeddings son una inversión que tiene sentido cuando:

1. Las KBs superen ~50k tokens frecuentemente
2. La búsqueda semántica sea un requerimiento real del negocio
3. Estés dispuesto a invertir en la infraestructura de vectores
