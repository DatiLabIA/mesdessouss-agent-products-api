# Test Coverage Rules — Pre-Push Gate

**Versión**: 1.0.0  
**Actualizado**: Abril 2026  
**Propósito**: Define qué clases DEBEN tener cobertura de tests para que un `git push` sea permitido.

> ⚠️ **Estado actual: INACTIVO**  
> El gate de cobertura está comentado en `.husky/pre-push` hasta que se alcancen los umbrales.  
> Para activarlo: descomentar `npm run test:coverage || exit 1` en `.husky/pre-push`.

---

## Niveles de exigencia

| Nivel | Cobertura mínima | Impacto si falla | Activo |
|-------|:---:|---|:---:|
| **Tier 1 — Critical** | 90% | ❌ Bloquea el push | ⏸️ Pendiente |
| **Tier 2 — Important** | 70% | ❌ Bloquea el push | ⏸️ Pendiente |
| **Tier 3 — Tracked** | — | ⚠️ Solo se reporta, no bloquea | ⏸️ Pendiente |

---

## Tier 1 — Critical (bloquea push)

Estas clases contienen lógica de negocio pura o contratos fundamentales. Toda entidad, builder, value object, handler y Use Case debe tener cobertura ≥ 90% antes de hacer push.

> Leyenda: ✅ test existente · ⬜ pendiente

### Domain — Entities
> Contratos de negocio. Testear: construcción, invariantes, métodos de dominio.

| Test | Clase | Archivo |
|:----:|-------|---------|
| ✅ | `AdverseKeywordEntity` | `src/domain/entities/adverse-keyword.entity.ts` |
| ⬜ | `ChatbotUser` | `src/domain/entities/chatbot-user.entity.ts` |
| ⬜ | `UserFile` | `src/domain/entities/file.entity.ts` |
| ✅ | `FlowMetricEvent` | `src/domain/entities/flow-metric.entity.ts` |
| ⬜ | `FlowSchedule` | `src/domain/entities/flow-schedule.entity.ts` |
| ✅ | `StepEntity` | `src/domain/entities/flow-step.entity.ts` |
| ✅ | `FlowEntity` | `src/domain/entities/flow.entity.ts` |
| ✅ | `HandoffDestinationEntity` | `src/domain/entities/handoff-destination.entity.ts` |
| ⬜ | `JobExecutionLogEntity` | `src/domain/entities/job-execution-log.entity.ts` |
| ⬜ | `KnowledgeDocumentEntity` | `src/domain/entities/knowledge-document.entity.ts` |
| ⬜ | `KnowledgeEntity` | `src/domain/entities/knowledge.entity.ts` |
| ✅ | `ScheduledTaskEntity` | `src/domain/entities/schedule.entity.ts` |
| ✅ | `SessionEntity` | `src/domain/entities/session.entity.ts` |
| ⬜ | `StepActionConfig` | `src/domain/entities/step-action-config.entity.ts` |
| ⬜ | `StepOption` | `src/domain/entities/step-option.entity.ts` |
| ⬜ | `UserAnswer` | `src/domain/entities/user-answer.entity.ts` |
| ⬜ | `UserConversation` | `src/domain/entities/user-conversation.entity.ts` |
| ✅ | `UserEntity` | `src/domain/entities/user.entity.ts` |
| ⬜ | `WhatsAppTemplate` | `src/domain/entities/whatsapp-template.entity.ts` |

### Domain — Builders
> Testear: método `.build()`, validaciones, valores por defecto.

| Test | Clase | Archivo |
|:----:|-------|---------|
| ⬜ | `ChatbotUserBuilder` | `src/domain/builders/chatbot-user.builder.ts` |
| ✅ | `FlowStepBuilder` | `src/domain/builders/flow-step.builder.ts` |
| ✅ | `FlowBuilder` | `src/domain/builders/flow.builder.ts` |
| ⬜ | `UserConversationBuilder` | `src/domain/builders/user-conversation.builder.ts` |

