# Development Workflow Skill (DatiHub Backend)

## Purpose
Standardize development, testing, and delivery workflows across the team.

## Key Commands
- Dev server: `npm run dev`
- Build: `npm run build`
- Start: `npm run start`
- Lint: `npm run lint`
- Format: `npm run format`
- Tests: `npm run test`
- Coverage: `npm run coverage`

## Prisma Workflow (MANDATORY when schema changes)
Whenever `prisma/schema.prisma` is modified, this sequence is **non-negotiable**:

1. Edit `prisma/schema.prisma`.
2. Run `npx prisma migrate dev --name <short_description>` — generates and applies a versioned SQL migration.
3. Update `ai-specs/specs/data-model.md` to reflect the new model/field/relation.
4. Update the Mermaid ERD diagram at the bottom of `data-model.md` if new tables or FK links were added.
5. Commit everything together: `git commit -m "feat(db): <description> and sync data-model"`

> ⚠️ **NEVER** use `prisma migrate reset`, `prisma db push --force-reset`, or `prisma migrate deploy --force` on a feature branch. These destroy migration history and cause the "forced migration" problem. If you hit a drift error, resolve it with `prisma migrate resolve` instead.

## Conventional Commits
Format: `<type>(<scope>): <description>`

Tipos válidos: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, `perf`, `build`, `ci`, `revert`.

### Decision Matrix (aplica sin excepciones)

| Acción realizada | Tipo | Ejemplo |
| :--- | :--- | :--- |
| Nueva feature / endpoint | `feat` | `feat(api): add whatsapp webhook` |
| Correción de bug | `fix` | `fix(db): handle null on query` |
| Cambio de lógica interna (mismo resultado, mejor código) | `refactor` | `refactor(auth): simplify login logic` |
| Mover / renombrar archivos sin cambiar lógica | `chore` | `chore(arch): move schemas to infra` |
| Docs / README / archivos `.md` | `docs` | `docs(specs): update error-handling` |
| Cambios de DB (schema + migrate) | `feat(db)` o `fix(db)` | `feat(db): add conversation table` |
| Revertir un commit anterior | `revert` | `revert: feat(api) add broken endpoint` |

> **Regla de Oro**: Si el código hace lo mismo pero en otra carpeta/nombre → `chore`. Solo usa `refactor` si cambias la implementación técnica.

> **Reference**: Guía completa en [`docs/development/conventional_commit.md`](../../../docs/development/conventional_commit.md)

## Git Workflow
- Create a feature branch from `main`.
- Commit with Conventional Commits.
- Open a PR and ensure CI passes.

## Quality Gates
- ESLint clean
- Type checks clean
- Tests passing

## Reference Docs
- [Getting Started](../../../docs/development/getting-started.md)
- [Coding Standards](../../../docs/development/coding-standards.md)
