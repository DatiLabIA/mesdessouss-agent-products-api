---
name: datihub-error-handling-skill
description: Estándar maestro de gestión de errores, excepciones de dominio y respuestas HTTP seguras.
author: developer
version: "2.0"
---

# 🚨 Error Handling Skill (DatiHub)

## 🎯 Propósito
Garantizar una comunicación consistente, segura y altamente debugueable entre el servidor y el cliente. El sistema debe proteger la infraestructura en producción mientras ofrece máxima visibilidad en desarrollo.

---

## 🏗️ Los 3 Pilares del Flujo de Error

### 1. El Origen (Capa de Dominio/App)
Todo fallo controlado debe nacer como un `AppError` a través de la `ErrorFactory`.
- **Regla:** Queda terminantemente prohibido lanzar `new Error()` genéricos.
- **Uso:** `throw ErrorFactory.create("validation-failed", "El ID es requerido")`.

### 2. El Traductor (Capa de Infraestructura - Facade)
El método `executeSafe` actúa como un **Mapeador de Excepciones** de la base de datos (Prisma) hacia el Dominio.
- **P2002**: Se traduce a `conflict`.
- **P2003**: Extrae la `FK` fallida y lanza un `bad-request` con el nombre del campo.
- **P2025**: Se traduce a `not-found`.
- **Resiliencia:** Incluye un `Promise.race` con un `QUERY_TIMEOUT` para evitar bloqueos.

### 3. El Escudo (Capa de Infraestructura - ResponseBuilder)
El `ResponseBuilder` es el único punto de salida de datos hacia el cliente HTTP. Filtra la información según el entorno (`env.ENV`).

---

## 🛡️ Estándar de Respuesta (HttpResponse)

Todas las respuestas del API deben cumplir con esta estructura, gestionada automáticamente por el `ResponseBuilder`:

| Propiedad | Tipo | Descripción |
| :--- | :--- | :--- |
| `success` | boolean | `true` (2xx) o `false` (4xx/5xx). |
| `statusCode` | number | Código de estado HTTP real. |
| `message` | string | Mensaje legible para el usuario final. |
| `data` | any \| null | Carga útil (Solo en éxito). |
| `errorCode` | string | Código interno para lógica del Front-end (ej: `FLOW_NOT_FOUND`). |
| `devMessage` | string? | **Solo Dev:** El error técnico o stack trace crudo. |
| `filePath` | string? | **Solo Dev:** Ruta del archivo donde ocurrió el error. |
| `isOperational`| boolean? | **Solo Dev:** Indica si el error fue controlado por el programador. |

---

## 📜 Reglas de Implementación para el Equipo

### 1. En Repositorios y Readers
**Obligatorio:** Envolver cada interacción con Prisma en un `executeSafe`. Esto garantiza que el logging interno (`handleInternalLogging`) capture el error real antes de que se limpie para el cliente.

### 2. En Controllers
**Obligatorio:** No usar `res.json()`. Delegar la respuesta al builder:
- Éxito: `return ResponseBuilder.sendSuccess(res, appSuccessInstance);`
- Error: `return ResponseBuilder.sendError(res, appErrorInstance);`

### 3. En el Middleware de Errores Global
Cualquier excepción no capturada en los niveles superiores será atrapada por un Middleware que instanciará un `internal-error` genérico y lo pasará por el `ResponseBuilder` para asegurar que el servidor nunca se detenga.

---

## 🛠️ Checklist de Calidad
- [ ] ¿El error de Prisma fue mapeado a un error de Dominio?
- [ ] ¿Se está usando `ErrorFactory.fromZodError()` para fallos de validación en la entrada?
- [ ] ¿La respuesta en producción oculta el `filePath` y el `devMessage`?
- [ ] ¿El `errorCode` es descriptivo para que el Front-end sepa qué mostrar?
- [ ] ¿El error crítico tiene contexto? (Ej: enviar el userId o el conversationId al log interno para saber a quién le falló).

---
## 🔗 Documentación Vinculada
- [Clean Architecture Guide](./clean-architecture.md)
- [Design Patterns (Builders & Factories)](./design-patterns.md)

---

## 📝 Ejemplos Reales (DatiHub)

### 1. Crear AppError con ErrorFactory

```typescript
// En dominio - lanzar error de dominio
throw ErrorFactory.create('not-found', 'Flow no encontrado', 404);
```

### 2. Manejar ZodError

```typescript
// En middleware o controller
const result = schema.safeParse(input);
if (!result.success) {
  throw ErrorFactory.fromZodError(result.error);
}
```

### 3. Usar en repository con executeSafe

```typescript
// En repository
async findById(id: string) {
  return this.executeSafe(async () => {
    const flow = await prisma.flow.findUnique({ where: { id } });
    if (!flow) throw ErrorFactory.create('not-found', 'Flow no encontrado');
    return flow;
  });
}
```

### 4. Respuesta exitosa

```typescript
// En controller
return ResponseBuilder.sendSuccess(res, { data: flow }, 201);
```

### 5. Respuesta de error

```typescript
// En controller - pasar error al middleware
return next(appError);
```