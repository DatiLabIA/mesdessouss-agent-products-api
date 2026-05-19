---
name: datihub-ai-instructions
description: Manual maestro de instrucciones para agentes de IA (Copilot, Cursor, Claude).
author: developer
version: "3.0.0"
updated: "2026-04"
---

# 🤖 GitHub & AI Rules - DatiHub Backend

**Contexto**: Sistema de chatbot multicanal (FLOW, IA, HUMAN) bajo arquitectura limpia estricta.  
**Misión**: Mantener la integridad de las capas, la seguridad de los datos y el tipado estricto.

---

## 🛠️ Comandos de Desarrollo

Para ejecutar flujos de trabajo completos, usa los comandos definidos en `ai-specs/.commands/`.

### Cómo invocar según la herramienta

**Copilot Chat (VS Code)** — adjuntar el archivo con `#` y pasar el argumento: 
```
#file:ai-specs/.commands/plan-backend-ticket.md  →  argumento: SCRUM-42
#file:ai-specs/.commands/plan-backend-ticket.md  →  argumento: "sistema de métricas con event bus"
```

**Claude Code / Cursor** — slash command nativo:
```
/plan-backend-ticket SCRUM-42
/plan-backend-ticket "sistema de métricas con event bus"
```
---

### Comandos disponibles

| Comando | Archivo | Descripción |
|---|---|---|
| Plan backend | [`ai-specs/.commands/plan-backend-ticket.md`](../ai-specs/.commands/plan-backend-ticket.md) | Genera plan de implementación backend |
| Plan frontend | [`ai-specs/.commands/plan-frontend-ticket.md`](../ai-specs/.commands/plan-frontend-ticket.md) | Genera plan de implementación frontend |
| Implementar backend | [`ai-specs/.commands/develop-backend.md`](../ai-specs/.commands/develop-backend.md) | Branch → código → tests → PR |
| Enriquecer ticket | [`ai-specs/.commands/enrich-us.md`](../ai-specs/.commands/enrich-us.md) | Añade detalles técnicos a una historia |

> **Sin Jira configurado**: cada comando tiene un fallback que busca un archivo local en `ai-specs/changes/[ID]_*.md`, o acepta descripción en texto libre como argumento.

### Ciclo de vida de los artefactos

| Carpeta | Qué contiene | Cuándo se crea | Ciclo de vida |
|---|---|---|---|
| `ai-specs/changes/[ID]_backend.md` | Plan de implementación de ticket | Comando `plan-backend-ticket` | Temporal — se marca ✅ al cerrar el PR |
| `ai-specs/changes/[ID]_frontend.md` | Plan de implementación frontend | Comando `plan-frontend-ticket` | Temporal — se marca ✅ al cerrar el PR |
| `docs/guides/*.md` | Guías de arquitectura permanentes | Al implementar patrones reutilizables | Permanente |

> **Regla**: si generaste documentación que otros equipos reutilizarán (patrones, decisiones de diseño, guías de uso), va en `docs/guides/` — **no** en `ai-specs/changes/`.

---

## 🏗️ Arquitectura de Capas (Estructura de Directorios)

### 1. Domain Layer (`src/domain/`)
- **Builders**: **OBLIGATORIO** para entidades con más de **5 atributos**.
- **Interfaces**: Contratos para `IRepository`, `IPort` y **`IReader`**.
- **Exceptions**: Uso exclusivo de `ErrorFactory`.
- **🚫 PROHIBIDO**: Decoradores de TSyringe (mantener dominio puro), Prisma o Express.

### 2. Application Layer (`src/app/`)
- **Use Cases**: Orquestación de lógica. Inyectan interfaces mediante `@inject`.
- **🚫 PROHIBIDO**: Lógica de base de datos o esquemas de validación HTTP.

### 3. Infrastructure Layer (`src/infraestructure/`)
- **Schemas (Zod)**: Ubicados en `src/infraestructure/schemas/` (al mismo nivel que controllers).
- **Database**: Repositorios y Readers implementados con el Facade **`executeSafe`**.
- **Mappers**: Transformación bidireccional `Entity ↔ DTO`.
- **DI Container**: Configuración centralizada en `src/infraestructure/DI/container.ts`.

