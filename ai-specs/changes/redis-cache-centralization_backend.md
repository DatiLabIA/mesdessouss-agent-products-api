# Backend Plan: Redis / CacheManager Centralization

**Date:** 2026-03-29
**Owner:** Backend
**Status:** Proposed (no implementation in this document)
**Triggered by:** [architecture-improvement-plan_backend.md §4.2](./architecture-improvement-plan_backend.md)

---

## 1. Contexto y motivación

La recomendación §4.2 del plan de mejora arquitectónica identifica que `BedrockAgentService` gestiona
dos cachés privadas mediante `Map<>` con lógica manual de TTL y evicción. El problema señalado es:

- **No reseteable en tests** — no hay forma de limpiar el estado entre suites sin acceder a privados.
- **TTLs hardcodeados** — `SESSION_TTL = 30 * 60 * 1000` y `RESPONSE_CACHE_TTL = 5 * 60 * 1000`
  son constantes inmutables en la clase.
- **Sin métricas** — ningún hit/miss observable ni instrumentable.
- **No persiste entre reinicios del proceso** — si el pod se reinicia, sesiones activas de Bedrock
  Agent se pierden y el usuario pierde todo el contexto conversacional.

Al mismo tiempo el proyecto **ya dispone** de una infraestructura de caché completa que no usa ningún
servicio todavía:

| Archivo | Responsabilidad |
|---|---|
| `src/domain/interfaces/providers/cache.provider.ts` | Puerto `CacheProvider` (get/put/forget/has/flush/remember) |
| `src/infraestructure/cache/drivers/array-cache-driver.ts` | Driver en memoria (Map) |
| `src/infraestructure/cache/drivers/redis-cache-driver.ts` | Driver Redis (ioredis / node-redis) |
| `src/infraestructure/cache/CacheManager.ts` | Resuelve el driver según `CACHE_DRIVER` de env |
| `src/infraestructure/config/env.ts` | `CACHE_CONFIG.DRIVER` default `"array"` |
| `src/infraestructure/DI/container.ts` líneas 577-587 | `CACHE_TOKEN.Array`, `CACHE_TOKEN.Redis`, `CACHE_TOKEN.Manager` registrados como singletons |

El problema es que **todo está registrado pero cero clases lo consumen vía inyección**.

---

## 2. Inventario de cachés en `Map<>` — clasificación

| Archivo | Campo | ¿Es caché migratable? | Notas |
|---|---|---|---|
| `bedrock-agent.service.ts` | `sessionCache` | **Sí** — TTL 30 min, clave `conversationId:agentId` | Candidato principal |
| `bedrock-agent.service.ts` | `responseCache` | **Sí** — TTL 5 min, clave `agentId:normalizedMessage` | Candidato principal |
| `knowledge-base-loader.service.ts` | `cache` | **Sí** — sin TTL, contenido de KB | Migrar con `array` forzado (ver §5) |
| `knowledge-base-loader.service.ts` | `loadingPromises` | **No** — mutex de concurrencia, no caché | Mantener como `Map` local |
| `services/whatsapp/funcional/flowEngine.service.ts` | `flowCache` | Fuera de scope | Código legacy en `src/services/`, no Clean Architecture |
| Resto de Maps | varios | **No** — registros de handlers, conexiones activas, tareas | No son cachés, son estructuras de datos del dominio |

---

## 3. Estado actual de inyección en `BedrockAgentService`

```typescript
// ACTUAL — src/infraestructure/services/ai/bedrock-agent.service.ts
@injectable()
export class BedrockAgentService implements IAIService {
  private sessionCache: Map<string, { sessionId: string; lastUsed: number }> = new Map();
  private responseCache: Map<string, CachedResponse> = new Map();
  private readonly SESSION_TTL = 30 * 60 * 1000;       // ms
  private readonly RESPONSE_CACHE_TTL = 5 * 60 * 1000; // ms
  private readonly ENABLE_RESPONSE_CACHING = process.env.ENABLE_RESPONSE_CACHING !== "false";

  constructor() {
    // Constructor vacío — sin inyección de dependencias
  }
  ...
}
```

**Problemas derivados:**
1. Evicción manual cuando `size > 1000` / `size > 500` (loop O(n) sincrónico).
2. Los TTLs no se pueden sobrescribir sin tocar el código.
3. En un proceso multi-worker (cluster o PM2 con varios workers), cada worker tiene su propio Map →
   inconsistencia de sesiones Bedrock entre workers.

