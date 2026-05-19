# Backend Plan: Response Standardization + Routing/Adapter Decoupling + Command/Mapper Alignment

Date: 2026-03-29
Owner: Backend
Status: Proposed (no implementation in this document)

## 1. Context and problem statement

The current messaging pipeline mixes multiple response contracts and architectural styles:

- HTTP endpoints use a centralized envelope through ResponseBuilder.
- WebSocket events are emitted with ad-hoc payload shapes per event.
- Application use-cases still return custom success/error DTOs independently.
- Smart routing orchestration in app layer depends on infrastructure classes directly.
- Command pattern is partially adopted (user/flow modules) but not consistently used in messaging/AI orchestration.
- Mapper usage is fragmented (entity/query mappers exist, but there is no shared mapper strategy for transport responses).

This plan standardizes responses by transport, removes critical layering violations, and defines a migration path toward command/handler consistency.

## 2. Verified current state (from codebase)

### 2.1 HTTP is standardized
- [src/infraestructure/http/middlewares/responseBuilder.ts](src/infraestructure/http/middlewares/responseBuilder.ts)
- [src/domain/interfaces/types/http-response.type.ts](src/domain/interfaces/types/http-response.type.ts)

### 2.2 WebSocket is not standardized
- [src/infraestructure/adapters/messaging/webchat.adapter.ts](src/infraestructure/adapters/messaging/webchat.adapter.ts)
- Different emit payloads for connected/message/message:stream/bot typing events.

### 2.3 Layering and orchestration inconsistencies
- App use-case imports infra services directly:
  - [src/app/use-cases/messaging/process-incoming-message.use-case.ts](src/app/use-cases/messaging/process-incoming-message.use-case.ts)
  - Smart router from infra service, webhook service from infra service.
- Smart router implementation lives in infrastructure:
  - [src/infraestructure/services/routing/smart-router.service.ts](src/infraestructure/services/routing/smart-router.service.ts)

### 2.4 Command pattern partially adopted
- Command pattern guide exists:
  - [docs/guides/command-handler-pattern.md](docs/guides/command-handler-pattern.md)
- But messaging/AI flow still relies on direct use-case calls in several places.

### 2.5 Mapper strategy is fragmented
- Existing mapper examples:
  - [src/app/commands/user/dto/user-response.mapper.ts](src/app/commands/user/dto/user-response.mapper.ts)
  - [src/infraestructure/database/mapper/flow.mapper.ts](src/infraestructure/database/mapper/flow.mapper.ts)
- No unified mapper/envelope strategy for socket transport responses.

## 3. Target architecture

### 3.1 Do not force one envelope for all layers
Use different contract layers intentionally:

- Domain/Application result contract: operation result semantics.
- HTTP transport contract: ResponseBuilder envelope.
- WebSocket transport contract: SocketResponseBuilder envelope.

This avoids leaking transport concerns into core use-cases.

### 3.2 Introduce explicit operation result contract
Create a shared app-level generic result shape (for use-cases and handlers):

- AppResult<TData, TMeta>
  - success: boolean
  - data?: TData
  - meta?: TMeta
  - error?: AppErrorPayload

Important: Keep this as app contract, not HTTP/Socket payload directly.

### 3.3 Introduce dedicated socket response builder
Create infrastructure-level socket envelope builder:

- SocketEnvelope<T>
  - success: boolean
  - timestamp: string
  - data?: T
  - error?: string
  - code?: string

And event-specific mappers:
- ChatMessageSocketMapper
- StreamChunkSocketMapper
- TypingSocketMapper
- ConnectionSocketMapper

### 3.4 Apply port-based decoupling for router/webhook in app layer
Move app dependencies from concrete infrastructure classes to ports:

- ISmartRouterPort in domain interfaces
- IWebhookEmitterPort in domain interfaces

App use-cases depend on ports; infrastructure provides implementations.

### 3.5 Command pattern completion for messaging orchestration
Migrate messaging orchestration to command handlers incrementally:

- ProcessIncomingMessageCommand + Handler
- GenerateAIResponseCommand + Handler (or query-like variant if no mutation)

Keep backward-compatible adapter layer during migration.

## 4. Proposed phased implementation

## Phase 0: Inventory and safety checks

