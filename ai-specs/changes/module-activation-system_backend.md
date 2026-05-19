# 🧩 Plan: Sistema de Módulos Activables por Cliente

## 📋 Contexto

Actualmente DatiHub es **single-tenant**: toda la configuración es global vía env vars, todos los módulos DI se cargan siempre, y todas las rutas se montan incondicionalmente. No existe concepto de "organización" ni de activación selectiva de features.

**Necesidad**: Que cada despliegue (y en el futuro cada tenant) pueda decidir qué módulos tiene activos. Ejemplo: la Fundación usa `crm` (Dolibarr), `flows`, `adverse-events`, `notifications` pero NO usa `knowledge-base` ni `bedrock-agent`.

### Estado actual del boot

```
container.ts → registra 23 módulos DI en orden fijo, todos siempre
routes/index.ts → monta 22 rutas, todas siempre
```

---

## 🏗️ Arquitectura Propuesta

### Enfoque: Module Registry con Config Declarativa

En lugar de un sistema de feature flags complejo con base de datos, proponemos un enfoque **config-driven** que es pragmático para la etapa actual (single-tenant) y extensible para multi-tenant futuro.

```
┌─────────────────────────────────────────────────────────┐
│                     modules.config.ts                    │
│                                                          │
│  Declaración de módulos disponibles:                     │
│  {                                                       │
│    core:           { always: true },                     │
│    auth:           { always: true },                     │
│    flows:          { default: true },                    │
│    crm:            { default: false, requires: [] },     │
│    ai:             { default: false, requires: ["flows"] │
│    knowledge-base: { default: false, requires: ["ai"] }, │
│    adverse-events: { default: false },                   │
│    ...                                                   │
│  }                                                       │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                  ModuleRegistry                          │
│                                                          │
│  - Lee la config + env var ENABLED_MODULES               │
│  - Resuelve dependencias entre módulos                   │
│  - Expone: isEnabled(moduleName): boolean                │
│  - Expone: getEnabledModules(): string[]                 │
│                                                          │
│  Consumido por:                                          │
│  ├── container.ts  → registro DI condicional             │
│  └── routes/index.ts → montaje de rutas condicional      │
└─────────────────────────────────────────────────────────┘
```

### Env var de activación

```bash
# Todos los módulos habilitados (default):
ENABLED_MODULES=all

# Solo módulos específicos:
ENABLED_MODULES=flows,crm,adverse-events,notifications

# El registry añade automáticamente las dependencias requeridas
# (core, auth, persistence, etc. siempre se cargan)
```

---

## 📦 Fase 1: Definir el Module Registry (Shared)

### 1.1 — Definición de módulos: `modules.config.ts`

**Crear**: `src/shared/config/modules.config.ts`

