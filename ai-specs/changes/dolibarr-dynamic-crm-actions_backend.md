# Plan: Integración Dinámica Dolibarr vía Flow Actions

**Ticket**: Configuración dinámica de acciones CRM en flujos conversacionales  
**Scope**: Adaptar `DolibarrAdapter` + `StepActionConfig` para que los flujos puedan crear/actualizar datos en cualquier API REST de Dolibarr.

---

## 1. Diagnóstico: Estado Actual vs. Necesidad

### Lo que YA funciona
| Componente | Estado | Descripción |
|---|---|---|
| `ICrmAdapter` | ✅ | Puerto genérico con `createContact`, `updateContact`, `createTask`, `getContact` |
| `DolibarrAdapter` | ⚠️ Parcial | Apunta a endpoints genéricos (`/thirdparties`, `/tasks`) que NO coinciden con la API RCV |
| `DolibarrApiClient` | ✅ | Cliente HTTP con `DOLAPIKEY` — funcional y reutilizable |
| `StepActionExecutor` | ✅ | Dispatcher que ejecuta la acción configurada en `FlowStep.actionType` |
| `StepActionConfig` | ✅ | Modelo con campo `config: Json` para almacenar configuración por acción |
| `crmField` en `StepOption` | ✅ | Mapea la respuesta del usuario a un campo del CRM |
| `FlowStep.actionType` | ✅ | Dispara la ejecución de la acción al llegar al step |

### El GAP
1. **Endpoints incorrectos**: `DolibarrAdapter` usa `/thirdparties` y `/tasks`, pero la API RCV usa `/rcvrest/patients/{id}` y `/rcvrest/consultations`.
2. **Sin flexibilidad de endpoint**: El adapter tiene rutas hardcoded. Cada setup de Dolibarr puede tener módulos distintos (ej. `rcvrest`, `dolimed`, etc.).
3. **No hay mapeo parametrizado de campos**: La lógica del mapeo está en código, no en la configuración JSON del `StepActionConfig`.

---

## 2. Solución Propuesta: CRM Action Config-Driven

### Principio
> **La configuración del `StepActionConfig.config` JSON define TODO**: endpoint, método HTTP, mapeo de campos, y campos estáticos. El adapter solo es un ejecutor HTTP genérico.

### Arquitectura

```
FlowStep (actionType: crm_create_task)
    │
    ├── actionConfigId ──► StepActionConfig.config (JSON)
    │                      {
    │                        "endpoint": "/rcvrest/consultations",
    │                        "method": "POST",
    │                        "staticFields": { "tipo_atencion": "gestion_whatsapp", "status": 0 },
    │                        "answerMapping": true,
    │                        "save_answers": true,
    │                        "customDataKey": "custom_data"
    │                      }
    │
    ├── crmField (en cada StepOption / input step)
    │   - stepSpecialty options → crmField: "tipo_atencion"
    │   - stepDate input → crmField: "date_start"
    │   - stepDocType options → crmField: "options_tipo_de_documento"
    │   - stepDocument input → crmField: "options_numero_identificacion"
    │   - stepName input → crmField: "nom"
    │   - stepPhone input → crmField: "options_celular"
    │   - stepEps options → crmField: "options_eps"
    │
    └── StepActionExecutor.execute()
        └── DolibarrAdapter.executeConfigAction(config, answers)
            └── DolibarrApiClient.post("/rcvrest/consultations", payload)
```

---

## 3. Cambios Necesarios

### 3.1 Evolucionar `ICrmAdapter` — Agregar operación genérica

**Archivo**: `src/domain/interfaces/ports/crm-adapter.port.ts`

```typescript
// ── Nuevo: Operación genérica config-driven ─────────────

export interface CrmActionConfig {
  endpoint: string;                           // "/rcvrest/consultations"
  method: "GET" | "POST" | "PUT" | "DELETE";  // HTTP method
  staticFields?: Record<string, unknown>;     // Campos fijos siempre enviados
  answerMapping?: boolean;                    // ¿Mapear respuestas del flujo a campos?
  save_answers?: boolean;                     // ¿Incluir dump de respuestas?
  customDataKey?: string;                     // Key para meter metadata (ej: "custom_data")
  contactIdField?: string;                    // Campo que lleva el crmId (ej: "fk_soc")
  contactIdSource?: "crm_id" | "static";     // De dónde saca el ID
}

export interface CrmGenericActionData {
  config: CrmActionConfig;
  contactCrmId?: string;
  answers?: { field: string; value: string | number | boolean }[];
  metadata?: Record<string, unknown>;         // conversationId, origen, etc.
}

export interface CrmGenericActionResult {
  responseId?: string;
  raw?: unknown;
}

// ── Port actualizado ────────────────────────────────────

export interface ICrmAdapter {
  readonly type: string;
  createContact(data: CrmContactData): Promise<CrmContactResult>;
  updateContact(crmId: string, data: CrmUpdateData): Promise<void>;
  createTask(data: CrmTaskData): Promise<CrmTaskResult>;
  getContact(crmId: string): Promise<CrmContactData | null>;
  isAvailable(): Promise<boolean>;

  /** NUEVO: Ejecuta una acción genérica basada en configuración JSON */
  executeAction(data: CrmGenericActionData): Promise<CrmGenericActionResult>;
}
```

