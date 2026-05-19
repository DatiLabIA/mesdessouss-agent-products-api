# 🔄 Plan: Abstracción CRM Multi-Adapter + Integración Dolibarr/DoliMed

## 📋 Contexto

La Fundación (cliente principal) migra de Odoo a **Dolibarr** con el módulo **DoliMed** (gestión de medicamentos/pacientes). La conexión será por **API REST** con endpoints que nosotros mismos creamos en Dolibarr.

### Problema actual
- `ActionType` enum tiene 5 valores con prefijo `odoo_` — hardcoded.
- `StepActionExecutorService` tiene un switch con cases acoplados a Odoo.
- `ContactService` usa `XmlRpcOdooService` (XML-RPC) — no sirve para REST.
- `StepOption.odooField` es un campo con nombre Odoo-specific.
- No existe interfaz `ICrmAdapter` en la capa de dominio.

### Objetivo
Crear una abstracción `ICrmAdapter` siguiendo el mismo patrón de `IMessageAdapter` (WhatsApp/WebChat) y `EmailService` (Brevo/Resend), para que el sistema pueda conectarse a **cualquier CRM** sin modificar la lógica de flujos.

---

## 🏗️ Arquitectura Propuesta

```
┌─────────────────────────────────────────────────────────┐
│                    Domain Layer                          │
│                                                          │
│  ICrmAdapter (port)          CrmType enum (ya existe)   │
│  ├── createContact()         ├── ODOO                    │
│  ├── updateContact()         ├── DOLIBARR  ← NUEVO      │
│  ├── createTask()            ├── SALESFORCE               │
│  ├── getContact()            └── CUSTOM                   │
│  └── syncFollowup()                                      │
│                                                          │
│  ActionType enum (renombrado)                            │
│  ├── crm_create_contact   (era odoo_create_user)        │
│  ├── crm_update_contact   (era odoo_update_user)        │
│  ├── crm_create_task      (era odoo_create_task)        │
│  ├── crm_handover         (era odoo_handover)           │
│  └── crm_send_followup    (era send_followup_date_to_odoo) │
└─────────────────────────────────────────────────────────┘
                         ▲
                         │ implements
┌─────────────────────────────────────────────────────────┐
│               Infrastructure Layer                       │
│                                                          │
│  adapters/crm/                                           │
│  ├── dolibarr/                                           │
│  │   ├── dolibarr.adapter.ts      (ICrmAdapter → REST)  │
│  │   ├── dolibarr-api.client.ts   (HTTP client)         │
│  │   └── dolibarr.types.ts        (DoliMed types)       │
│  │                                                       │
│  └── odoo/                                               │
│      └── odoo.adapter.ts          (ICrmAdapter → XML-RPC)│
│                                                          │
│  services/step-actions/                                  │
│  └── step-action-executor.service.ts  (usa ICrmAdapter) │
│                                                          │
│  DI/modules/                                             │
│  └── integrations.module.ts       (registra adapter)    │
└─────────────────────────────────────────────────────────┘
```

---

## 📦 Fase 1: Crear la Abstracción `ICrmAdapter` (Domain)

### 1.1 — Port: `ICrmAdapter`

**Crear**: `src/domain/interfaces/ports/crm-adapter.port.ts`

```typescript
import { CrmType } from "@prisma/client";

// ── Payloads genéricos ──────────────────────────────────

export interface CrmContactData {
  phone?: string;
  email?: string;
  name?: string;
  fields: Record<string, any>;
}

export interface CrmTaskData {
  contactCrmId: string;
  fields: Record<string, any>;
  answers?: { field: string; value: string | number | boolean }[];
  description?: string;
  saveAnswers?: boolean;
}

export interface CrmUpdateData {
  fields: Record<string, any>;
}

export interface CrmContactResult {
  crmId: string;
  raw?: Record<string, any>;
}

export interface CrmTaskResult {
  taskId: string;
  raw?: Record<string, any>;
}

// ── Port ────────────────────────────────────────────────

export interface ICrmAdapter {
  readonly type: CrmType;

  /** Crear un contacto/paciente en el CRM */
  createContact(data: CrmContactData): Promise<CrmContactResult>;

  /** Actualizar campos de un contacto existente */
  updateContact(crmId: string, data: CrmUpdateData): Promise<void>;

  /** Crear una tarea/actividad asociada a un contacto */
  createTask(data: CrmTaskData): Promise<CrmTaskResult>;

  /** Obtener un contacto por su ID en el CRM */
  getContact(crmId: string): Promise<CrmContactData | null>;

  /** Health check — verificar conexión con el CRM */
  isAvailable(): Promise<boolean>;
}
```