---

## 4. Estado actual de inyección en `KnowledgeBaseLoaderService`

```typescript
// ACTUAL — src/infraestructure/services/ai/knowledge-base-loader.service.ts
@injectable()
export class KnowledgeBaseLoaderService implements IKnowledgeBaseLoader {
  private cache = new Map<string, CachedKB>();            // contenido de KB
  private loadingPromises = new Map<string, Promise<void>>(); // mutex concurrencia

  constructor(
    @inject(DI.KnowledgeBaseRepository)
    private readonly kbRepository: KnowledgeBaseRepository,
  ) {}
  ...
}
```

Ya tiene inyección correcta de su repositorio. Solo el `cache` de contenido es candidato a migrar;
`loadingPromises` **no** se migra porque es coordinación in-process.

---

## 5. Decisión de driver por servicio

| Servicio | Driver recomendado | Razón |
|---|---|---|
| `BedrockAgentService.sessionCache` | **Default env** (`CACHE_DRIVER`) | Session IDs son pequeños; Redis en producción permite persistencia entre reinicios y compartir entre workers |
| `BedrockAgentService.responseCache` | **Default env** (`CACHE_DRIVER`) | Mismo razonamiento; respuestas cacheadas se comparten entre workers |
| `KnowledgeBaseLoaderService.cache` | **Forzado `"array"`** | El contenido de una KB puede ser un documento largo; serializar/deserializar en Redis en cada `getContent()` es overhead innecesario. La KB se recarga via `reload()` cuando cambia, no necesita ser compartida entre workers |

---

## 6. Patrón de inyección propuesto: token `DI.Cache`

En lugar de inyectar `CacheManager` (que requiere llamar `.store()`) o un driver concreto, se registra
un token de conveniencia `DI.Cache` que ya resuelve el store activo según env:

### 6.1 — Agregar token `DI.Cache` en `global-symbol.ts`

```typescript
// PROPUESTO — src/infraestructure/DI/global-symbol.ts
export const DI = {
  // ... tokens existentes ...
  Cache: Symbol.for("CacheProvider"),  // ← nuevo: store activo según CACHE_DRIVER
} as const;
```

### 6.2 — Registrar `DI.Cache` como factory en `container.ts`

```typescript
// PROPUESTO — src/infraestructure/DI/container.ts (sección CACHE, después de línea 587)
container.register<CacheProvider>(DI.Cache, {
  useFactory: (c) => c.resolve<CacheManager>(CACHE_TOKEN.Manager).store(),
});
```

Esto hace que `@inject(DI.Cache)` resuelva el driver configurado en `CACHE_DRIVER` sin que el servicio
sepa si está hablando con un `Map` en memoria o con Redis.

**Imports adicionales necesarios en `container.ts`:**
```typescript
import { CacheProvider } from "@/domain/interfaces/providers/cache.provider";
// CacheManager ya está importado en línea 198
```

---

## 7. Refactor de `BedrockAgentService`

### 7.1 — Constructor: agregar inyección de `CacheProvider`

```typescript
// PROPUESTO
import { inject, injectable } from "tsyringe";
import { CacheProvider } from "@/domain/interfaces/providers/cache.provider";
import { DI } from "@/infraestructure/DI/global-symbol";

@injectable()
export class BedrockAgentService implements IAIService {
  // ✅ Eliminar los dos campos Map privados
  // ✅ Eliminar SESSION_TTL y RESPONSE_CACHE_TTL como constantes de clase
  // ✅ Conservar ENABLE_RESPONSE_CACHING (sigue siendo env flag)

  private readonly SESSION_TTL_SECONDS = 30 * 60;       // ⚠️ en SEGUNDOS (CacheProvider.put usa segundos)
  private readonly RESPONSE_CACHE_TTL_SECONDS = 5 * 60; // ⚠️ en SEGUNDOS

  constructor(
    @inject(DI.Cache) private readonly cache: CacheProvider,
  ) {
    logger.info("BedrockAgentService initialized", { feature: "ai-agent" as const });
  }
  ...
}
```

> **⚠️ Atención — cambio de unidad:** las constantes actuales están en **milisegundos**.
> `CacheProvider.put(key, value, ttl)` acepta TTL en **segundos**.
> Hay que dividir entre 1000 al migrar. Si no se convierte, el TTL será 90.000 segundos (≈25 horas) en
> lugar de 30 minutos.