### Domain — Value Objects
> Testear: creación válida, rechazo de valores inválidos, igualdad.

| Test | Clase | Archivo |
|:----:|-------|---------|
| ✅ | `Email` | `src/domain/value-objects/email.vo.ts` |
| ✅ | `HashedPassword` | `src/domain/value-objects/hashedpassword.vo.ts` |
| ✅ | `Name` | `src/domain/value-objects/name.vo.ts` |
| ✅ | `Password` | `src/domain/value-objects/password.vo.ts` |
| ✅ | `Role` | `src/domain/value-objects/role.vo.ts` |
| ⬜ | `WebhookSignature` | `src/domain/value-objects/webhook.vo.ts` |
| ⬜ | `Pagination<T>` / `PaginationOption` | `src/domain/value-objects/pagination.vo.ts` |
| ⬜ | `WhatsAppMessage` / `WhatsAppButton` | `src/domain/value-objects/whassapt.vo.ts` |

### Domain — Services & Policies
> Testear: reglas de negocio, flujos de decisión, casos borde.

| Test | Clase | Archivo |
|:----:|-------|---------|
| ✅ | `FlowNavigationService` | `src/domain/services/flow-navigation.service.ts` |
| ✅ | `PasswordService` | `src/domain/services/password.service.ts` |
| ✅ | `IdMapper` | `src/domain/services/mapper.service.ts` |
| ⬜ | `UserRolePolicyService` | `src/domain/policies/user-role-policy.service.ts` |

### Domain — Exceptions & Factory
> Testear: creación de errores, mapeo de tipos, mensajes.

| Test | Clase | Archivo |
|:----:|-------|---------|
| ✅ | `AppError` | `src/domain/exceptions/error/app-error.exeption.ts` |
| ⬜ | `ErrorFactory` | `src/domain/exceptions/factory/error-factory.exeption.ts` |
| ⬜ | `AppSuccess` | `src/domain/exceptions/success/app-success.exeption.ts` |

### App — Command Handlers
> Testear: flujo happy path, manejo de error, delegación a interfaces (mocks).

| Test | Clase | Archivo |
|:----:|-------|---------|
| ✅ | `CreateFlowCommandHandler` | `src/app/commands/flow/create-flow.handler.ts` |
| ✅ | `DeleteFlowCommandHandler` | `src/app/commands/flow/delete-flow.handler.ts` |
| ✅ | `MassSendFlowCommandHandler` | `src/app/commands/flow/mass-send-flow.handler.ts` |
| ✅ | `ProcessUserAnswerCommandHandler` | `src/app/commands/flow/process-user-answer.handler.ts` |
| ✅ | `ToggleActiveFlowCommandHandler` | `src/app/commands/flow/toggle-active-flow.handler.ts` |
| ✅ | `UpdateFlowCommandHandler` | `src/app/commands/flow/update-flow.handler.ts` |
| ✅ | `LoginCommandHandler` | `src/app/commands/user/login.handler.ts` |
| ✅ | `LogoutUserCommandHandler` | `src/app/commands/user/logout-user.handler.ts` |
| ✅ | `RefreshTokenCommandHandler` | `src/app/commands/user/refresh-token.handler.ts` |
| ✅ | `RegisterUserCommandHandler` | `src/app/commands/user/register-user.handler.ts` |
| ✅ | `CreateAdverseKeywordCommandHandler` | `src/app/commands/adverse-keyword/create-adverse-keyword.handler.ts` |
| ✅ | `DeleteAdverseKeywordCommandHandler` | `src/app/commands/adverse-keyword/delete-adverse-keyword.handler.ts` |
| ✅ | `UpdateAdverseKeywordCommandHandler` | `src/app/commands/adverse-keyword/update-adverse-keyword.handler.ts` |
| ⬜ | `AddDocumentCommandHandler` | `src/app/commands/knowledge-base/add-document.handler.ts` |
| ⬜ | `CreateKnowledgeBaseCommandHandler` | `src/app/commands/knowledge-base/create-knowledge-base.handler.ts` |
| ⬜ | `DeleteKnowledgeBaseCommandHandler` | `src/app/commands/knowledge-base/delete-knowledge-base.handler.ts` |
| ⬜ | `RemoveDocumentCommandHandler` | `src/app/commands/knowledge-base/remove-document.handler.ts` |
| ⬜ | `UpdateDocumentCommandHandler` | `src/app/commands/knowledge-base/update-document.handler.ts` |
| ⬜ | `UpdateKnowledgeBaseCommandHandler` | `src/app/commands/knowledge-base/update-knowledge-base.handler.ts` |
| ⬜ | `CreateSessionCommandHandler` | `src/app/commands/session/create-session.handler.ts` |
| ⬜ | `CreateStepActionCommandHandler` | `src/app/commands/step-action/create-step-action.handler.ts` |
| ⬜ | `DeleteStepActionCommandHandler` | `src/app/commands/step-action/delete-step-action.handler.ts` |
| ⬜ | `UpdateStepActionCommandHandler` | `src/app/commands/step-action/update-step-action.handler.ts` |
| ✅ | `CreateTaskCommandHandler` | `src/app/commands/task/create-task.handler.ts` |
| ✅ | `DeleteTaskCommandHandler` | `src/app/commands/task/delete-task.handler.ts` |
| ✅ | `UpdateTaskCommandHandler` | `src/app/commands/task/update-task.handler.ts` |