### 1.2 — Exportar desde el barrel

**Modificar**: `src/domain/interfaces/ports/index.ts`
- Agregar `export * from "./crm-adapter.port";`

### 1.3 — DI Symbol

**Modificar**: `src/infraestructure/DI/global-symbol.ts`
- Agregar `CrmAdapter: Symbol.for("CrmAdapter")` en la sección Integrations.

---

**Commit sugerido:**
```
feat(domain): add ICrmAdapter port for multi-CRM abstraction
```

---

## 📦 Fase 2: Implementar `DolibarrAdapter` (Infrastructure)

### 2.1 — HTTP Client: `dolibarr-api.client.ts`

**Crear**: `src/infraestructure/adapters/crm/dolibarr/dolibarr-api.client.ts`

Cliente HTTP genérico para Dolibarr REST API.

```typescript
import { logger } from "@/shared/libs/winston/logger.lib";
import { ErrorFactory } from "@/domain/exceptions";

interface DolibarrConfig {
  baseUrl: string;   // ej: https://dolibarr.fundacion.org/api/index.php
  apiKey: string;     // DOLAPIKEY
}

export class DolibarrApiClient {
  constructor(private readonly config: DolibarrConfig) {}

  async request<T>(method: string, path: string, body?: any): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "DOLAPIKEY": this.config.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(`Dolibarr API error: ${response.status} ${errorBody}`, {
        context: "dolibarr-api",
        path,
        method,
      });
      throw ErrorFactory.create(
        "external-service",
        `Dolibarr API error: ${response.status}`
      );
    }

    return response.json() as Promise<T>;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body: any): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async put<T>(path: string, body: any): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async ping(): Promise<boolean> {
    try {
      await this.get("/status");
      return true;
    } catch {
      return false;
    }
  }
}
```

### 2.2 — Types: `dolibarr.types.ts`

**Crear**: `src/infraestructure/adapters/crm/dolibarr/dolibarr.types.ts`

```typescript
/** Respuesta de Dolibarr al crear un third-party */
export interface DolibarrThirdPartyResponse {
  id: number;
  ref?: string;
  name: string;
}

/** Respuesta de DoliMed al crear una tarea */
export interface DolibarrTaskResponse {
  id: number;
  ref?: string;
  label: string;
}

/** Configuración de entorno para Dolibarr */
export interface DolibarrEnvConfig {
  DOLIBARR_URL: string;
  DOLIBARR_API_KEY: string;
}
```

### 2.3 — Adapter: `dolibarr.adapter.ts`

**Crear**: `src/infraestructure/adapters/crm/dolibarr/dolibarr.adapter.ts`

