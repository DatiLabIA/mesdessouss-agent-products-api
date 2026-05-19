---
name: datihub-validation-security-skill
description: Estándar de validación de esquemas, seguridad HTTP y políticas de acceso.
author: developer
version: "2.0"
---

# 🛡️ Validation & Security Skill (DatiHub)

## 🎯 Propósito
Garantizar que ningún dato malformado cruce la frontera de la infraestructura y proteger el sistema. La validación es el primer escudo de nuestra arquitectura.

---

## 🔍 Validación de Datos (Zod & Schemas)

### 1. Ubicación y Estructura (Frontera de Entrada)
- **Ubicación**: Los esquemas de Zod residen en `src/infrastructure/schemas/`. 
- **Decisión Arquitectónica**: Se sitúan al mismo nivel que los `controllers` para facilitar el acceso rápido y evitar ciclos de dependencia con la capa de Aplicación.
- **Regla**: Todo `Request` (body, query, params) debe pasar por su esquema correspondiente antes de tocar la lógica del controlador.

### 2. Tipado y Tipos Inferidos
- **Prohibición de `any`**: El tipado de los datos de entrada debe derivar siempre del esquema.
- **Uso de Inferencia**: Utilizar `z.infer<typeof schema>` para definir las interfaces que viajarán hacia los Use Cases. Esto asegura que si el esquema cambia, el TypeScript falle en cascada hasta el Dominio.

---

## 📁 Seguridad de Archivos (Uploads)
- **MIME Types**: Validación mediante *whitelist* (ej: `image/png`, `application/pdf`).
- **Control de Tamaño**: Middleware configurado para rechazar archivos excesivamente grandes antes de procesarlos (Prevención de DoS).

---

## 🔐 Autenticación y Autorización

### 1. JWT & Contexto
- El middleware de autenticación debe extraer el `userId` y colocarlo en el objeto `request`.
- Los Use Cases deben recibir este ID de forma explícita desde el controlador para validar el **Ownership** de los recursos.

### 2. Políticas de Acceso (Policies)
- **Ubicación**: Las interfaces de políticas residen en `src/domain/policies/`.
- **Lógica**: Se debe verificar no solo el ROL, sino la relación con el dato (Ej: ¿Es este médico el dueño de esta cita?).

---

## 🌐 Seguridad HTTP (Hardening)
- **Helmet**: Cabeceras de seguridad activas (XSS, Clickjacking).
- **CORS**: Solo dominios autorizados de DatiHub.
- **Rate Limiting**: Aplicado por IP/Usuario en rutas críticas (Auth, Webhooks).

---

## 📝 Ejemplos Reales (DatiHub)

### 1. Schema con validación compleja (Flow)

```typescript
// src/infrastructure/http/controllers/schemas/flow.schema.ts
const FlowBodySchema = z.object({
  name: z.string().min(1).max(50).transform((n) => n.toLowerCase()),
  description: z.string(),
  triggerType: z.nativeEnum(TriggerType),
  steps: StepBodySchema.array()
    .min(1)
    .refine((steps) => steps.some((s) => s.stepIndex === 0), {
      message: "Debe existir un paso con stepIndex = 0",
    }),
});

// Tipado inferido
export type FlowBody = z.infer<typeof FlowBodySchema>;
```

### 2. Schema con pagination

```typescript
// src/infrastructure/http/controllers/schemas/common.schema.ts
export const basePagination = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).default(10).optional(),
});

export const PaginationQuerySchema = z.object({
  query: basePagination,
});
```

### 3. UUID params

```typescript
export const UUIDParamsSchema = z.object({
  id: z.string().uuid("Invalid UUID format").openapi({
    description: "ID único del recurso",
    example: "550e8400-e29b-41d4-a716-446655440000",
    param: { in: "path", required: true },
  }),
});
```

---

## 🛠️ Integración con Error Handling
- **Mapeo de Fallos**: Cuando Zod detecta un error, el middleware debe invocar a `ErrorFactory.fromZodError()`.
- **Feedback**: El cliente recibe un código `400 Bad Request` con un array de errores detallando campo y motivo.

---

## 📊 Checklist de Validación
- [ ] ¿El esquema de Zod está en `infra/schemas/`?
- [ ] ¿Se usa `strip()` en el esquema para eliminar campos no definidos?
- [ ] ¿El controlador delega la respuesta de error de validación al `ResponseBuilder`?
- [ ] ¿La ruta está protegida por el middleware de seguridad correspondiente?

---
## 🔗 Documentación Vinculada
- [Clean Architecture (Infrastructure Layer)](./clean-architecture.md)
- [Error Handling (ResponseBuilder)](./error-handling.md)