**Commit**: `feat(crm): add executeAction to ICrmAdapter for config-driven operations`

---

### 3.2 Implementar en `DolibarrAdapter`

**Archivo**: `src/infraestructure/adapters/crm/dolibarr/dolibarr.adapter.ts`

```typescript
async executeAction(data: CrmGenericActionData): Promise<CrmGenericActionResult> {
  const { config, contactCrmId, answers, metadata } = data;

  // 1. Construir payload base con campos estáticos
  const payload: Record<string, unknown> = { ...(config.staticFields || {}) };

  // 2. Agregar ID del contacto si corresponde
  if (config.contactIdField && contactCrmId) {
    payload[config.contactIdField] = isNaN(Number(contactCrmId))
      ? contactCrmId
      : Number(contactCrmId);
  }

  // 3. Mapear respuestas del usuario a campos del CRM
  if (config.answerMapping && answers?.length) {
    for (const answer of answers) {
      // Soportar campos anidados: "array_options.options_eps" → payload.array_options.options_eps
      setNestedField(payload, answer.field, answer.value);
    }
  }

  // 4. Dump completo de respuestas en custom_data
  if (config.save_answers && answers?.length && config.customDataKey) {
    payload[config.customDataKey] = {
      ...(payload[config.customDataKey] as Record<string, unknown> || {}),
      origen: "chatbot",
      ...metadata,
      respuestas: answers,
    };
  }

  // 5. Ejecutar request HTTP
  const result = await this.client.request<unknown>(
    config.method,
    config.endpoint,
    config.method !== "GET" ? payload : undefined,
  );

  return {
    responseId: typeof result === "number" ? String(result) : undefined,
    raw: result,
  };
}
```

**Helper `setNestedField`** (en el mismo archivo o en un util):
```typescript
function setNestedField(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]] || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
```

**Commit**: `feat(crm): implement executeAction in DolibarrAdapter with config-driven payload`

---

### 3.3 Implementar stub en `OdooAdapter`

**Archivo**: `src/infraestructure/adapters/crm/odoo/odoo.adapter.ts`

```typescript
async executeAction(_data: CrmGenericActionData): Promise<CrmGenericActionResult> {
  logger.warn("executeAction not implemented for Odoo adapter", {
    context: "odoo-adapter",
  });
  return {};
}
```

**Commit**: Incluido en el commit anterior.

---

### 3.4 Agregar caso en `StepActionExecutorService`

**Archivo**: `src/infraestructure/services/step-actions/step-action-executor.service.ts`

En el `switch` de `execute()`, agregar soporte para que `crm_create_task` y `crm_update_contact` usen `executeAction` cuando el config tiene `endpoint`:

```typescript
case ActionType.crm_create_task:
case ActionType.crm_create_contact:
case ActionType.crm_handover: {
  const config = actionConfig?.config as any;
  if (config?.endpoint) {
    // Config-driven: usar executeAction genérico
    await this.executeConfigDrivenAction(step, context, config);
  } else {
    // Legacy: usar el flujo existente de createTask
    await this.executeOdooCreateTask(step, context, actionConfig);
  }
  break;
}

case ActionType.crm_update_contact: {
  const config = actionConfig?.config as any;
  if (config?.endpoint) {
    await this.executeConfigDrivenAction(step, context, config);
  } else {
    await this.executeOdooUpdateUser(step, context, actionConfig);
  }
  break;
}
```

Y el nuevo método privado:

```typescript
private async executeConfigDrivenAction(
  step: IFlowStep,
  context: ActionContext,
  config: CrmActionConfig,
): Promise<void> {
  const user = await this.getChatbotUser(context.channelUserId);

  // Recoger respuestas con crmField
  const conversation = await this.getConversationWithAnswers(context.conversationId);
  const answers = conversation?.userAnswers
    .map((answer) => {
      const stepData = answer.step as any;
      if (stepData?.crmField) {
        return { field: stepData.crmField, value: answer.answer };
      }
      const option = stepData?.options?.find(
        (opt: any) => opt.label === answer.answer || opt.value === answer.answer,
      );
      if (option?.crmField) {
        return { field: option.crmField, value: option.label };
      }
      return null;
    })
    .filter(Boolean) || [];

  const result = await this.crmAdapter.executeAction({
    config,
    contactCrmId: user?.crmId || undefined,
    answers,
    metadata: {
      conversationId: context.conversationId,
      channelUserId: context.channelUserId,
    },
  });

  // Log de ejecución
  await prisma.flowExecutionLog.create({
    data: {
      conversationId: context.conversationId,
      stepId: step.id,
      messageType: "action",
      content: `${config.method} ${config.endpoint} → ${result.responseId || "ok"}`,
    },
  });

  logger.info(
    `Config-driven action executed: ${config.method} ${config.endpoint}`,
    { context: "step-action-executor", responseId: result.responseId },
  );
}
```

**Commit**: `feat(actions): add config-driven CRM action execution in StepActionExecutor`

---

### 3.5 Actualizar el Seeder con Actions y crmField

**Archivo**: `prisma/seeders/demos/fundacion/fundacion-appointment.seeder.ts`

#### a) Crear `StepActionConfig` para crear consulta en Dolibarr

```typescript
const actionCreateConsultation = await this.prisma.stepActionConfig.create({
  data: {
    name: "dolibarr-create-consultation-rcv",
    type: "crm_create_task",
    isActive: true,
    config: {
      endpoint: "/rcvrest/consultations",
      method: "POST",
      contactIdField: "fk_soc",
      contactIdSource: "crm_id",
      staticFields: {
        tipo_atencion: "gestion_whatsapp",
        status: 0,
      },
      answerMapping: true,
      save_answers: true,
      customDataKey: "custom_data",
    },
  },
});
```

#### b) Asignar `actionType` + `actionConfigId` al paso de confirmación

```typescript
const stepConfirmation = await this.prisma.flowStep.create({
  data: {
    flowId: flow.id,
    stepIndex: 10,
    type: "text",
    content: "✅ ¡Su solicitud de cita ha sido registrada exitosamente!...",
    messageFormat: "plain",
    actionType: "crm_create_task",          // ← Dispara la acción
    actionConfigId: actionCreateConsultation.id,  // ← Usa la config de arriba
  },
});
```

#### c) Agregar `crmField` a las opciones y pasos de input

Para **pasos tipo input**, hay que agregar un campo `crmField` al modelo `FlowStep`:

> ⚠️ **Nota**: Actualmente `crmField` solo existe en `StepOption`. Para pasos tipo `input`, el executor busca `stepData.crmField`, pero el schema de Prisma NO tiene ese campo en `FlowStep`. Hay dos opciones:

**Opción A (recomendada)**: Agregar `crmField` a `FlowStep` en el schema:
```prisma
model FlowStep {
  ...
  crmField          String?  @db.VarChar(191)  // Map input answer to CRM field
}
```

**Opción B**: Usar metadata en un campo JSON existente (menos limpio).

#### d) Con `crmField` en `FlowStep`, el seeder queda:

```typescript
// Nombre → nom (campo de paciente en Dolibarr)
const stepName = await this.prisma.flowStep.create({
  data: { ..., crmField: "nom" },
});

// Documento → options_numero_identificacion
const stepDocument = await this.prisma.flowStep.create({
  data: { ..., crmField: "options_numero_identificacion" },
});

// Teléfono → options_celular
const stepPhone = await this.prisma.flowStep.create({
  data: { ..., crmField: "options_celular" },
});

// Fecha → date_start
const stepDate = await this.prisma.flowStep.create({
  data: { ..., crmField: "date_start" },
});
```

Y para **opciones con crmField**:

```typescript
// Tipo de documento → cada opción mapea a options_tipo_de_documento
await this.prisma.stepOption.createMany({
  data: docTypes.map((name, i) => ({
    flowStepId: stepDocType.id,
    label: name,
    value: String(i + 1),
    nextStepId: stepDocument.id,
    triggersAction: false,
    crmField: "array_options.options_tipo_de_documento",
  })),
});

// EPS → options_eps
await this.prisma.stepOption.createMany({
  data: epsList.map((name, i) => ({
    flowStepId: stepEps.id,
    label: name,
    value: String(i + 1),
    nextStepId: stepConfirmation.id,
    triggersAction: false,
    crmField: "array_options.options_eps",
  })),
});
```

