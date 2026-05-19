# Plan: Endpoints de Consulta de Conversaciones

> **Feature**: `conversation-listing`  
> **Fecha**: Abril 2026  
> **Estado**: 📝 Pendiente de implementación

---

## 📌 Resumen

Crear un módulo completo de consulta de conversaciones (`/api/conversations`) siguiendo el patrón CQRS con Queries + Reader. El frontend necesita listar, filtrar y ver detalle de conversaciones con historial de mensajes.

**No se modifica `schema.prisma`** — todo el modelo ya existe (`UserConversation`, `FlowExecutionLog`, `UserAnswer`, `ChatbotUser`).

---

## 🎯 Endpoints a crear

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/conversations` | Listar conversaciones con filtros y paginación |
| `GET` | `/api/conversations/:id` | Detalle de una conversación con historial |
| `GET` | `/api/conversations/:id/messages` | Historial de mensajes (logs) de una conversación |

---

## 🏗️ Arquitectura de archivos

```
src/
├── domain/
│   └── interfaces/
│       └── readers/
│           └── conversation-reader.port.ts          ← NUEVO (IConversationReader)
│
├── app/
│   └── queries/
│       └── conversation/
│           ├── index.ts                              ← NUEVO (barrel)
│           ├── list-conversations.query.ts           ← NUEVO
│           ├── list-conversations.handler.ts         ← NUEVO
│           ├── get-conversation-detail.query.ts      ← NUEVO
│           ├── get-conversation-detail.handler.ts    ← NUEVO
│           ├── get-conversation-messages.query.ts    ← NUEVO
│           └── get-conversation-messages.handler.ts  ← NUEVO
│
├── infraestructure/
│   ├── database/
│   │   └── persistences/
│   │       └── readers/
│   │           └── conversation.reader.ts            ← NUEVO (PrismaConversationReader)
│   ├── http/
│   │   ├── controllers/
│   │   │   ├── conversation/
│   │   │   │   └── conversation.controller.ts        ← NUEVO
│   │   │   └── schemas/
│   │   │       └── conversation.schema.ts            ← NUEVO
│   │   └── routes/
│   │       └── conversation/
│   │           └── conversation.routes.ts            ← NUEVO
│   └── DI/
│       ├── modules/
│       │   └── conversation.module.ts                ← NUEVO
│       └── global-symbol.ts                          ← MODIFICAR (agregar símbolos)
│       └── container.ts                              ← MODIFICAR (registrar módulo)

src/infraestructure/http/routes/index.ts              ← MODIFICAR (agregar ruta)
src/domain/interfaces/readers/index.ts                ← MODIFICAR (re-export)
```

---

## 📐 Diseño detallado

### 1. Domain — IConversationReader (`src/domain/interfaces/readers/conversation-reader.port.ts`)

```typescript
import { Pagination, PaginationOption } from "@/domain/value-objects/pagination.vo";

// ── Tipos de proyección ─────────────────────────────────────────────────

export interface ConversationListItem {
  id: string;
  channelType: string;
  channelUserId: string;
  mode: string;
  status: string;
  flowId: string;
  flowName: string;
  chatbotUserId: string | null;
  chatbotUserName: string | null;
  chatbotUserPhone: string | null;
  chatbotUserCrmId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  aiMessageCount: number;
  invalidAnswersCount: number;
  handoffAt: Date | null;
  handoffReason: string | null;
  updatedAt: Date;
}

export interface ConversationDetail extends ConversationListItem {
  currentStepId: string | null;
  currentStepContent: string | null;
  currentStepIndex: number | null;
  originalConversationId: string | null;
  handoffExternalId: string | null;
  visitorMetadata: Record<string, unknown> | null;
  answersCount: number;
  messagesCount: number;
}

export interface ConversationMessage {
  id: string;
  stepId: string | null;
  messageType: string;
  content: string;
  metadata: Record<string, unknown> | null;
  timestamp: Date;
}

// ── Filtros ─────────────────────────────────────────────────────────────