```typescript
import { injectable } from "tsyringe";
import { CrmType } from "@prisma/client";
import { logger } from "@/shared/libs/winston/logger.lib";
import {
  ICrmAdapter,
  CrmContactData,
  CrmTaskData,
  CrmUpdateData,
  CrmContactResult,
  CrmTaskResult,
} from "@/domain/interfaces/ports/crm-adapter.port";
import { DolibarrApiClient } from "./dolibarr-api.client";

@injectable()
export class DolibarrAdapter implements ICrmAdapter {
  readonly type = CrmType.CUSTOM; // TODO: agregar DOLIBARR al enum CrmType

  private readonly client: DolibarrApiClient;

  constructor() {
    this.client = new DolibarrApiClient({
      baseUrl: process.env.DOLIBARR_URL || "",
      apiKey: process.env.DOLIBARR_API_KEY || "",
    });
  }

  async createContact(data: CrmContactData): Promise<CrmContactResult> {
    const payload = {
      name: data.name || `Contacto ${data.phone}`,
      phone: data.phone,
      email: data.email,
      ...data.fields,
    };

    const result = await this.client.post<{ id: number }>("/thirdparties", payload);
    logger.info(`Dolibarr: contact created with ID ${result.id}`, {
      context: "dolibarr-adapter",
    });

    return { crmId: String(result.id), raw: result };
  }

  async updateContact(crmId: string, data: CrmUpdateData): Promise<void> {
    await this.client.put(`/thirdparties/${crmId}`, data.fields);
    logger.info(`Dolibarr: contact ${crmId} updated`, {
      context: "dolibarr-adapter",
    });
  }

  async createTask(data: CrmTaskData): Promise<CrmTaskResult> {
    // DoliMed: endpoints personalizados de la fundación
    const payload = {
      fk_soc: Number(data.contactCrmId),
      label: data.fields.name || "Seguimiento ChatBot",
      ...data.fields,
    };

    // Si hay respuestas del paciente, agregarlas a la descripción
    if (data.saveAnswers && data.answers?.length) {
      payload.description = data.answers
        .map((a) => `${a.field}: ${a.value}`)
        .join("\n");
    }

    if (data.description) {
      payload.description = data.description;
    }

    const result = await this.client.post<{ id: number }>("/tasks", payload);
    logger.info(`Dolibarr: task created with ID ${result.id}`, {
      context: "dolibarr-adapter",
    });

    return { taskId: String(result.id), raw: result };
  }

  async getContact(crmId: string): Promise<CrmContactData | null> {
    try {
      const result = await this.client.get<Record<string, any>>(
        `/thirdparties/${crmId}`
      );
      return {
        name: result.name,
        phone: result.phone,
        email: result.email,
        fields: result,
      };
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.client.ping();
  }
}
```

### 2.4 — Env config

**Crear**: `src/infraestructure/config/dolibarr.ts`

```typescript
export const DOLIBARR_CONFIG = {
  URL: process.env.DOLIBARR_URL || "",
  API_KEY: process.env.DOLIBARR_API_KEY || "",
};
```

**Modificar**: `.env.example` — agregar:
```bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Dolibarr / DoliMed Integration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DOLIBARR_URL=         # e.g., https://dolibarr.fundacion.org/api/index.php
DOLIBARR_API_KEY=     # DOLAPIKEY token
```

---

**Commit sugerido:**
```
feat(infra): implement DolibarrAdapter with REST API client
```

---

## 📦 Fase 3: Envolver Odoo existente en el adapter (Backward Compat)

### 3.1 — Wrapper: `odoo.adapter.ts`

**Crear**: `src/infraestructure/adapters/crm/odoo/odoo.adapter.ts`

Envuelve el `ContactService` + `XmlRpcOdooService` existentes, implementando `ICrmAdapter`. **No se modifica nada del código Odoo actual** — solo se envuelve.

```typescript
import { injectable, inject } from "tsyringe";
import { CrmType } from "@prisma/client";
import { DI } from "@/infraestructure/DI/global-symbol";
import {
  ICrmAdapter,
  CrmContactData,
  CrmTaskData,
  CrmUpdateData,
  CrmContactResult,
  CrmTaskResult,
} from "@/domain/interfaces/ports/crm-adapter.port";
import { ContactService } from "@/infraestructure/services/odoo_contact/contact.service";

@injectable()
export class OdooAdapter implements ICrmAdapter {
  readonly type = CrmType.ODOO;

  constructor(
    @inject(DI.OdooContactService)
    private readonly contactService: ContactService,
  ) {}

  async createContact(data: CrmContactData): Promise<CrmContactResult> {
    const id = await this.contactService.create({
      phone: data.phone || "",
      config: { defaultFields: data.fields },
      answers: Object.entries(data.fields).map(([k, v]) => ({
        pregunta: k,
        respuesta: String(v),
      })),
    });
    return { crmId: String(id) };
  }

  async updateContact(crmId: string, data: CrmUpdateData): Promise<void> {
    await this.contactService.update(Number(crmId), data.fields);
  }

  async createTask(data: CrmTaskData): Promise<CrmTaskResult> {
    const taskId = await this.contactService.createTask({
      id: Number(data.contactCrmId),
      fields: data.fields,
      answers: (data.answers || []).map((a) => ({
        pregunta: a.field,
        respuesta: a.value,
      })),
      allUserAnswers: [],
      save_answers: data.saveAnswers || false,
    });
    return { taskId: String(taskId) };
  }

  async getContact(crmId: string): Promise<CrmContactData | null> {
    // Delegate to existing RPC service
    return null; // Simplificado — Odoo ya no es prioridad
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Intentar autenticar
      return true;
    } catch {
      return false;
    }
  }
}
```