### App — Query Handlers
> Testear: delegación al reader/repo correcto, mapeo de respuesta.

| Test | Clase | Archivo |
|:----:|-------|---------|
| ✅ | `GetAllFlowsQueryHandler` | `src/app/queries/flow/get-all-flows.handler.ts` |
| ✅ | `GetFlowByIdQueryHandler` | `src/app/queries/flow/get-flow-by-id.handler.ts` |
| ✅ | `GetProfileQueryHandler` | `src/app/queries/user/get-profile.handler.ts` |
| ⬜ | `GetAllAdverseKeywordsQueryHandler` | `src/app/queries/adverse-keyword/get-all-adverse-keywords.handler.ts` |
| ⬜ | `GetAllKnowledgeBasesQueryHandler` | `src/app/queries/knowledge-base/get-all-knowledge-bases.handler.ts` |
| ⬜ | `GetKnowledgeBaseByIdQueryHandler` | `src/app/queries/knowledge-base/get-knowledge-base-by-id.handler.ts` |
| ⬜ | `GetAllStepActionsQueryHandler` | `src/app/queries/step-action/get-all-step-actions.handler.ts` |
| ⬜ | `GetStepActionByIdQueryHandler` | `src/app/queries/step-action/get-step-action-by-id.handler.ts` |
| ✅ | `GetAllTasksQueryHandler` | `src/app/queries/task/get-all-taks.handler.ts` |
| ✅ | `GetByIdTaskQueryHandler` | `src/app/queries/task/get-task-id.handler.ts` |

### App — Use Cases
> Testear: orquestación, delegación a repositorios e interfaces (mocks).