export interface ConversationFilters {
  status?: string;
  mode?: string;
  channelType?: string;
  flowId?: string;
  phone?: string;         // búsqueda por channelUserId (WhatsApp) o chatbotUser.phone
  crmId?: string;         // búsqueda por chatbotUser.crmId
  chatbotUserId?: string; // búsqueda directa por chatbotUserId
  search?: string;        // búsqueda libre en channelUserId, chatbotUser.name, chatbotUser.phone
  dateFrom?: Date;
  dateTo?: Date;
  hasHandoff?: boolean;   // filtro: solo conversaciones con handoff
}

// ── Interfaz ────────────────────────────────────────────────────────────

export interface IConversationReader {
  /** Listar conversaciones con filtros y paginación */
  list(
    filters: ConversationFilters,
    pagination: PaginationOption,
  ): Promise<Pagination<ConversationListItem>>;

  /** Detalle de una conversación con conteos */
  getById(id: string): Promise<ConversationDetail | null>;

  /** Historial de mensajes de una conversación */
  getMessages(
    conversationId: string,
    pagination: PaginationOption,
  ): Promise<Pagination<ConversationMessage>>;
}
```

**Notas**:
- Se define como Reader (no Repository) porque es **solo lectura** — no hay operaciones de escritura.
- Los tipos de retorno son proyecciones planas (no entidades de dominio), optimizadas para el frontend.
- Filtro `phone` busca tanto en `channelUserId` como en `chatbotUser.phone` para cubrir WhatsApp.
- Filtro `search` es free-text que busca en múltiples campos.

---

### 2. Application — Queries (`src/app/queries/conversation/`)

#### `list-conversations.query.ts`
```typescript
import { IQuery } from "@/domain/interfaces/ports";
import { ConversationFilters } from "@/domain/interfaces/readers/conversation-reader.port";
import { PaginationOption } from "@/domain/value-objects/pagination.vo";

export class ListConversationsQuery implements IQuery<unknown> {
  declare readonly _resultType: unknown;

  constructor(
    public readonly filters: ConversationFilters,
    public readonly pagination: PaginationOption,
  ) {}
}
```

#### `list-conversations.handler.ts`
```typescript
import { injectable, inject } from "tsyringe";
import { IQueryHandler } from "@/domain/interfaces/ports";
import { DI } from "@/infraestructure/DI/global-symbol";
import { IConversationReader } from "@/domain/interfaces/readers/conversation-reader.port";
import { ListConversationsQuery } from "./list-conversations.query";

@injectable()
export class ListConversationsQueryHandler
  implements IQueryHandler<ListConversationsQuery, any>
{
  constructor(
    @inject(DI.ConversationReader)
    private reader: IConversationReader,
  ) {}

  async handle(query: ListConversationsQuery): Promise<any> {
    return this.reader.list(query.filters, query.pagination);
  }
}
```

#### `get-conversation-detail.query.ts`
```typescript
import { IQuery } from "@/domain/interfaces/ports";

export class GetConversationDetailQuery implements IQuery<unknown> {
  declare readonly _resultType: unknown;
  constructor(public readonly id: string) {}
}
```

#### `get-conversation-detail.handler.ts`
```typescript
import { injectable, inject } from "tsyringe";
import { IQueryHandler } from "@/domain/interfaces/ports";
import { DI } from "@/infraestructure/DI/global-symbol";
import { IConversationReader } from "@/domain/interfaces/readers/conversation-reader.port";
import { ErrorFactory } from "@/domain/exceptions/factory/error-factory.exeption";
import { GetConversationDetailQuery } from "./get-conversation-detail.query";

@injectable()
export class GetConversationDetailQueryHandler
  implements IQueryHandler<GetConversationDetailQuery, any>
{
  constructor(
    @inject(DI.ConversationReader)
    private reader: IConversationReader,
  ) {}

  async handle(query: GetConversationDetailQuery): Promise<any> {
    const conversation = await this.reader.getById(query.id);
    if (!conversation) {
      throw ErrorFactory.create("not-found", "Conversation not found");
    }
    return conversation;
  }
}
```

#### `get-conversation-messages.query.ts`
```typescript
import { IQuery } from "@/domain/interfaces/ports";
import { PaginationOption } from "@/domain/value-objects/pagination.vo";