Files to inspect/update:
- [src/app/use-cases/ai/generate-ai-response.use-case.ts](src/app/use-cases/ai/generate-ai-response.use-case.ts)
- [src/app/use-cases/ai/generate-ai-response-stream.use-case.ts](src/app/use-cases/ai/generate-ai-response-stream.use-case.ts)
- [src/app/use-cases/messaging/process-incoming-message.use-case.ts](src/app/use-cases/messaging/process-incoming-message.use-case.ts)
- [src/infraestructure/adapters/messaging/webchat.adapter.ts](src/infraestructure/adapters/messaging/webchat.adapter.ts)

Deliverables:
- Catalog of response shapes (app/http/socket) and event names.
- Compatibility matrix for frontend consumers.

## Phase 1: App-level result contract

Create:
- src/app/contracts/app-result.contract.ts

Refactor selected outputs first (pilot):
- GenerateAIResponseUseCaseOutput -> AppResult<{ response: string; conversationId: string }, AIMeta>
- GenerateAIResponseStreamUseCaseOutput -> AppResult<{ conversationId: string; streamId: string }, AIStreamMeta>

Notes:
- Keep old interfaces as aliases temporarily to avoid broad breakage.

## Phase 2: Socket envelope builder + mappers

Create:
- src/infraestructure/realtime/socket-response.builder.ts
- src/infraestructure/realtime/mappers/chat-message.socket.mapper.ts
- src/infraestructure/realtime/mappers/stream-chunk.socket.mapper.ts
- src/infraestructure/realtime/mappers/typing.socket.mapper.ts
- src/infraestructure/realtime/mappers/connection.socket.mapper.ts

Modify:
- [src/infraestructure/adapters/messaging/webchat.adapter.ts](src/infraestructure/adapters/messaging/webchat.adapter.ts)

Outcome:
- Every socket.emit uses builder + mapper, no inline payload literals.

## Phase 3: Port extraction for router/webhook

Create ports:
- src/domain/interfaces/ports/smart-router.port.ts
- src/domain/interfaces/ports/webhook-emitter.port.ts

Implement adapters:
- src/infraestructure/services/routing/smart-router.service.ts implements ISmartRouterPort
- New infra adapter for webhook emitter implementing IWebhookEmitterPort

Refactor app use-case dependencies:
- [src/app/use-cases/messaging/process-incoming-message.use-case.ts](src/app/use-cases/messaging/process-incoming-message.use-case.ts)

Update DI:
- [src/infraestructure/DI/global-symbol.ts](src/infraestructure/DI/global-symbol.ts)
- [src/infraestructure/DI/container.ts](src/infraestructure/DI/container.ts)

## Phase 4: Command pattern migration (incremental)

Create:
- src/app/commands/messaging/process-incoming-message.command.ts
- src/app/commands/messaging/process-incoming-message.handler.ts

Controller transition:
- [src/infraestructure/http/controllers/webchat/webchat.controller.ts](src/infraestructure/http/controllers/webchat/webchat.controller.ts)
- Dispatch command through ICommandBus.

Compatibility:
- Keep existing use-case path behind feature toggle until stable.

## Phase 5: Mapper generalization strategy

Define conventions:
- App mappers convert domain/app entities to response DTOs.
- Transport mappers convert response DTOs to HTTP/Socket envelopes.

Suggested folders:
- src/app/mappers/response/
- src/infraestructure/http/mappers/
- src/infraestructure/realtime/mappers/

## 5. Acceptance criteria

1. No app layer class imports infra concrete classes for routing/webhook.
2. Socket events have one standardized envelope contract.
3. AI/messaging flows use shared app result contract.
4. New messaging path dispatches command(s) through CommandBus.
5. Existing frontend behavior remains compatible (or migration note documented per event).
6. Unit tests cover mapper/builder contracts and command handler orchestration.

## 6. Risks and mitigations

Risk: Frontend break due to socket payload shape changes.
Mitigation: Dual-format emission behind feature flag during rollout.

Risk: Large refactor blast radius in process-incoming pipeline.
Mitigation: Incremental migration with compatibility adapter and contract tests.

Risk: Over-generalization of result types reducing readability.
Mitigation: Keep generic base AppResult plus feature-specific typed data/meta interfaces.

## 7. Recommended implementation order

1. Phase 1 (AppResult contract)
2. Phase 2 (Socket builder/mappers)
3. Phase 3 (router/webhook ports)
4. Phase 4 (command migration)
5. Phase 5 (mapper conventions hardening)

## 8. Out of scope for this plan

- Full replacement of all existing command/use-case modules in one iteration.
- Rewriting legacy WhatsApp functional module under src/services/whatsapp/funcional in this same change.
- Frontend widget redesign.