### 7.2 — Método `getSessionId` → `getOrCreateSessionId` (ahora async)

```typescript
// ANTES (sync)
private getSessionId(conversationId: string, agentId: string): string {
  const cacheKey = `${conversationId}:${agentId}`;
  const cached = this.sessionCache.get(cacheKey);
  ...
  this.sessionCache.set(cacheKey, { sessionId: newSessionId, lastUsed: now });
  return newSessionId;
}

// PROPUESTO (async)
private async getOrCreateSessionId(conversationId: string, agentId: string): Promise<string> {
  const cacheKey = `bedrock:session:${conversationId}:${agentId}`;

  const cached = await this.cache.get<string>(cacheKey);
  if (cached) return cached;

  const newSessionId = `session-${conversationId}-${Date.now()}`;
  await this.cache.put(cacheKey, newSessionId, this.SESSION_TTL_SECONDS);
  return newSessionId;
}
```

**Ventaja:** desaparece la lógica de evicción manual (el TTL del driver cabalga con evicción automática
en `ArrayCacheDriver` y con `EXPIRE` nativo en `RedisCacheDriver`).

### 7.3 — Métodos `getCachedResponse` / `setCachedResponse` → async

```typescript
// PROPUESTO
private async getCachedResponse(cacheKey: string): Promise<AIResponse | null> {
  if (!this.ENABLE_RESPONSE_CACHING) return null;
  return this.cache.get<AIResponse>(`bedrock:response:${cacheKey}`);
}

private async setCachedResponse(cacheKey: string, response: AIResponse): Promise<void> {
  if (!this.ENABLE_RESPONSE_CACHING) return;
  await this.cache.put(`bedrock:response:${cacheKey}`, response, this.RESPONSE_CACHE_TTL_SECONDS);
}
```

### 7.4 — Actualizar todos los callers de `getSessionId` y `getCachedResponse`

Todos los métodos de `BedrockAgentService` que hoy llaman a estos métodos privados deben pasar a
`await`. Se trata de métodos dentro del mismo servicio, bajo `async invoke*()` ya existentes, por lo
que el cambio es mecánico.

### 7.5 — Eliminar código de evicción manual

Los bloques:
```typescript
if (this.sessionCache.size > 1000) {
  for (const [key, value] of this.sessionCache.entries()) {
    if (now - value.lastUsed > this.SESSION_TTL) {
      this.sessionCache.delete(key);
    }
  }
}
```
y el equivalente en `responseCache` se eliminan completamente. La gestión de TTL y memoria la
delega el driver.

---

## 8. Refactor de `KnowledgeBaseLoaderService`

### 8.1 — Constructor: inyectar `CacheManager` + crear store forzado a `"array"`

```typescript
// PROPUESTO
import { inject, injectable } from "tsyringe";
import { CacheManager } from "@/infraestructure/cache/CacheManager";
import { CacheProvider } from "@/domain/interfaces/providers/cache.provider";
import { CACHE_TOKEN } from "@/infraestructure/config/cache.config";

@injectable()
export class KnowledgeBaseLoaderService implements IKnowledgeBaseLoader {
  private readonly contentCache: CacheProvider;

  // ✅ loadingPromises se mantiene como Map local (es un mutex de concurrencia, no una caché)
  private loadingPromises = new Map<string, Promise<void>>();

  constructor(
    @inject(DI.KnowledgeBaseRepository)
    private readonly kbRepository: KnowledgeBaseRepository,
    @inject(CACHE_TOKEN.Manager)
    cacheManager: CacheManager,
  ) {
    // Forzar driver en memoria para el contenido de KB (evitar overhead de serialización Redis)
    this.contentCache = cacheManager.store("array");
  }
  ...
}
```

> **Nota:** Se inyecta `CacheManager` en lugar de `DI.Cache` porque necesitamos seleccionar
> explícitamente el driver `"array"` independiente de `CACHE_DRIVER` de env.

### 8.2 — Método `getContent`: reemplazar `this.cache.get` con `this.contentCache.get`