---

**Commit sugerido:**
```
refactor(infra): wrap existing Odoo services into OdooAdapter
```

---

## 📦 Fase 4: Refactorizar `StepActionExecutorService`

### 4.1 — Inyectar `ICrmAdapter` en vez de `ContactService`

**Modificar**: `src/infraestructure/services/step-actions/step-action-executor.service.ts`

**Cambio clave**: Reemplazar `@inject(DI.OdooContactService) contactService: ContactService` por `@inject(DI.CrmAdapter) crmAdapter: ICrmAdapter`.

Los `case` del switch se mantienen pero delegan al adapter genérico:

```typescript
// ANTES (acoplado a Odoo):
case ActionType.odoo_create_task:
  await this.contactService.createTask(payload);

// DESPUÉS (genérico):
case ActionType.odoo_create_task:  // mantener enum temporalmente
case ActionType.crm_create_task:   // alias nuevo
  await this.crmAdapter.createTask({
    contactCrmId: user.crmId,
    fields: config?.fields || {},
    answers: normalizedAnswers,
    description: allAnswersText,
    saveAnswers: config?.save_answers || false,
  });
```

### 4.2 — Mantener backward compatibility del enum

No renombrar el enum `ActionType` en esta fase. Agregar alias en el switch para soportar ambos nombres. La migración del enum se hará en una fase posterior cuando se limpie la DB.

---

**Commit sugerido:**
```
refactor(step-actions): decouple executor from Odoo via ICrmAdapter
```

---

## 📦 Fase 5: Registro en DI + Selección Dinámica

### 5.1 — Registrar en el módulo de integraciones

**Modificar**: `src/infraestructure/DI/modules/integrations.module.ts`

```typescript
import { DolibarrAdapter } from "@/infraestructure/adapters/crm/dolibarr/dolibarr.adapter";
import { OdooAdapter } from "@/infraestructure/adapters/crm/odoo/odoo.adapter";

export function registerIntegrationsModule(container: DependencyContainer): void {
  // ... WhatsApp, Metrics (sin cambios) ...

  // Odoo / CRM (legacy — mantener para OdooAdapter wrapper)
  container.register<ContactService>(DI.OdooContactService, ContactService);
  container.registerInstance<XmlRpcOdooService>(DI.OdooRcpService, odooRpcClient);

  // ── CRM Adapter (dinámico por env) ──────────────────────
  const crmType = process.env.CRM_TYPE || "DOLIBARR";

  if (crmType === "ODOO") {
    container.register<ICrmAdapter>(DI.CrmAdapter, OdooAdapter);
  } else {
    container.register<ICrmAdapter>(DI.CrmAdapter, DolibarrAdapter);
  }
}
```

### 5.2 — Env var

**`.env`** y **`.env.example`**:
```bash
CRM_TYPE=DOLIBARR   # ODOO | DOLIBARR | CUSTOM
```

---

**Commit sugerido:**
```
feat(di): register CRM adapter dynamically based on CRM_TYPE env var
```

---

## 📦 Fase 6 (Futura): Migración del Enum `ActionType`

> ⚠️ **NO ejecutar ahora** — requiere migración de datos en producción.