| Test | Clase | Archivo |
|:----:|-------|---------|
| ✅ | `GenerateAIResponseUseCase` | `src/app/use-cases/ai/generate-ai-response.use-case.ts` |
| ⬜ | `GenerateAIResponseStreamUseCase` | `src/app/use-cases/ai/generate-ai-response-stream.use-case.ts` |
| ⬜ | `ExecuteStepActionUseCase` | `src/app/use-cases/flow/execute-step-action.use-case.ts` |
| ⬜ | `ProcessUserAnswerUseCase` | `src/app/use-cases/flow/process-user-answer.use-case.ts` |
| ⬜ | `AddDocumentUseCase` | `src/app/use-cases/knowledge-base/add-document.use-case.ts` |
| ⬜ | `CreateKnowledgeBaseUseCase` | `src/app/use-cases/knowledge-base/create.use-case.ts` |
| ⬜ | `DeleteKnowledgeBaseUseCase` | `src/app/use-cases/knowledge-base/delete.use-case.ts` |
| ⬜ | `GetAllKnowledgeBaseUseCase` | `src/app/use-cases/knowledge-base/get-all.use-case.ts` |
| ⬜ | `GetByIdKnowledgeBaseUseCase` | `src/app/use-cases/knowledge-base/get-by-id.use-case.ts` |
| ⬜ | `RemoveDocumentUseCase` | `src/app/use-cases/knowledge-base/remove-document.use-case.ts` |
| ⬜ | `UpdateDocumentUseCase` | `src/app/use-cases/knowledge-base/update-document.use-case.ts` |
| ⬜ | `UpdateKnowledgeBaseUseCase` | `src/app/use-cases/knowledge-base/update.use-case.ts` |
| ⬜ | `ProcessFileUploadUseCase` | `src/app/use-cases/messaging/process-file-upload.use-case.ts` |
| ✅ | `ProcessIncomingMessageUseCase` | `src/app/use-cases/messaging/process-incoming-message.use-case.ts` |

### App — Response Mappers
> Testear: transformación Entity → DTO, campos opcionales, valores nulos.

| Test | Clase | Archivo |
|:----:|-------|---------|
| ✅ | `FlowResponseMapper` | `src/app/commands/flow/dtos/flow-response.ts` |
| ✅ | `UserResponseMapper` | `src/app/commands/user/dtos/user-response.mapper.ts` |
| ⬜ | `TaskResponseMapper` | `src/app/commands/task/dtos/task.response.mapper.ts` |

### Infra — Mappers (bidireccionales)
> Testear: `toDomain()`, `toPersistence()`, manejo de nulos.

| Test | Clase | Archivo |
|:----:|-------|---------|
| ⬜ | `AdverseKeywordMapper` | `src/infraestructure/database/mapper/adverse-keywork.mapper.ts` |
| ⬜ | `ChatbotUserMapper` | `src/infraestructure/database/mapper/chatbot-user.mapper.ts` |
| ⬜ | `FlowMetricMapper` | `src/infraestructure/database/mapper/flow-metric.mapper.ts` |
| ⬜ | `FlowSheduleMapper` | `src/infraestructure/database/mapper/flow-shedule.mapper.ts` |
| ✅ | `FlowMapper` | `src/infraestructure/database/mapper/flow.mapper.ts` |
| ⬜ | `FlowStepMapper` | `src/infraestructure/database/mapper/flowStep.mapper.ts` |
| ✅ | `HandoffDestinationMapper` | `src/infraestructure/database/mapper/handoff-destination.mapper.ts` |
| ⬜ | `JobExecutionLogMapper` | `src/infraestructure/database/mapper/job-execution-log.mapper.ts` |
| ⬜ | `QueryMapper` | `src/infraestructure/database/mapper/pagination.mapper.ts` |
| ⬜ | `SessionMapper` | `src/infraestructure/database/mapper/session.mapper.ts` |
| ⬜ | `StepActionConfigMapper` | `src/infraestructure/database/mapper/step-action-config.mapper.ts` |
| ✅ | `TaskPersistenceMapper` | `src/infraestructure/database/mapper/task.mapper.ts` |
| ✅ | `UserPersistenceMapper` | `src/infraestructure/database/mapper/user.mapper.ts` |

### App — Orchestrator

| Test | Clase | Archivo |
|:----:|-------|---------|
| ✅ | `FlowOrchestrator` | `src/app/observers/orchestrators/flow-orchestrator.ts` |

---

## Tier 2 — Important (bloquea push)

Lógica de infraestructura crítica que puede mockearse sin base de datos real.

> Leyenda: ✅ test existente · ⬜ pendiente

### Infra — Bus (CQRS dispatch)