```typescript
// ANTES
async getContent(knowledgeBaseId: string): Promise<string> {
  const cached = this.cache.get(knowledgeBaseId);
  if (!cached?.loaded) {
    ...
  }
  return this.cache.get(knowledgeBaseId)?.content || "";
}

// PROPUESTO
async getContent(knowledgeBaseId: string): Promise<string> {
  const cached = await this.contentCache.get<CachedKB>(knowledgeBaseId);
  if (!cached?.loaded) {
    if (!this.loadingPromises.has(knowledgeBaseId)) {
      const promise = this.reload(knowledgeBaseId).finally(() => {
        this.loadingPromises.delete(knowledgeBaseId);
      });
      this.loadingPromises.set(knowledgeBaseId, promise);
    }
    await this.loadingPromises.get(knowledgeBaseId);
  }
  return (await this.contentCache.get<CachedKB>(knowledgeBaseId))?.content ?? "";
}
```

### 8.3 — Método `getApproximateTokenCount`: ahora sincrónico vs async

`getApproximateTokenCount()` actualmente accede directamente al Map (sync). Con `CacheProvider` la
operación en async. Hay dos opciones:

**Opción A (recomendada):** Cambiar la firma del método a `async getApproximateTokenCount(id): Promise<number>`
y actualizar el puerto `IKnowledgeBaseLoader` correspondiente.

**Opción B (conservadora):** Mantener una variable auxiliar `tokensMap: Map<string, number>` solo para
los token counts (no el contenido completo) para que el método siga sync.

> **Recomendación:** Opción A — es la consistente con el resto de métodos async del servicio, y el
> puerto `IKnowledgeBaseLoader` está solo usado por `IAIService` implementors, no por controladores HTTP.

### 8.4 — Método `reload`: actualizar escritura de caché

```typescript
// PROPUESTO — escritura en contentCache
await this.contentCache.put(
  knowledgeBaseId,
  { content: activeDocuments.join("\n\n"), approximateTokens: tokens, loaded: true } satisfies CachedKB,
  // sin TTL → no-expiry; la KB se invalida llamando reload() explícitamente
);
```

### 8.5 — Invalidación de KB

El método `reload()` ya existe. Para invalidar hay que llamar `await this.contentCache.forget(id)`
antes de recargar, o simplemente sobrescribir con `put`. La invalidación está fuera del scope de este
plan pero el puerto `forget()` ya existe.

---

## 9. Cambios en el DI container

### 9.1 — `src/infraestructure/DI/global-symbol.ts`

Agregar un token:
```typescript
Cache: Symbol.for("CacheProvider"),
```

### 9.2 — `src/infraestructure/DI/container.ts`

**Imports adicionales** (junto a los imports de cache existentes en línea 197-198):
```typescript
import { CacheProvider } from "@/domain/interfaces/providers/cache.provider";
```

**Registro del token `DI.Cache`** (justo después de la línea 587, dentro de la sección `// CACHE`):
```typescript
container.register<CacheProvider>(DI.Cache, {
  useFactory: (c) => c.resolve<CacheManager>(CACHE_TOKEN.Manager).store(),
});
```

**Registro de `BedrockAgentService`** (línea ~463 actualmente es `registerSingleton` sin cambio
de token, pero el servicio ya no puede ser un singleton si su constructor espera inyecciones):

```typescript
// VERIFICAR que sigue como singleton — está bien porque CacheProvider es singleton
container.registerSingleton<BedrockAgentService>(DI.BedrockAgentService, BedrockAgentService);
```

> `BedrockAgentService` puede seguir siendo singleton porque `CacheProvider` (su única inyección nueva)
> es también un singleton.

**Registro de `KnowledgeBaseLoaderService`** no cambia el token ni la clase, pero ahora el constructor
tiene un nuevo parámetro `CacheManager`. TSyringe lo resolverá automáticamente porque `CacheManager`
está registrado bajo `CACHE_TOKEN.Manager` y el parámetro decora `@inject(CACHE_TOKEN.Manager)`.

---

## 10. Archivos a crear / modificar

| Archivo | Acción | Cambios clave |
|---|---|---|
| `src/infraestructure/DI/global-symbol.ts` | Modificar | Añadir `Cache: Symbol.for("CacheProvider")` |
| `src/infraestructure/DI/container.ts` | Modificar | Agregar import `CacheProvider`; registrar `DI.Cache` factory |
| `src/infraestructure/services/ai/bedrock-agent.service.ts` | Modificar | Eliminar Maps privados; inyectar `@inject(DI.Cache) cache: CacheProvider`; convertir `getSessionId` + cache methods a async; eliminar evicción manual; convertir TTLs a segundos |
| `src/infraestructure/services/ai/knowledge-base-loader.service.ts` | Modificar | Inyectar `@inject(CACHE_TOKEN.Manager) cacheManager: CacheManager`; reemplazar `this.cache` Map con `this.contentCache: CacheProvider`; actualizar `getContent`, `reload`, `getApproximateTokenCount` |
| `src/domain/interfaces/ports/knowledge-base-loader.port.ts` | Posiblemente modificar | Si `getApproximateTokenCount` cambia a async, actualizar firma del puerto |