```typescript
/**
 * Catálogo de módulos del sistema.
 *
 * - always: se carga siempre, sin importar la config (infraestructura base).
 * - default: se carga cuando ENABLED_MODULES="all" o no se especifica.
 * - requires: otros módulos que deben estar activos para que este funcione.
 * - diRegister: nombre de la función de registro DI.
 * - routePrefix: path de la ruta HTTP (null = sin rutas).
 */

export interface ModuleDefinition {
  /** Se carga siempre — no se puede desactivar */
  always?: boolean;
  /** Se carga por defecto cuando no se especifica ENABLED_MODULES */
  default?: boolean;
  /** Módulos requeridos — se activan automáticamente si este está activo */
  requires?: string[];
  /** Descripción legible */
  description: string;
}

export const MODULE_CATALOG: Record<string, ModuleDefinition> = {
  // ── Infraestructura base (siempre activos) ──────────────
  core:          { always: true, description: "Core utilities, ID service, health checks" },
  persistence:   { always: true, description: "Prisma repositories & database layer" },
  cache:         { always: true, description: "Redis cache layer" },
  storage:       { always: true, description: "File storage (S3/local)" },
  bus:           { always: true, description: "Command & Query bus (CQRS)" },
  "event-bus":   { always: true, description: "Event bus (PGMQ/InMemory)" },
  auth:          { always: true, description: "JWT authentication & sessions" },
  http:          { always: true, description: "Express HTTP layer, controllers" },

  // ── Módulos de negocio (activables) ─────────────────────
  flows:             { default: true,  description: "Flow engine & step management" },
  messaging:         { default: true,  requires: ["flows"], description: "Multi-channel messaging (WhatsApp, WebChat)" },
  notifications:     { default: true,  description: "Email notifications (Brevo)" },
  integrations:      { default: true,  description: "External integrations hub (WhatsApp API, CRM bridge)" },
  "step-actions":    { default: true,  requires: ["flows"], description: "Step action executor (CRM, email, webhook triggers)" },
  "step-options":    { default: true,  requires: ["flows"], description: "Step option management" },
  conversations:     { default: true,  requires: ["flows", "messaging"], description: "Conversation history & queries" },
  tags:              { default: false, description: "User & flow tagging system" },
  "auto-responses":  { default: false, description: "Auto-response templates" },
  tasks:             { default: false, description: "Scheduled jobs & cron tasks" },

  // ── Módulos avanzados ───────────────────────────────────
  crm:               { default: false, requires: ["integrations"], description: "CRM adapter (Odoo, Dolibarr)" },
  "crm-fields":      { default: false, requires: ["crm"], description: "CRM field mapping management" },
  ai:                { default: false, requires: ["flows"], description: "AI/LLM response generation (Bedrock, Claude)" },
  "knowledge-base":  { default: false, requires: ["ai"], description: "Knowledge base & RAG" },
  "bedrock-agent":   { default: false, requires: ["ai"], description: "AWS Bedrock Agent management" },
  "adverse-events":  { default: false, requires: ["flows"], description: "Adverse event keyword detection" },
  metrics:           { default: true,  requires: ["flows"], description: "Flow analytics & metrics" },
  handoff:           { default: false, requires: ["messaging"], description: "Human agent handoff" },
};
```

### 1.2 — Module Registry service: `module-registry.ts`

**Crear**: `src/shared/config/module-registry.ts`

```typescript
import { MODULE_CATALOG, ModuleDefinition } from "./modules.config";
import { logger } from "@/shared/libs/winston/logger.lib";

export class ModuleRegistry {
  private static enabled = new Set<string>();
  private static initialized = false;

  /**
   * Inicializa el registry leyendo ENABLED_MODULES del env.
   * Se llama UNA vez al arrancar antes del DI container.
   */
  static initialize(): void {
    if (this.initialized) return;

    const envModules = process.env.ENABLED_MODULES?.trim() || "all";

    // 1. Cargar módulos "always"
    for (const [name, def] of Object.entries(MODULE_CATALOG)) {
      if (def.always) this.enabled.add(name);
    }

    // 2. Cargar módulos según env
    if (envModules === "all") {
      // Activar todos los que tengan default: true
      for (const [name, def] of Object.entries(MODULE_CATALOG)) {
        if (def.default || def.always) this.enabled.add(name);
      }
    } else {
      // Activar solo los explícitos
      const requested = envModules.split(",").map((m) => m.trim());
      for (const name of requested) {
        if (!MODULE_CATALOG[name]) {
          logger.warn(`Unknown module "${name}" in ENABLED_MODULES — skipping`, {
            context: "module-registry",
          });
          continue;
        }
        this.enabled.add(name);
      }
    }

    // 3. Resolver dependencias (transitivas)
    let changed = true;
    while (changed) {
      changed = false;
      for (const name of this.enabled) {
        const def = MODULE_CATALOG[name];
        if (!def?.requires) continue;
        for (const dep of def.requires) {
          if (!this.enabled.has(dep)) {
            this.enabled.add(dep);
            changed = true;
            logger.info(`Module "${dep}" auto-enabled (required by "${name}")`, {
              context: "module-registry",
            });
          }
        }
      }
    }

    this.initialized = true;

    logger.info(`Modules enabled: [${[...this.enabled].sort().join(", ")}]`, {
      context: "module-registry",
    });
  }

  /** ¿Está activo este módulo? */
  static isEnabled(moduleName: string): boolean {
    return this.enabled.has(moduleName);
  }

  /** Lista de módulos activos */
  static getEnabled(): string[] {
    return [...this.enabled].sort();
  }

  /** Reset (para tests) */
  static reset(): void {
    this.enabled.clear();
    this.initialized = false;
  }
}
```

---

**Commit sugerido:**
```
feat(core): add ModuleRegistry with declarative module catalog
```

---

## 📦 Fase 2: Registro DI Condicional

### 2.1 — Modificar `container.ts`