| Test | Clase | Archivo |
|:----:|-------|---------|
| ⬜ | `CommandBus` | `src/infraestructure/bus/command-bus.ts` |
| ⬜ | `QueryBus` | `src/infraestructure/bus/query-bus.ts` |

### Infra — Event Bus Handlers

| Test | Clase | Archivo |
|:----:|-------|---------|
| ✅ | `AdverseEventEmailHandler` | `src/infraestructure/event-bus/handlers/adverse-email.handler.ts` |
| ⬜ | `FlowMassDispatchedHandler` | `src/infraestructure/event-bus/handlers/flow-mass-dispatched.handler.ts` |
| ✅ | `MetricRecordedHandler` | `src/infraestructure/event-bus/handlers/metric-recorded.handler.ts` |
| ⬜ | `NotificationEmailHandler` | `src/infraestructure/event-bus/handlers/notification-email.handler.ts` |
| ⬜ | `UserAnswerProcessedHandler` | `src/infraestructure/event-bus/handlers/user-answer-processed.handler.ts` |
| ✅ | `WebhookTriggeredHandler` | `src/infraestructure/event-bus/handlers/webhook-triggered.handler.ts` |
| ✅ | `WelcomeEmailHandler` | `src/infraestructure/event-bus/handlers/welcome-email.ts` |

### Infra — HTTP Middlewares & Response

| Test | Clase | Archivo |
|:----:|-------|---------|
| ⬜ | `ResponseBuilder` | `src/infraestructure/http/middlewares/response-builder.ts` |
| ⬜ | `AuthGuard` | `src/infraestructure/http/middlewares/auth-guard.middleware.ts` |

### Infra — Key Services

| Test | Clase | Archivo |
|:----:|-------|---------|
| ⬜ | `SmartRouterService` | `src/infraestructure/services/routing/smart-router.service.ts` |
| ✅ | `StepActionExecutorService` | `src/infraestructure/services/step-actions/step-action-executor.service.ts` |
| ⬜ | `HandoffRouterService` | `src/infraestructure/services/handoff/handoff-router.service.ts` |
| ⬜ | `AdverseEventDetectorService` | `src/infraestructure/services/adverse-events/adverse-event-detector.service.ts` |
| ⬜ | `AdverseEventService` | `src/infraestructure/services/adverse-events/adverse-events.service.ts` |

### App — Observers

| Test | Clase | Archivo |
|:----:|-------|---------|
| ⬜ | `ActiveFlowValidator` | `src/app/observers/active-flow.observer.ts` |
| ⬜ | `FlowSchedulerValidator` | `src/app/observers/flow-scheduler.observer.ts` |
| ⬜ | `PendigSchedulesValidator` | `src/app/observers/pending-schedules.observer.ts` |
| ⬜ | `RecentExecutionsValidator` | `src/app/observers/recent-execution.observer.ts` |
| ⬜ | `WhatsAppValidator` | `src/app/observers/whatsapp.observer.ts` |

### App — Services

| Test | Clase | Archivo |
|:----:|-------|---------|
| ⬜ | `AuthSessionService` | `src/app/services/session.service.ts` |
| ⬜ | `MessageSenderService` | `src/app/services/messaging/message-sender.service.ts` |
| ⬜ | `MetricEventBuilder` | `src/app/builders/metric-event.builder.ts` |

### Shared — Core Libs

| Test | Clase | Archivo |
|:----:|-------|---------|
| ⬜ | `JWTTokenService` | `src/shared/libs/jwt/jwt.lib.ts` |
| ⬜ | `BcryptPasswordHasher` | `src/shared/libs/bcrypt/bcrypt.lib.ts` |
| ⬜ | `CronScheduler` | `src/shared/libs/cron/cron.lib.ts` |
| ✅ | `WinstonLoggerService` | `src/shared/libs/winston/logger.lib.ts` |
| ⬜ | `DateUtils` | `src/shared/utils/dates.utils.ts` |
| ⬜ | `FileUtils` | `src/shared/utils/fil.utils.ts` |
| ✅ | `Str` / `StringChain` | `src/shared/utils/str.ts` |