---

## 🚨 Reglas de Oro para la IA (Strict Rules)

### 1. Manejo de Errores & Respuestas
- **NUNCA** uses `throw new Error()`. Usa siempre `ErrorFactory.create('tipo', 'mensaje')`.
- **NUNCA** envíes respuestas directas con `res.json()`. Usa `ResponseBuilder.sendSuccess` o `ResponseBuilder.sendError`.
- Todo acceso a Prisma **DEBE** envolverse en `this.executeSafe(() => ... )`.

### 2. Validación & Tipado
- Los esquemas de Zod residen en `infra/schemas/`. No en `app/`.
- Usa `z.infer<typeof schema>` para definir los tipos de entrada que recibe el Use Case.
- **Prohibido el uso de `any`**. Tipado fuerte en toda la cadena.

### 3. Sincronización de Datos
- Si se modifica `schema.prisma`, es **MANDATORIO** actualizar `ai-specs/specs/data-model.md` en el mismo commit.

---

## 🔖 Skills Especializados (Documentación de Referencia)

Cuando el agente necesite detalles específicos, debe consultar:
- 🏗️ **[Clean Architecture](../ai-specs/specs/skills/clean-architecture.md)**: Reglas de dependencias y capas.
- 📐 **[Design Patterns](../ai-specs/specs/skills/design-patterns.md)**: Guía de Builders, Readers y Repositories.
- 🚨 **[Error Handling](../ai-specs/specs/skills/error-handling.md)**: Flujo de `executeSafe`, `ErrorFactory` y `ResponseBuilder`.
- 🛡️ **[Validation & Security](../ai-specs/specs/skills/validation-security.md)**: Uso de Zod en `infra/schemas` y seguridad JWT.
- 🗄️ **[Prisma & Database](../ai-specs/specs/skills/prisma-database.md)**: Sincronización con `data-model.md` y queries.

> **💡 Tip**: Cuando necesites detalles sobre estos temas, consulta el skill correspondiente.
---

## 📝 Git & Commits: Decision Matrix (No Exceptions)
Usa este mapeo estricto para evitar errores de semántica:

| Acción Realizada | Tipo | Ejemplo |
| :--- | :--- | :--- |
| **Mover/Renombrar archivos** | `chore` | `chore(arch): move schemas to infra` |
| **Cambiar lógica interna** | `refactor` | `refactor(auth): simplify login logic` |
| **Nueva Feature/Endpoint** | `feat` | `feat(api): add whatsapp webhook` |
| **Corregir Bug/Error** | `fix` | `fix(db): handle null on query` |
| **Docs/README/Skill .md** | `docs` | `docs(specs): update error-handling` |

> **REGLA DE ORO**: Si el código hace lo mismo pero en otra carpeta/nombre, es **CHORE**. Solo usa `refactor` si cambias la implementación técnica.

---

## 📋 Checklist de Validación (AI Peer Review)

La IA debe verificar estos puntos antes de considerar una tarea terminada:

- [ ] **Estructura**: ¿Los esquemas de Zod están en `infra/schemas`?
- [ ] **Persistencia**: ¿El repositorio/reader usa el wrapper `executeSafe`?
- [ ] **Inyección**: ¿Se usan interfaces (`@inject`) para desacoplar las clases?
- [ ] **Errores**: ¿Se evitó el uso de `new Error()` y se usó `ErrorFactory`?
- [ ] **Naming**: ¿El commit sigue el estándar de *Conventional Commits*? (ej: `feat(api): ...`)

---

## 🛠️ Stack Tecnológico
- **Runtime**: Node.js v20+ (TypeScript)
- **Framework**: Express v5
- **ORM**: Prisma v7.2.0 (PostgreSQL con extensiones `pgvector` y `pgmq`)
- **DI**: TSyringe
- **Validación**: Zod
- **IA**: AWS Bedrock (Claude 3.5 Sonnet)

### Modos de Conversación
- **FLOW**: Flujos estructurados paso a paso
- **IA**: Asistente conversacional inteligente
- **HUMAN**: Transferencia a agentes humanos

---

**Última actualización**: Abril 2026  
**Versión**: 3.0.0