**Modificar**: `src/infraestructure/DI/container.ts`

Usar `ModuleRegistry.isEnabled()` para registrar condicionalmente:

```typescript
import { container } from "tsyringe";
import { ModuleRegistry } from "@/shared/config/module-registry";

// Inicializar registry ANTES del DI
ModuleRegistry.initialize();

// ── Always-on (infraestructura base) ────────────────────
registerCoreModule(container);
registerPersistenceModule(container);
registerCacheModule(container);
registerStorageModule(container);
registerBusModule(container);
registerEventBusModule(container);
registerAuthModule(container);
registerHttpModule(container);

// ── Condicionales ───────────────────────────────────────
if (ModuleRegistry.isEnabled("notifications"))  registerNotificationsModule(container);
if (ModuleRegistry.isEnabled("integrations"))    registerIntegrationsModule(container);
if (ModuleRegistry.isEnabled("flows"))           registerFlowModule(container);
if (ModuleRegistry.isEnabled("messaging"))       registerMessagingModule(container);
if (ModuleRegistry.isEnabled("ai"))              registerAIModule(container);
if (ModuleRegistry.isEnabled("knowledge-base"))  registerKnowledgeBaseModule(container);
if (ModuleRegistry.isEnabled("bedrock-agent"))   registerBedrockAgentModule(container);
if (ModuleRegistry.isEnabled("adverse-events"))  registerAdverseEventsModule(container);
if (ModuleRegistry.isEnabled("step-actions"))    registerStepActionsModule(container);
if (ModuleRegistry.isEnabled("step-options"))    registerStepOptionModule(container);
if (ModuleRegistry.isEnabled("tasks"))           registerTaskModule(container);
if (ModuleRegistry.isEnabled("tags"))            registerTagModule(container);
if (ModuleRegistry.isEnabled("auto-responses"))  registerAutoResponseModule(container);
if (ModuleRegistry.isEnabled("crm-fields"))      registerOdooFieldModule(container);
if (ModuleRegistry.isEnabled("conversations"))   registerConversationModule(container);

export { container };
```

### 2.2 — Modificar `routes/index.ts`

**Modificar**: `src/infraestructure/http/routes/index.ts`

```typescript
import { ModuleRegistry } from "@/shared/config/module-registry";

export class AppRoute {
  static get routes(): Router {
    const router = Router();

    // Always-on
    router.use("/auth", new AuthRoute().routes);
    router.use("/health", new HealthRoute().routes);

    // Condicionales
    if (ModuleRegistry.isEnabled("flows"))           router.use("/flows", new FlowRoute().routes);
    if (ModuleRegistry.isEnabled("crm"))             router.use("/odoo", new OdooRoute().routes);
    if (ModuleRegistry.isEnabled("messaging"))        router.use("/whatsapp", new WhatsappRoute().routes);
    if (ModuleRegistry.isEnabled("adverse-events"))   router.use("/adverse-keywords", new AdverseRoute().routes);
    if (ModuleRegistry.isEnabled("step-actions"))     router.use("/step-actions", new StepActionsRoute().routes);
    if (ModuleRegistry.isEnabled("messaging"))        router.use("/webchat", new WebChatRoute().routes);
    if (ModuleRegistry.isEnabled("messaging"))        router.use("/webhooks", new WebhookRoute().routes);
    if (ModuleRegistry.isEnabled("knowledge-base"))   router.use("/knowledge-bases", new KnowledgeBaseRoute().routes);
    if (ModuleRegistry.isEnabled("bedrock-agent"))    router.use("/agents", new BedrockAgentRoute().routes);
    if (ModuleRegistry.isEnabled("metrics"))          router.use("/metrics", new MetricsRoute().routes);
    if (ModuleRegistry.isEnabled("handoff"))          router.use("/handoff", new HandoffRoute().routes);
    if (ModuleRegistry.isEnabled("tasks"))            router.use("/tasks", new TaskRoute().routes);
    if (ModuleRegistry.isEnabled("step-options"))     router.use("/step-options", new StepOptionRoute().routes);
    if (ModuleRegistry.isEnabled("tags"))             router.use("/tags", new TagRoute().routes);
    if (ModuleRegistry.isEnabled("auto-responses"))   router.use("/auto-responses", new AutoResponseRoute().routes);
    if (ModuleRegistry.isEnabled("crm-fields"))       router.use("/odoo-fields", new OdooFieldRoute().routes);
    if (ModuleRegistry.isEnabled("conversations"))    router.use("/conversations", new ConversationRoute().routes);

    // Users / upload (siempre — es parte del core admin)
    router.use("/users", new UploadUserRoute().routes);

    return router;
  }
}
```

