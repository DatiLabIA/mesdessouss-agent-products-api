---
name: skills-registry
description: >
  Central registry of all AI skills for DatiHub Backend.
  Trigger: When the agent needs to know what skill to load for a specific task.
author: developer
version: "2.0"
---

# 🎯 Skills Registry (DatiHub Backend)

> **📍 Punto de entrada**: Lee primero **[ai-handbook](../ai-handbook.md)** — el manual maestro para todos los agentes.

This registry centralizes all skills to help agents automatically load the right skill for each task.

---

## 📋 Index

| # | Skill | Trigger Keywords | Where |
|---|------|-------------|------|
| 1 | Clean Architecture | `architecture`, `clean arch`, `capas`, `domain`, `app`, `infra` | [clean-architecture.md](./clean-architecture.md) |
| 2 | Prisma & Database | `prisma`, `database`, `db`, `migrate`, `schema`, `query`, `repository` | [prisma-database.md](./prisma-database.md) |
| 3 | Prisma Queries | `find`, `create`, `update`, `delete`, `include`, `transaction`, `aggregate` | [.github/skills/prisma-queries/SKILL.md](../../.github/skills/prisma-queries/SKILL.md) |
| 4 | Validation & Security | `zod`, `validate`, `schema`, `security`, `sanitize`, `input` | [validation-security.md](./validation-security.md) |
| 5 | Error Handling | `error`, `exception`, `throw`, `catch`, `AppError`, `ErrorFactory` | [error-handling.md](./error-handling.md) |
| 6 | Design Patterns | `pattern`, `builder`, `observer`, `adapter`, `factory`, `strategy` | [design-patterns.md](./design-patterns.md) |
| 7 | Development Workflow | `workflow`, `git`, `commit`, `migrate`, `test`, `lint` | [development-workflow.md](./development-workflow.md) |
| 8 | Command Handler Pattern | `command`, `query`, `handler`, `bus`, `cqrs` | [command-handler-pattern.md](./command-handler-pattern.md) (⭐ skill) |

---

## 🔍 How It Works

When you start a task, MATCH YOUR KEYWORDS to find the right skill:

```
Task: "Create a new repository for User"
       ↓
Keywords: "repository", "prisma", "database"
       ↓
Match: Skill #2 (Prisma & Database) + Skill #3 (Prisma Queries)
```

---

## 🎯 Triggers by Category

### Database & Persistence
- **Prisma & Database** → Cuando modificás `schema.prisma`, hacés migrate, o diseñás la capa de datos
- **Prisma Queries** → Cuando escribís queries (find, create, update, transactions)

### Architecture & Code
- **Clean Architecture** → Cuando definís entidades, usecases, o arquitectura en capas
- **Design Patterns** → Cuando aplicás un patrón (Builder, Observer, etc.)

### Quality & Safety
- **Validation & Security** → Cuando validás input con Zod
- **Error Handling** → Cuando manejás errores

### Workflow
- **Development Workflow** → Cuando hacés commit, migrate, o workflow general

---

## 📌 Usage Examples

| Task | Skills to Load |
|------|-------------|
| Add new table to Prisma | Prisma & Database |
| Write a query | Prisma Queries |
| Create new entity + repository | Clean Architecture + Prisma & Database + Prisma Queries |
| Add validation to endpoint | Validation & Security |
| Handle API errors | Error Handling |
| Implement Builder pattern | Design Patterns |

---

---

## 📚 Docs Guides Mapping

Extended guides from `docs/guides/` — use these for deep-dive implementation details.

| Task | Skill | Docs Guide |
|------|-------|------------|
| Builder pattern (Flows) | Design Patterns | [pattern-builder-flow.md](../../../docs/guides/pattern-builder-flow.md) |
| Observer pattern (Mass Send) | Design Patterns | [pattern-observer-mass-send.md](../../../docs/guides/pattern-observer-mass-send.md) |
| Event bus (PGMQ) | -- | [event-bus-usage-guide.md](../../../docs/guides/event-bus-usage-guide.md) |
| Command/Query patterns | -- | [command-handler-pattern.md](./command-handler-pattern.md) |
| Database resolver | -- | [database-resolver.md](../../../docs/guides/database-resolver.md) |
| Input validation | Validation & Security | [input-validation-system.md](../../../docs/guides/input-validation-system.md) |
| REST API Patterns | `controller`, `route`, `response`, `endpoint` | [rest-api-patterns.md](./rest-api-patterns.md) |
| Webhook system | -- | [webhook-system.md](../../../docs/guides/webhook-system.md) |
| Email provider | -- | [email-provider-abstraction-guide.md](../../../docs/guides/email-provider-abstraction-guide.md) |
| Storage/File upload | -- | [file-upload-system.md](../../../docs/guides/file-upload-system.md) |
| Multi-agent IA | -- | [multi-agent-architecture.md](../../../docs/guides/multi-agent-architecture.md) |
| Extensibility (providers) | -- | [extensibility-multi-provider.md](../../../docs/guides/extensibility-multi-provider.md) |

---

## 🔗 Dependencies

- [Base Standards](../base-standards.mdc) — Always loaded
- [Backend Standards](../backend-standards.mdc) — For backend tasks
- [.agents/backend-developer.md](../../.agents/backend-developer.md) — Backend agent definition