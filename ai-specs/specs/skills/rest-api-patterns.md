---
name: rest-api-patterns
description: >
  Patrones de API REST: estructura de Controller, ResponseBuilder, validación con Zod y manejo de errores.
  Trigger: Cuando creas o modificas endpoints API.
author: developer
version: "2.0"
---

# REST API Patterns (DatiHub)

Patrones, convenciones y mejores prácticas para trabajar con APIs en DatiHub.

---

## 🎯 Estructura de la Capa API

```
src/infraestructure/http/
├── schemas/           # Zod validation schemas (UNO por recurso)
├── controllers/      # Controladores ligeros (delegan a UseCases)
└── routes/          # Definiciones de rutas Express
```

### Flujo

```
Request → Route → Validación Zod → Controller → UseCase → Repository → Response
```

---

## 📦 Patrón de Controller

Los controllers son **ligeros** — solo:

1. Extraer params de `req.params` / `req.body`
2. Llamar al UseCase
3. Retornar respuesta vía `ResponseBuilder`

```typescript
// ✅ Correcto: controller ligero
export class FlowController {
  @inject(TYPES.CreateFlowUseCase)
  private createFlowUseCase: CreateFlowUseCase

  async create(req: Request, res: Response) {
    const input = req.body // Ya validado por middleware Zod
    
    const result = await this.createFlowUseCase.execute(input)
    
    return ResponseBuilder.sendSuccess(res, result, 201)
  }
}

// ❌ Anti-patrón: NO hacer esto en el controller
// - NO validar aquí (Zod lo hace)
// - NO llamar al repository directamente (UseCase lo hace)
// - NO retornar res.json() directamente (ResponseBuilder lo hace)
```

---

## 🎨 Patrones de ResponseBuilder

Todas las respuestas pasan por `ResponseBuilder`:

```typescript
// Éxito (200)
ResponseBuilder.sendSuccess(res, data)

// Éxito con código custom (201, 204)
ResponseBuilder.sendSuccess(res, data, 201)

// Error
ResponseBuilder.sendError(res, error) // AppError or Error

// Paginación
ResponseBuilder.sendSuccess(res, {
  data: flows,
  pagination: {
    total: 100,
    pages: 10,
    current: 1,
    next: 2,
    prev: null
  }
})
```

### Formato de Respuesta

```typescript
// Éxito
{
  "success": true,
  "data": { ... }
}

// Error
{
  "success": false,
  "error": {
    "code": "not-found",
    "message": "Flow no encontrado"
  }
}
```

---

## 🛡️ Manejo de Errores

Todos los errores pasan por `ErrorFactory` → `AppError`. 
**Ver detalles completos en:** [Error Handling Skill](./error-handling.md)

---

## 🔗 Relacionado

- [Error Handling Skill](./error-handling.md) — ErrorFactory, executeSafe, AppError

---

## ✅ Patrón de Validación

Schema Zod va en `infra/http/schemas/`:

```typescript
// infra/http/schemas/flow.schema.ts
export const createFlowSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  triggerType: z.nativeEnum(TriggerType),
  flowType: z.nativeEnum(FlowType).default('STANDARD')
})

// Route usa middleware
router.post('/', 
  validateSchema(createFlowSchema),
  flowController.create
)
```

> **Regla**: Validación en `schemas/`, NO en controllers ni UseCases.

---

## 🎯 Convenciones RESTful

| Acción | Método | Ruta | Código |
|--------|--------|------|--------|
| Crear | POST | /resources | 201 |
| Leer uno | GET | /resources/:id | 200 |
| Leer varios | GET | /resources | 200 |
| Actualizar | PUT/PATCH | /resources/:id | 200 |
| Eliminar | DELETE | /resources/:id | 204 |

---

## 🔗 Relacionado

- [Error Handling Skill](./error-handling.md) — ErrorFactory, executeSafe, AppError
- [Validation & Security](./validation-security.md) — Zod validation
- [OpenAPI Specification (endpoints)](../../src/shared/swagger/swagger.json)