**Nota de imports**: Los imports que no se usan (porque el módulo está desactivado) no causan error en runtime porque TypeScript compila las clases igualmente. Si en el futuro se quiere lazy-loading, se puede cambiar a `import()` dinámico.

---

**Commit sugerido:**
```
feat(di): conditional module registration via ModuleRegistry
```

---

## 📦 Fase 3: Endpoint de introspección (opcional pero útil)

### 3.1 — Endpoint `GET /api/health/modules`

**Modificar**: El `HealthController` existente (o crear uno ligero) para exponer los módulos activos:

```typescript
// En el health controller
async getModules(req: Request, res: Response) {
  const modules = ModuleRegistry.getEnabled();
  return ResponseBuilder.sendSuccess(res, {
    enabledModules: modules,
    total: modules.length,
  });
}
```

Esto permite al frontend saber qué secciones del dashboard mostrar.

---

**Commit sugerido:**
```
feat(api): add GET /health/modules for module introspection
```

---

## 📦 Fase 4 (Futura): Modelo `Organization` + activación per-tenant

> ⚠️ **NO implementar ahora** — requiere refactoring de toda la capa de datos.

Cuando se necesite multi-tenancy real:

```prisma
model Organization {
  id             String   @id @default(uuid())
  name           String   @unique
  slug           String   @unique
  enabledModules String[] // ["flows", "crm", "ai", "adverse-events"]
  crmType        CrmType?
  crmConfig      Json?    // Credenciales CRM por org
  whatsappConfig Json?    // Número WA por org
  users          User[]
  chatbotUsers   ChatbotUser[]
  flows          Flow[]
}
```

El `ModuleRegistry` pasaría de leer env vars a leer la config de la org:

```typescript
// Futuro: per-request module check
static isEnabledForOrg(moduleName: string, orgId: string): boolean {
  const org = await orgRepo.findById(orgId);
  return org.enabledModules.includes(moduleName);
}
```

---

## 📋 Resumen de Archivos

### Crear

| Archivo | Capa | Descripción |
|---------|------|-------------|
| `src/shared/config/modules.config.ts` | Shared | Catálogo declarativo de módulos |
| `src/shared/config/module-registry.ts` | Shared | Registry singleton con resolución de dependencias |

### Modificar

| Archivo | Cambio |
|---------|--------|
| `src/infraestructure/DI/container.ts` | Registro condicional con `ModuleRegistry.isEnabled()` |
| `src/infraestructure/http/routes/index.ts` | Montaje de rutas condicional |
| `.env.example` | Agregar `ENABLED_MODULES` |
| Health controller | Endpoint `/health/modules` |

### No tocar

| Archivo | Razón |
|---------|-------|
| `prisma/schema.prisma` | No se necesita modelo nuevo para esta fase |
| DI modules individuales | Cada módulo sigue registrándose igual internamente |
| Controllers/Routes individuales | No necesitan saber si están activos o no |

---

## ⚠️ Notas Importantes

1. **Los módulos `always: true` no se pueden desactivar**: core, persistence, cache, storage, bus, event-bus, auth, http. Son la infraestructura base.

2. **Resolución de dependencias**: Si activas `knowledge-base`, automáticamente se activan `ai` y `flows`. No necesitas declararlos manualmente.

3. **Ejemplo para la Fundación**:
   ```bash
   ENABLED_MODULES=flows,messaging,crm,adverse-events,notifications,step-actions,step-options,conversations,metrics
   ```
   Esto NO carga: ai, knowledge-base, bedrock-agent, tags, auto-responses, tasks, handoff.

4. **El test router** (`/test`) se puede dejar siempre activo en dev y excluirlo en producción via `NODE_ENV`.

5. **El frontend puede usar `/health/modules`** para mostrar/ocultar secciones del dashboard dinámicamente.

6. **No se necesita Prisma migration** — todo es configuración en código + env.

7. **Backward compatible**: Con `ENABLED_MODULES=all` (default) se comporta exactamente como ahora.