export class GetConversationMessagesQuery implements IQuery<unknown> {
  declare readonly _resultType: unknown;
  constructor(
    public readonly conversationId: string,
    public readonly pagination: PaginationOption,
  ) {}
}
```

#### `get-conversation-messages.handler.ts`
```typescript
import { injectable, inject } from "tsyringe";
import { IQueryHandler } from "@/domain/interfaces/ports";
import { DI } from "@/infraestructure/DI/global-symbol";
import { IConversationReader } from "@/domain/interfaces/readers/conversation-reader.port";
import { ErrorFactory } from "@/domain/exceptions/factory/error-factory.exeption";
import { GetConversationMessagesQuery } from "./get-conversation-messages.query";

@injectable()
export class GetConversationMessagesQueryHandler
  implements IQueryHandler<GetConversationMessagesQuery, any>
{
  constructor(
    @inject(DI.ConversationReader)
    private reader: IConversationReader,
  ) {}

  async handle(query: GetConversationMessagesQuery): Promise<any> {
    // Verify conversation exists first
    const conversation = await this.reader.getById(query.conversationId);
    if (!conversation) {
      throw ErrorFactory.create("not-found", "Conversation not found");
    }
    return this.reader.getMessages(query.conversationId, query.pagination);
  }
}
```

#### `index.ts`
```typescript
export * from "./list-conversations.query";
export * from "./list-conversations.handler";
export * from "./get-conversation-detail.query";
export * from "./get-conversation-detail.handler";
export * from "./get-conversation-messages.query";
export * from "./get-conversation-messages.handler";
```

---

### 3. Infrastructure — Schema Zod (`src/infraestructure/http/controllers/schemas/conversation.schema.ts`)

```typescript
import { z } from "zod";
import { basePagination, UUIDParamsSchema } from "./common.schema";
import { registry } from "@/shared/swagger/openapi-registry";

// ── Filtros de listado ──────────────────────────────────────────────────
export const ConversationListQuerySchema = z.object({
  query: basePagination.extend({
    status: z.enum([
      "in_progress", "completed", "abandoned",
      "stucked", "restarted", "adverse_event_detected",
    ]).optional(),
    mode: z.enum(["FLOW", "AI", "HUMAN"]).optional(),
    channelType: z.enum(["WHATSAPP", "WEBCHAT", "TELEGRAM", "SMS"]).optional(),
    flowId: z.string().uuid().optional(),
    phone: z.string().max(30).optional(),
    crmId: z.string().max(100).optional(),
    chatbotUserId: z.string().uuid().optional(),
    search: z.string().max(100).optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
    hasHandoff: z.coerce.boolean().optional(),
  }),
});

// ── Params ──────────────────────────────────────────────────────────────
export const ConversationParamsSchema = z.object({
  params: UUIDParamsSchema,
});

export const ConversationMessagesQuerySchema = z.object({
  params: UUIDParamsSchema,
  query: basePagination,
});

// ── Types ───────────────────────────────────────────────────────────────
export type ConversationListQueryDTO = z.infer<typeof ConversationListQuerySchema>["query"];