**Commit**: `feat(seed): add CRM actions and field mappings to appointment flow`

---

### 3.6 Migración Prisma (si se agrega `crmField` a `FlowStep`)

```bash
npx prisma migrate dev --name add-crm-field-to-flow-step
```

**Commit**: `feat(db): add crmField column to FlowStep`  
**Actualizar**: `ai-specs/specs/data-model.md`

---

## 4. Flujo de Ejecución Completo (Ejemplo RCV)

```
1. Usuario llega al paso de confirmación (stepIndex: 10)
2. ProcessUserAnswerHandler detecta: nextStep.actionType = "crm_create_task"
3. StepActionExecutor.execute() → detecta config.endpoint → ejecuta executeConfigDrivenAction()
4. Recolecta respuestas con crmField:
   - Especialidad → tipo_atencion = "Cardiología"
   - Fecha → date_start = "25/04/2026"
   - Nombre → nom = "Juan Pérez"
   - DocType → array_options.options_tipo_de_documento = "Cédula de Ciudadanía"
   - Documento → options_numero_identificacion = "1234567890"
   - Teléfono → options_celular = "3001234567"
   - EPS → array_options.options_eps = "Nueva EPS"

5. DolibarrAdapter.executeAction() construye:
   POST /rcvrest/consultations
   {
     "fk_soc": 4024,                              // Del chatbotUser.crmId
     "tipo_atencion": "gestion_whatsapp",          // staticField
     "status": 0,                                  // staticField
     "date_start": "25/04/2026",                   // answerMapping
     "custom_data": {
       "origen": "chatbot",
       "conversationId": "abc-123",
       "respuestas": [
         { "field": "nom", "value": "Juan Pérez" },
         { "field": "date_start", "value": "25/04/2026" },
         ...
       ]
     }
   }

6. Dolibarr devuelve el ID de la consulta creada → log en FlowExecutionLog
```

---

## 5. ¿Por qué es dinámico para otros setups?

| Escenario | Solo cambias... |
|---|---|
| **Otro módulo Dolibarr** (ej. DoliMed) | El `endpoint` en `StepActionConfig.config` → `/dolimed/appointments` |
| **Campos diferentes** | Los `crmField` en las opciones/steps del seeder |
| **Crear paciente en vez de consulta** | `actionType: crm_create_contact`, `endpoint: /rcvrest/patients`, `method: POST` |
| **Actualizar paciente existente** | `actionType: crm_update_contact`, `endpoint: /rcvrest/patients/{crmId}`, `method: PUT` |
| **Otro CRM completamente** | Solo implementas `executeAction()` en un nuevo adapter (ej. `SalesforceAdapter`) |

---

## 6. Orden de Implementación (Commits)

| # | Commit | Archivos |
|---|---|---|
| 1 | `feat(db): add crmField column to FlowStep` | `schema.prisma`, migración, `data-model.md` |
| 2 | `feat(crm): add executeAction to ICrmAdapter` | `crm-adapter.port.ts`, `dolibarr.adapter.ts`, `odoo.adapter.ts` |
| 3 | `feat(actions): add config-driven CRM action execution` | `step-action-executor.service.ts` |
| 4 | `feat(seed): add CRM actions and field mappings to appointment flow` | `fundacion-appointment.seeder.ts` |

---

## 7. Notas Importantes

1. **`crmField` en `FlowStep`**: Actualmente el executor YA busca `stepData.crmField` para inputs, pero el campo NO existe en el schema Prisma. Es mandatory agregar la migración.

2. **Campos anidados**: La API de Dolibarr RCV usa `array_options.options_eps` para campos personalizados. El helper `setNestedField` maneja esto transparentemente.

3. **`contactIdField: "fk_soc"`**: El campo que identifica al paciente en la consulta varía por módulo Dolibarr. En `rcvrest` es `fk_soc`, en otros podría ser `socid` o `thirdparty_id`. Por eso es configurable.

4. **Retrocompatibilidad**: El switch `if (config?.endpoint)` garantiza que los flujos existentes (Odoo/legacy) sigan funcionando sin cambios.

5. **No se necesita `createContact` para el flujo actual**: El flujo de citas asume que el paciente YA existe en Dolibarr (por `chatbotUser.crmId`). Si se necesita crear paciente primero, se agregaría otro step con `actionType: crm_create_contact` y endpoint `/rcvrest/patients`.
