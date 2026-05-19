---
name: ai-handbook
description: >
  Manual maestro para agentes de IA (OpenCode, Claude, Cursor, Copilot).
  Punto de entrada único para desarrollo de DatiHub Backend.
author: developer
version: "4.0.0"
updated: "2026-04"
---

# 🤖 DatiHub AI Handbook

**Contexto**: Sistema de chatbot multicanal (FLOW, IA, HUMAN) bajo arquitectura limpia estricta.
**Misión**: Mantener la integridad de las capas, la seguridad de los datos y el tipado estricto.
**Agentes supported**: OpenCode, Claude, Cursor, Copilot, y cualquier otro agente de IA.

> **📍 Punto de entrada**: Lee este archivo primero. Tiene links a todo lo que necesitás.

---

## 🚀Cómo empezar

1. **Lee el SKILLS-REGISTRY** para encontrar la skill correcta según tu tarea
2. **Carga la skill** que necesites
3. **Ejecuta** tu tarea

```
Tarea: "Crear un nuevo repositorio para User"
      ↓
Keywords: "repository", "prisma", "database"
      ↓
Skills: Prisma & Database + Prisma Queries
```

---

## 📋 SKILLS-REGISTRY (10 skills)

> Cada skill incluye **ejemplos reales del proyecto**.

| # | Skill | Keywords | Ejemplo incluido |
|---|-------|----------|----------------|
| 1 | [Clean Architecture](./specs/skills/clean-architecture.md) | `architecture`, `domain`, `capas` | ✅ Entity + Builder + UseCase + Controller |
| 2 | [REST API Patterns](./specs/skills/rest-api-patterns.md) | `controller`, `route`, `response` | ✅ ResponseBuilder patterns |
| 3 | [Command Handler Pattern](./specs/skills/command-handler-pattern.md) | `command`, `query`, `bus`, `cqrs` | ✅ Command + Handler example |
| 4 | [Prisma & Database](./specs/skills/prisma-database.md) | `prisma`, `migrate`, `schema` | Workflow |
| 5 | [Prisma Queries](./.github/skills/prisma-queries/SKILL.md) | `find`, `create`, `include` | ✅ DatiHub schema queries |
| 6 | [Design Patterns](./specs/skills/design-patterns.md) | `builder`, `observer`, `factory` | Patrones |
| 7 | [Validation & Security](./specs/skills/validation-security.md) | `zod`, `validate`, `schema` | ✅ Zod schemas reales |
| 8 | [Error Handling](./specs/skills/error-handling.md) | `error`, `AppError`, `ErrorFactory` | ✅ AppError examples |
| 9 | [Development Workflow](./specs/skills/development-workflow.md) | `git`, `commit`, `migrate` | Workflow |

> Lee el **[SKILLS-REGISTRY](./specs/skills/SKILLS-REGISTRY.md)** completo con todos los triggers.

---

## 🛠️ Comandos de Desarrollo

Usa los comandos en `ai-specs/.commands/` para flujos completos:

| Comando | Archivo | Descripción |
|---------|--------|-----------|
| Plan backend | [.commands/plan-backend-ticket.md](./.commands/plan-backend-ticket.md) | Genera plan de implementación |
| Plan frontend | [.commands/plan-frontend-ticket.md](./.commands/plan-frontend-ticket.md) | Genera plan frontend |
| Implementar backend | [.commands/develop-backend.md](./.commands/develop-backend.md) | Branch → código → tests → PR |
| Enriquecer ticket | [.commands/enrich-us.md](./.commands/enrich-us.md) | Añade detalles técnicos |

### Cómo invocar

**Copilot Chat**:
```
#file:ai-specs/.commands/plan-backend-ticket.md → argumento: SCRUM-42
```

**OpenCode / Claude / Cursor**:
```
/plan-backend-ticket SCRUM-42
```

---

## 🏗️ Arquitectura de Capas

```
src/
├── domain/           # Entities, Builders, Interfaces (puro, sin frameworks)
├── app/              # Use Cases, Commands, Queries
└── infraestructure/  # Zod schemas, Prisma, Express, DI
```

### Reglas

| Capa | Qué hacer | PROHIBIDO |
|------|----------|----------|
| **Domain** | Entidades, lógica de negocio | TSyringe, Prisma, Express |
| **App** | Use Cases / Commands | DB schemas, Zod |
| **Infra** | Zod, Prisma, Controllers | Lógica de negocio |

---

## 🚨 Reglas de Oro

### 1. Errores
- **NUNCA** `throw new Error()` → usar `ErrorFactory.create()`
- **NUNCA** `res.json()` → usar `ResponseBuilder.sendSuccess/sendError`
- **SIEMPRE** wrapping Prisma con `executeSafe()`

### 2. Validación
- Zod schemas en `infra/schemas/`, NO en `app/`
- **PROHIBIDO** `any` — tipado fuerte siempre

### 3. Datos
- Si cambiás `schema.prisma` → actualizar `ai-specs/specs/data-model.md`

---

## 📝 Git Commits

| Acción | Tipo | Ejemplo |
|--------|------|---------|
| Mover/Renombrar | `chore` | `chore(arch): move schemas` |
| Cambiar lógica | `refactor` | `refactor(auth): simplify` |
| Nueva feature | `feat` | `feat(api): add webhook` |
| Bug fix | `fix` | `fix(db): handle null` |
| Docs/Skills | `docs` | `docs(specs): update` |

---

## 📋 Checklist (ante de terminar)

- [ ] Zod schemas en `infra/schemas/`
- [ ] Repositorio usa `executeSafe`
- [ ] Interfaces con `@inject`
- [ ] Sin `new Error()` — usá `ErrorFactory`
- [ ] Commit con Conventional Commits

---

## 🛠️ Stack

- **Runtime**: Node.js v20+ (TypeScript)
- **Framework**: Express v5
- **ORM**: Prisma v7 (PostgreSQL + pgvector + pgmq)
- **DI**: TSyringe
- **Validación**: Zod
- **IA**: AWS Bedrock (Claude)

### Modos de Conversación
- **FLOW**: Flujos estructurados
- **IA**: Asistente conversacional
- **HUMAN**: Transferencia a humano

---

## 📚 Guías Extendas

Para deep-dives, ver `docs/guides/`:

| Categoría | Guías |
|-----------|------|
| **Backend** | webhooks, email provider, storage, cache, event-bus |
| **Patterns** | pattern-builder, pattern-observer |
| **Operations** | `docs/development/` (local-setup, swagger) |

> **Nota**: Las guías de frontend están en `docs/guides/frontend/`

---

## 🔗 Links Rápidos

- [SKILLS-REGISTRY](./specs/skills/SKILLS-REGISTRY.md)
- [Base Standards](./specs/base-standards.mdc)
- [Backend Standards](./specs/backend-standards.mdc)
- [Swagger API](../../src/shared/swagger/swagger.json)

---

**Última actualización**: Abril 2026
**Versión**: 4.0.0