// ── OpenAPI registrations ───────────────────────────────────────────────
registry.register("ConversationListQuery", ConversationListQuerySchema.shape.query);
```

---

### 4. Infrastructure — Controller (`src/infraestructure/http/controllers/conversation/conversation.controller.ts`)

```typescript
import { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { DI } from "@/infraestructure/DI/global-symbol";
import { IQueryBus } from "@/domain/interfaces/ports";
import { SuccessFactory } from "@/domain/exceptions";
import { ResponseBuilder } from "@/infraestructure/http/middlewares/response-builder";
import { QueryMapper } from "@/infraestructure/database/persistences/mapper/pagination.mapper";
import {
  ConversationListQuerySchema,
  ConversationParamsSchema,
  ConversationMessagesQuerySchema,
} from "../schemas/conversation.schema";
import { ListConversationsQuery } from "@/app/queries/conversation";
import { GetConversationDetailQuery } from "@/app/queries/conversation";
import { GetConversationMessagesQuery } from "@/app/queries/conversation";
import { PaginationOption } from "@/domain/value-objects/pagination.vo";

@injectable()
export class ConversationController {
  constructor(
    @inject(DI.QueryBus) private queryBus: IQueryBus,
  ) {}

  list = async (req: Request, res: Response) => {
    const { query } = ConversationListQuerySchema.parse({ query: req.query });

    const { page, pageSize, ...filters } = query;
    const pagination = new PaginationOption(page, pageSize, "desc");

    const result = await this.queryBus.query(
      new ListConversationsQuery(filters, pagination),
    );

    ResponseBuilder.sendSuccess(res, SuccessFactory.create("processed", result));
  };

  getById = async (req: Request, res: Response) => {
    const { params } = ConversationParamsSchema.parse({ params: req.params });

    const result = await this.queryBus.query(
      new GetConversationDetailQuery(params.id),
    );

    ResponseBuilder.sendSuccess(res, SuccessFactory.create("retrieved", result));
  };

  getMessages = async (req: Request, res: Response) => {
    const { params, query } = ConversationMessagesQuerySchema.parse({
      params: req.params,
      query: req.query,
    });

    const pagination = new PaginationOption(query.page, query.pageSize, "asc");

    const result = await this.queryBus.query(
      new GetConversationMessagesQuery(params.id, pagination),
    );

    ResponseBuilder.sendSuccess(res, SuccessFactory.create("retrieved", result));
  };
}
```

---

### 5. Infrastructure — Routes (`src/infraestructure/http/routes/conversation/conversation.routes.ts`)

```typescript
import { Router } from "express";
import { container } from "@/infraestructure/DI/container";
import { DI } from "@/infraestructure/DI/global-symbol";
import { AuthGuard } from "@/infraestructure/http/middlewares";
import { ConversationController } from "../../controllers/conversation/conversation.controller";
import { documentRoute } from "@/shared/swagger/swagger.helper";
import {
  ConversationListQuerySchema,
  ConversationMessagesQuerySchema,
} from "../../controllers/schemas/conversation.schema";
import { UUIDParamsSchema } from "../../controllers/schemas/common.schema";

export class ConversationRoute {
  private readonly guard: AuthGuard;
  private readonly controller: ConversationController;

  constructor() {
    this.guard = container.resolve<AuthGuard>(DI.AuthGuard);
    this.controller = container.resolve<ConversationController>(
      DI.ConversationController,
    );
  }

  get routes(): Router {
    const router = Router();

    documentRoute({
      path: "/conversations",
      method: "get",
      tag: "Conversations",
      summary: "Listar conversaciones con filtros y paginación",
      hasAuth: true,
    });
    router.get("/", this.guard.validate, this.controller.list);

    documentRoute({
      path: "/conversations/{id}",
      method: "get",
      tag: "Conversations",
      summary: "Obtener detalle de una conversación",
      params: UUIDParamsSchema,
      hasAuth: true,
      errors: ["not-found"],
    });
    router.get("/:id", this.guard.validate, this.controller.getById);

    documentRoute({
      path: "/conversations/{id}/messages",
      method: "get",
      tag: "Conversations",
      summary: "Obtener historial de mensajes de una conversación",
      params: UUIDParamsSchema,
      hasAuth: true,
      errors: ["not-found"],
    });
    router.get("/:id/messages", this.guard.validate, this.controller.getMessages);

    return router;
  }
}
```

---

### 6. Infrastructure — PrismaConversationReader (`src/infraestructure/database/persistences/readers/conversation.reader.ts`)

```typescript
import { injectable } from "tsyringe";
import {
  IConversationReader,
  ConversationListItem,
  ConversationDetail,
  ConversationMessage,
  ConversationFilters,
} from "@/domain/interfaces/readers/conversation-reader.port";
import {
  Pagination,
  PaginationOption,
} from "@/domain/value-objects/pagination.vo";
import { prisma } from "@/infraestructure/database/facades";
import { Prisma } from "@prisma/client";

@injectable()
export class PrismaConversationReader implements IConversationReader {

  async list(
    filters: ConversationFilters,
    pagination: PaginationOption,
  ): Promise<Pagination<ConversationListItem>> {
    const where = this.buildWhere(filters);

    const [data, count] = await Promise.all([
      prisma.userConversation.findMany({
        where,
        include: {
          flow: { select: { id: true, name: true } },
          chatbotUser: {
            select: { id: true, name: true, phone: true, crmId: true },
          },
        },
        orderBy: { startedAt: "desc" },
        skip: pagination.offSet(),
        take: pagination.pageSize,
      }),
      prisma.userConversation.count({ where }),
    ]);

    const items: ConversationListItem[] = data.map((c) => ({
      id: c.id,
      channelType: c.channelType,
      channelUserId: c.channelUserId,
      mode: c.mode,
      status: c.status,
      flowId: c.flowId,
      flowName: c.flow.name,
      chatbotUserId: c.chatbotUserId,
      chatbotUserName: c.chatbotUser?.name ?? null,
      chatbotUserPhone: c.chatbotUser?.phone ?? null,
      chatbotUserCrmId: c.chatbotUser?.crmId ?? null,
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      aiMessageCount: c.aiMessageCount,
      invalidAnswersCount: c.invalidAnswersCount,
      handoffAt: c.handoffAt,
      handoffReason: c.handoffReason,
      updatedAt: c.updatedAt,
    }));

    return Pagination.create(items, pagination, count);
  }

  async getById(id: string): Promise<ConversationDetail | null> {
    const c = await prisma.userConversation.findUnique({
      where: { id },
      include: {
        flow: { select: { id: true, name: true } },
        chatbotUser: {
          select: { id: true, name: true, phone: true, crmId: true },
        },
        currentStep: {
          select: { id: true, content: true, stepIndex: true },
        },
        _count: {
          select: { userAnswers: true, flowLogs: true },
        },
      },
    });

    if (!c) return null;

    return {
      id: c.id,
      channelType: c.channelType,
      channelUserId: c.channelUserId,
      mode: c.mode,
      status: c.status,
      flowId: c.flowId,
      flowName: c.flow.name,
      chatbotUserId: c.chatbotUserId,
      chatbotUserName: c.chatbotUser?.name ?? null,
      chatbotUserPhone: c.chatbotUser?.phone ?? null,
      chatbotUserCrmId: c.chatbotUser?.crmId ?? null,
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      aiMessageCount: c.aiMessageCount,
      invalidAnswersCount: c.invalidAnswersCount,
      handoffAt: c.handoffAt,
      handoffReason: c.handoffReason,
      updatedAt: c.updatedAt,
      currentStepId: c.currentStepId,
      currentStepContent: c.currentStep?.content ?? null,
      currentStepIndex: c.currentStep?.stepIndex ?? null,
      originalConversationId: c.originalConversationId,
      handoffExternalId: c.handoffExternalId,
      visitorMetadata: c.visitorMetadata as Record<string, unknown> | null,
      answersCount: c._count.userAnswers,
      messagesCount: c._count.flowLogs,
    };
  }

  async getMessages(
    conversationId: string,
    pagination: PaginationOption,
  ): Promise<Pagination<ConversationMessage>> {
    const where = { conversationId };

    const [data, count] = await Promise.all([
      prisma.flowExecutionLog.findMany({
        where,
        select: {
          id: true,
          stepId: true,
          messageType: true,
          content: true,
          metadata: true,
          timestamp: true,
        },
        orderBy: { timestamp: "asc" },
        skip: pagination.offSet(),
        take: pagination.pageSize,
      }),
      prisma.flowExecutionLog.count({ where }),
    ]);

    const items: ConversationMessage[] = data.map((m) => ({
      id: m.id,
      stepId: m.stepId,
      messageType: m.messageType,
      content: m.content,
      metadata: m.metadata as Record<string, unknown> | null,
      timestamp: m.timestamp,
    }));

    return Pagination.create(items, pagination, count);
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private buildWhere(
    filters: ConversationFilters,
  ): Prisma.UserConversationWhereInput {
    const where: Prisma.UserConversationWhereInput = {};

    if (filters.status) where.status = filters.status as any;
    if (filters.mode) where.mode = filters.mode as any;
    if (filters.channelType) where.channelType = filters.channelType as any;
    if (filters.flowId) where.flowId = filters.flowId;
    if (filters.chatbotUserId) where.chatbotUserId = filters.chatbotUserId;

    // Filtro por teléfono: busca en channelUserId (WhatsApp) o chatbotUser.phone
    if (filters.phone) {
      where.OR = [
        { channelUserId: { contains: filters.phone, mode: "insensitive" } },
        { chatbotUser: { phone: { contains: filters.phone, mode: "insensitive" } } },
      ];
    }

    // Filtro por CRM ID
    if (filters.crmId) {
      where.chatbotUser = {
        ...((where.chatbotUser as object) ?? {}),
        crmId: { contains: filters.crmId, mode: "insensitive" },
      };
    }

    // Búsqueda libre
    if (filters.search) {
      const searchConditions: Prisma.UserConversationWhereInput[] = [
        { channelUserId: { contains: filters.search, mode: "insensitive" } },
        { chatbotUser: { name: { contains: filters.search, mode: "insensitive" } } },
        { chatbotUser: { phone: { contains: filters.search, mode: "insensitive" } } },
        { chatbotUser: { email: { contains: filters.search, mode: "insensitive" } } },
      ];
      // Si ya hay OR por phone, combinar
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: searchConditions }];
        delete where.OR;
      } else {
        where.OR = searchConditions;
      }
    }

    // Rango de fechas
    if (filters.dateFrom || filters.dateTo) {
      where.startedAt = {};
      if (filters.dateFrom) where.startedAt.gte = filters.dateFrom;
      if (filters.dateTo) where.startedAt.lte = filters.dateTo;
    }

    // Solo con handoff
    if (filters.hasHandoff === true) {
      where.handoffAt = { not: null };
    } else if (filters.hasHandoff === false) {
      where.handoffAt = null;
    }

    return where;
  }
}
```

**Notas importantes del Reader**:
- El Reader **no usa `executeSafe`** porque no es un Repository — es un patrón de solo lectura directa. Si falla, el ErrorHandler global captura el error.
- Usa `prisma` importado directamente del facade (mismo patrón que `PrismaFlowReader` y `PrismaStepActionReader`).
- `buildWhere` construye el `where` dinámicamente para que Prisma compile solo las condiciones activas.
- Los filtros `phone` y `search` no conflictan: `phone` usa `OR` simple, `search` es más amplio. Si ambos vienen, se combinan con `AND`.

---

### 7. Infrastructure — DI Module (`src/infraestructure/DI/modules/conversation.module.ts`)

```typescript
import { DependencyContainer } from "tsyringe";
import { DI } from "../global-symbol";
import { IConversationReader } from "@/domain/interfaces/readers/conversation-reader.port";
import { PrismaConversationReader } from "@/infraestructure/database/persistences/readers/conversation.reader";
import { ConversationController } from "@/infraestructure/http/controllers/conversation/conversation.controller";