**No** se requiere crear ningún archivo nuevo de infraestructura o dominio — toda la infraestructura de
caché ya existe.

---

## 11. Consideraciones de tests

### 11.1 — `BedrockAgentService` tests

Actualmente no hay tests que utilicen los Maps privados directamente (no son accesibles). Con la
migración:

```typescript
// Setup en test
const mockCache = {
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn().mockResolvedValue(undefined),
  forget: vi.fn().mockResolvedValue(undefined),
  has: vi.fn().mockResolvedValue(false),
  flush: vi.fn().mockResolvedValue(undefined),
  remember: vi.fn(),
} satisfies CacheProvider;

const service = new BedrockAgentService(mockCache);
```

Ahora el caché es **completamente reseteable** entre tests, sin `(service as any).sessionCache.clear()`.

### 11.2 — `KnowledgeBaseLoaderService` tests

```typescript
const arrayDriver = container.resolve<CacheProvider>(CACHE_TOKEN.Array);
const mockCacheManager = { store: vi.fn().mockReturnValue(arrayDriver) };
const service = new KnowledgeBaseLoaderService(mockRepo, mockCacheManager as any);
```

O inyectar el `ArrayCacheDriver` real para tests más integrales.

---

## 12. Configuración de entornos

### `.env.development`
```env
CACHE_DRIVER=array      # en memoria — no requiere Redis local
```

### `.env.production`
```env
CACHE_DRIVER=redis
REDIS_URL=redis://redis:6379
```

Al cambiar `CACHE_DRIVER=redis` en producción, **sin cambiar una línea de código** en los servicios,
`BedrockAgentService` pasa a persistir sesiones y respuestas en Redis automáticamente.

---

## 13. Riesgos y notas importantes

| Riesgo | Mitigación |
|---|---|
| **Cambio de unidad TTL (ms → s)** | El error más probable en la implementación. `SESSION_TTL` actual es `30 * 60 * 1000` = 1.800.000. Si se pasa tal cual a `put(key, val, 1800000)` el TTL será ~20 días. Revisar con tests unitarios que el TTL sea 1800 segundos |
| **`BedrockAgentService` constructor vacío → con inject** | El contenedor DI lo gestionará automáticamente. En tests que instancian `new BedrockAgentService()` directamente, hay que actualizar para pasar el mock del cache |
| **Redis no disponible en dev** | El driver `"array"` es el fallback. En CI/CD con `CACHE_DRIVER=array` no se necesita Redis |
| **`getSessionId` pasa de sync a async** | Todos los callers dentro de `BedrockAgentService` ya son async. El cambio es seguro pero hay que buscar todos los call sites dentro del servicio |
| **`getApproximateTokenCount` cambio de firma** | Si se elige Opción A, actualizar el puerto y todos los callers (probablemente solo `BedrockAIService` que usa `KnowledgeBaseLoaderService`) |

---

## 14. Acceptance criteria

- [ ] `BedrockAgentService` no tiene ningún `Map<>` privado relacionado con caché
- [ ] `BedrockAgentService` constructor tiene `@inject(DI.Cache) private readonly cache: CacheProvider`
- [ ] `getSessionId` (renombrado `getOrCreateSessionId`) retorna `Promise<string>` y usa `cache.get/put`
- [ ] TTLs en segundos: `SESSION_TTL_SECONDS = 1800`, `RESPONSE_CACHE_TTL_SECONDS = 300`
- [ ] `KnowledgeBaseLoaderService` no tiene el campo `cache: Map<string, CachedKB>`
- [ ] `KnowledgeBaseLoaderService.loadingPromises` sigue siendo `Map<string, Promise<void>>`
- [ ] `DI.Cache` registrado en `global-symbol.ts` y su factory en `container.ts`
- [ ] Al setear `CACHE_DRIVER=redis` + `REDIS_URL` la app arranca y usa Redis sin cambios de código
- [ ] Tests de `BedrockAgentService` usan mock de `CacheProvider` sin acceder a privados
- [ ] `npm run lint` sin errores
- [ ] `npm run test` pasa (actualizar tests que instancian `BedrockAgentService` directamente)