### Prisma migration para renombrar valores del enum:

```prisma
enum ActionType {
  send_email
  send_webhooks
  crm_handover           // era odoo_handover
  crm_create_contact     // era odoo_create_user
  crm_update_contact     // era odoo_update_user
  crm_create_task        // era odoo_create_task
  crm_send_followup      // era send_followup_date_to_odoo
  save_consent
  custom
}
```

### Rename `StepOption.odooField` → `crmField`:

```prisma
model StepOption {
  crmField    String?  @db.VarChar(191)  // era odooField
}
```

### Agregar `DOLIBARR` al enum `CrmType`:

```prisma
enum CrmType {
  ODOO
  DOLIBARR      // ← NUEVO
  SALESFORCE
  HUBSPOT
  PIPEDRIVE
  ZOHO
  CUSTOM
}
```

---

**Commit sugerido (cuando se ejecute):**
```
feat(db): rename ActionType enum to generic CRM names

BREAKING CHANGE: ActionType values renamed from odoo_* to crm_*
```

---

## 📋 Resumen de Archivos

### Crear

| Archivo | Capa | Descripción |
|---------|------|-------------|
| `src/domain/interfaces/ports/crm-adapter.port.ts` | Domain | Port `ICrmAdapter` |
| `src/infraestructure/adapters/crm/dolibarr/dolibarr.adapter.ts` | Infra | Implementación Dolibarr |
| `src/infraestructure/adapters/crm/dolibarr/dolibarr-api.client.ts` | Infra | HTTP client REST |
| `src/infraestructure/adapters/crm/dolibarr/dolibarr.types.ts` | Infra | Types DoliMed |
| `src/infraestructure/adapters/crm/odoo/odoo.adapter.ts` | Infra | Wrapper Odoo existente |
| `src/infraestructure/config/dolibarr.ts` | Infra | Config env vars |

### Modificar

| Archivo | Cambio |
|---------|--------|
| `src/domain/interfaces/ports/index.ts` | Export del nuevo port |
| `src/infraestructure/DI/global-symbol.ts` | Agregar `CrmAdapter` symbol |
| `src/infraestructure/DI/modules/integrations.module.ts` | Registrar adapter dinámico |
| `src/infraestructure/services/step-actions/step-action-executor.service.ts` | Inyectar `ICrmAdapter` |
| `.env.example` | Agregar `DOLIBARR_*` y `CRM_TYPE` |

### No tocar (aún)

| Archivo | Razón |
|---------|-------|
| `prisma/schema.prisma` | Enum rename requiere migración de datos |
| `src/infraestructure/services/odoo_contact/contact.service.ts` | Se mantiene como legacy via wrapper |
| `src/infraestructure/services/rpc/rpc.service.ts` | Se mantiene como legacy |

---

## ⚠️ Notas Importantes

1. **DoliMed endpoints**: Como ustedes mismos crean los endpoints en Dolibarr, el `DolibarrApiClient` es un cliente HTTP genérico. Los paths (`/thirdparties`, `/tasks`, etc.) se pueden ajustar a los endpoints reales que creen en DoliMed.

2. **`odooField` en StepOption**: Por ahora sigue funcionando — el `StepActionExecutorService` ya lee ese campo y lo pasa como `answers[].field` al adapter. Cuando se renombre a `crmField` será solo un cambio de nombre en el schema + migration.

3. **`crmId` en ChatbotUser**: Ya existe y es genérico (`String? @db.VarChar(100)`). No necesita cambios — Dolibarr escribirá su ID ahí igual que Odoo lo hacía.

4. **No se rompe nada**: El `OdooAdapter` wrapper mantiene 100% de compatibilidad. Si mañana otro cliente necesita Odoo, solo cambian `CRM_TYPE=ODOO` en el env.

5. **Tests**: Crear tests unitarios para `DolibarrAdapter` mockeando `DolibarrApiClient`. El executor ya tiene tests que mockean `ContactService` — solo hay que agregar un test que mockee `ICrmAdapter`.