// Query Handlers
import {
  ListConversationsQueryHandler,
  GetConversationDetailQueryHandler,
  GetConversationMessagesQueryHandler,
} from "@/app/queries/conversation";

export function registerConversationModule(container: DependencyContainer): void {
  // Reader
  container.registerSingleton<IConversationReader>(
    DI.ConversationReader,
    PrismaConversationReader,
  );

  // Query Handlers (convention: ClassName → "ClassNameHandler" token)
  container.register("ListConversationsQueryHandler", ListConversationsQueryHandler);
  container.register("GetConversationDetailQueryHandler", GetConversationDetailQueryHandler);
  container.register("GetConversationMessagesQueryHandler", GetConversationMessagesQueryHandler);

  // Controller
  container.register<ConversationController>(
    DI.ConversationController,
    ConversationController,
  );
}
```

---

### 8. Modificaciones a archivos existentes

#### `src/infraestructure/DI/global-symbol.ts` — agregar símbolos

```typescript
// ── Conversations ───────────────────────────────────────────────
ConversationReader: Symbol.for("ConversationReader"),
ConversationController: Symbol.for("ConversationController"),
```

Colocar los símbolos en la sección de **Readers** (para `ConversationReader`) y en una nueva sección **Conversations** (para el Controller), o ambos en una sección nueva.

#### `src/infraestructure/DI/container.ts` — registrar módulo

```typescript
import { registerConversationModule } from "./modules/conversation.module";