---

## Tier 3 — Tracked (no bloquea push)

Estas clases requieren base de datos real, servicios externos o integración. Se miden pero no bloquean el push. Son candidatas a **tests de integración** en CI/CD.

### Infra — Prisma Repositories
`PrismaAdverseKeywordRepository`, `PrismaChatbotUserRepository`, `PrismaConversationRepository`, `PrismaFlowExecutionRepository`, `PrismaFlowMetricRepository`, `PrismaFlowScheduleRepository`, `PrismaFlowStepRepository`, `PrismaFlowRepository`, `PrismaHandoffDestinationRepository`, `PrismaJobExecutionLogRepository`, `PrismaKnowledgeBaseRepository`, `PrismaMessageRepository`, `PrismaNotificationSettingsRepository`, `PrismaSessionRepository`, `PrismaStepActionConfigRepository`, `PrismaTaskRepository`, `PrismaUserRepository`, `PrismaWebhookRepository`, `PrismaWhassaptTemplateRepository`

### Infra — AI Services (requieren AWS Bedrock)
`BedrockAIService`, `BedrockAgentService`, `ClaudeAPIService`, `AIServiceFactory`, `KnowledgeBaseLoaderService`

### Infra — External Adapters
`WhatsAppApiService`, `WhatsAppMediaService`, `WhatsAppTemplateSyncService`, `XmlRpcOdooService`, `ContactService`

### Infra — Controllers (tests de integración/e2e)
Todos los controllers bajo `src/infraestructure/http/controllers/**`

### Infra — Cache / Storage (drivers externos)
`RedisCacheDriver`, `S3StorageDriver`, `CacheManager`, `StorageManager`

---

## Configuración automática en vitest

Los globs de Tier 1 y Tier 2 están configurados en `vitest.config.mjs` bajo `coverage.include`.  
Las clases de Tier 3 están en `coverage.exclude` para evitar falsos negativos de coverage.

### Umbrales actuales (`vitest.config.mjs`)

```
Tier 1 (lines ≥ 90%, functions ≥ 85%, branches ≥ 85%)
Tier 2 (lines ≥ 70%, functions ≥ 65%, branches ≥ 65%)
Global fallback: lines 80%, functions 70%, branches 75%
```

---

## Regla de pre-push

> ⚠️ **Actualmente inactivo** — `test:coverage` está comentado en `.husky/pre-push`.

Cuando esté activo, el hook ejecutará:

```sh
npm run build || exit 1
npm run test:coverage || exit 1   # ← descomentar para activar
```

Si `test:coverage` falla (thresholds no cumplidos), el push será rechazado.

---

## Auto-sync de checkboxes

El script `scripts/sync-test-coverage.ts` escanea todos los archivos de `test/` y actualiza automáticamente el estado de cada fila:

- Si el nombre de la clase **aparece en al menos un test file** → cambia `⬜` a `✅`
- Si no aparece → deja `⬜` sin tocar

### Cómo ejecutarlo

```sh
pnpm test:sync-coverage
```

### Cuándo se ejecuta

Se corre automáticamente en cada `git push` (hook `.husky/pre-push`).  
Si actualiza filas, recordá incluir `ai-specs/specs/test-coverage-rules.md` en el commit.

> **Nota**: El script detecta la clase por nombre (`\bClassName\b`) en el contenido de los test files.  
> Esto cubre imports, instancias (`new Foo`), `describe('Foo')`, mocks, etc.

---

## Cómo agregar una nueva clase a esta regla

1. Identificar el Tier adecuado según las reglas anteriores.
2. Agregar el test correspondiente en `test/` siguiendo la misma estructura de carpetas que `src/`.
3. Actualizar este documento en el mismo PR donde se crea la clase.

> **Regla**: Toda clase nueva en `src/domain/` o `src/app/` (exceptuando interfaces y DTOs simples) **debe** aparecer en Tier 1 o Tier 2 antes de ser mergeada.