// Agregar después de registerMessagingModule:
registerConversationModule(container);
```

#### `src/infraestructure/http/routes/index.ts` — agregar ruta

```typescript
import { ConversationRoute } from "./conversation/conversation.routes";

// En el router:
router.use("/conversations", new ConversationRoute().routes);
```

#### `src/domain/interfaces/readers/index.ts` — re-export

```typescript
export * from "./conversation-reader.port";
```

---

## 🔍 Filtros disponibles para el frontend

| Query Param | Tipo | Ejemplo | Descripción |
|-------------|------|---------|-------------|
| `page` | number | `1` | Página (default: 1) |
| `pageSize` | number | `20` | Items por página (default: 10, max: 500) |
| `status` | enum | `in_progress` | Filtrar por estado |
| `mode` | enum | `AI` | Filtrar por modo (FLOW, AI, HUMAN) |
| `channelType` | enum | `WHATSAPP` | Filtrar por canal |
| `flowId` | uuid | `550e8400-...` | Filtrar por flow específico |
| `phone` | string | `+573001234567` | Buscar por teléfono (en channelUserId o chatbotUser.phone) |
| `crmId` | string | `CRM-12345` | Buscar por ID del CRM |
| `chatbotUserId` | uuid | `550e8400-...` | Buscar por usuario de chatbot |
| `search` | string | `Juan` | Búsqueda libre en nombre, teléfono, email, channelUserId |
| `dateFrom` | date | `2026-01-01` | Desde fecha (startedAt >= dateFrom) |
| `dateTo` | date | `2026-04-14` | Hasta fecha (startedAt <= dateTo) |
| `hasHandoff` | boolean | `true` | Solo conversaciones con/sin handoff |

**Ejemplo del frontend**:
```
GET /api/conversations?status=in_progress&channelType=WHATSAPP&phone=+573001234567&page=1&pageSize=20
```

---

## 📋 Commits sugeridos

| # | Tipo | Mensaje | Archivos |
|---|------|---------|----------|
| 1 | `feat(domain)` | `feat(domain): add IConversationReader port` | `conversation-reader.port.ts`, `readers/index.ts` |
| 2 | `feat(app)` | `feat(app): add conversation listing queries` | `queries/conversation/*.ts` |
| 3 | `feat(infra)` | `feat(infra): add PrismaConversationReader` | `readers/conversation.reader.ts` |
| 4 | `feat(api)` | `feat(api): add conversation listing endpoints` | `schema`, `controller`, `routes`, `DI module`, `global-symbol`, `container`, `routes/index` |

---

## ⚠️ Notas importantes

1. **No se necesita migración de Prisma** — todos los modelos (`UserConversation`, `FlowExecutionLog`, `ChatbotUser`) ya existen.
2. **No se modifica el `ConversationRepository`** existente — este queda para operaciones de escritura. El nuevo `IConversationReader` es solo lectura (patrón CQRS).
3. **Índices existentes** cubren los filtros principales: `@@index([channelType, channelUserId])`, `@@index([flowId])`, `@@index([chatbotUserId])`. Si se detecta lentitud en búsquedas por `search`, considerar índices GIN en el futuro.
4. **El filtro `phone` no conflicta con `search`** — si ambos vienen, `phone` filtra estrictamente y `search` amplía la búsqueda.
5. **Actualizar `ai-specs/specs/api-spec.yml`** para incluir los 3 nuevos endpoints en la sección Conversations.
6. **Orden por defecto**: listado por `startedAt DESC` (más reciente primero), mensajes por `timestamp ASC` (orden cronológico).
