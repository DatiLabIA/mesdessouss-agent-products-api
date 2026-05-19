---
feature: multi-channel-multi-line-system
type: backend
status: pending
priority: high
estimated_complexity: very-high
created: 2026-04-20
author: backend-developer
---

# 🚀 Sistema Multi-Línea WhatsApp + Multi-Widget WebChat + Variables Dinámicas

> ⚠️ **IMPORTANTE:** Este plan debe leerse junto con [`multi-channel-multi-line-system_GAPS.md`](./multi-channel-multi-line-system_GAPS.md) que detalla **13 gaps críticos** identificados al revisar el código existente.

> 🚨 **DESCUBRIMIENTO CRÍTICO:** El widget actual (`datihub_frontend/public/chatbot-widget.js`) usa **REST + Polling**, NO Socket.IO. Faltan 3 endpoints REST que el widget espera. Ver **GAP #0** en el documento de GAPS antes de implementar.

## 📋 Resumen Ejecutivo

Implementación de un sistema robusto que permite:
1. **Multi-línea WhatsApp**: Gestión de múltiples cuentas de WhatsApp Business para un mismo cliente
2. **Multi-widget WebChat**: Configuración de múltiples widgets con comportamientos y webhooks diferentes
3. **Webhooks con filtrado granular**: Filtros por flow, canal, widget, y línea de WhatsApp
4. **Variables dinámicas en plantillas**: Sistema completo de resolución de variables para plantillas de Meta

### Documentos Relacionados

- 📄 **[GAPS Críticos](./multi-channel-multi-line-system_GAPS.md)**: 13 gaps identificados que complementan este plan
- 🔴 **Bloqueadores**: GAP #1 (webhook routing), #2 (widgetId), #3 (template relation), #4 (migración)
- 🟡 **Importantes**: GAP #5 (widget script), #6 (use case update), #7 (CORS), #8 (encryption), #9 (cache)
- 🟢 **Mejoras**: GAP #10 (auto-calc), #11 (metrics), #12 (cloning), #13 (webhook helper)

### Motivación

**Restricciones de WhatsApp Business:**
- Meta permite solo **1 webhook por línea de WhatsApp**
- Un cliente puede necesitar múltiples líneas (Soporte, Ventas, Marketing)
- Cada línea tiene credenciales y webhooks independientes

**Necesidades de WebChat:**
- Múltiples widgets para diferentes campañas (Promociones, Soporte, Contacto)
- Cada widget con flow inicial diferente y webhooks específicos
- Sin restricción de webhooks (a diferencia de WhatsApp)

**Limitación Actual de Plantillas:**
- Variables solo en el body (hardcodeadas en código)
- No soporta header, footer, ni button variables
- Sin configuración dinámica desde el admin

---

## 🎯 Objetivos Técnicos

### ✅ Casos de Uso Soportados

| Escenario | Solución |
|-----------|----------|
| Cliente con 3 líneas de WhatsApp (soporte, ventas, marketing) | 3 registros `WhatsAppAccount` con diferentes `phoneNumberId` |
| Cada línea con webhook diferente en Meta | Cada `WhatsAppAccount.webhookUrl` apunta a endpoint único |
| Widget "promo" inicia con flow de descuentos | `WebChatWidget.initialFlowId = flow-descuentos` |
| Webhook solo para widget "promo" | `Webhook.widgetIds = ["promo"]` |
| Webhook solo cuando se completa flow de ventas | `Webhook.flowIds = ["flow-ventas"]` + `events = [FLOW_COMPLETED]` |
| Flow con plantilla solo disponible en línea "soporte" | `Flow.compatibleWhatsAppAccountIds = ["wa-soporte"]` |
| Plantilla con variables en header, body, footer y botones | `FlowStep.templateParams` con mapeo dinámico |

---

## 📐 Análisis del Estado Actual

### Schema Prisma Existente

**✅ Ya tenemos:**
- `ChannelType` enum: `WHATSAPP`, `WEBCHAT`, `TELEGRAM`, `SMS`
- `UserConversation`: Identificación por `channelType` + `channelUserId`
- `Webhook`: Eventos y URL, pero sin filtros granulares
- `WhatsAppTemplate`: Plantillas, pero vinculadas solo por `name` (sin línea)
- `Flow` y `FlowStep`: Sistema de flujos existente

**❌ NO tenemos:**
- Modelo para gestionar múltiples líneas de WhatsApp (`WhatsAppAccount`)
- Modelo para gestionar múltiples widgets de WebChat (`WebChatWidget`)
- Filtros en `Webhook` por flow, canal, widget o línea
- Vinculación de `UserConversation` con línea/widget específico
- Sistema de variables dinámicas en `FlowStep.templateParams`
- Relación entre `WhatsAppTemplate` y línea específica
- Compatibilidad calculada de flows con líneas

### Código Existente

**Archivos Clave a Modificar:**
- `prisma/schema.prisma`: +4 modelos nuevos, actualizaciones en 4 existentes
- `src/infraestructure/adapters/messaging/whatsapp.adapter.ts`: Soporte multi-cuenta
- `src/infraestructure/services/webhook/webhook.service.ts`: Filtrado granular
- `src/infraestructure/services/messaging/message-sender.service.ts`: Resolución de variables
- `src/infraestructure/config/env.ts`: Multi-línea config (opcional, puede quedar en DB)

**Patrones Actuales:**
- WhatsAppAdapter es singleton (línea única)
- Webhook.emit() filtra solo por `WebhookEvent`
- FlowStep.templateName apunta a WhatsAppTemplate.name (sin línea)
- sendTemplateMessage() solo soporta variables en body

---

## 🗄️ Cambios en Schema Prisma

### 1️⃣ Nuevo Modelo: `WhatsAppAccount`

```prisma
model WhatsAppAccount {
  id String @id @default(uuid())
  
  // Identificación
  name        String @db.VarChar(255)  // "Línea Soporte", "Línea Ventas"
  slug        String @unique           // "soporte", "ventas" (para URLs)
  description String? @db.Text
  
  // Credenciales de Meta Business API
  phoneNumberId String @unique @db.VarChar(100)  // WA_PHONE_NUMBER_ID
  accessToken   String @db.VarChar(500)          // CLOUD_API_ACCESS_TOKEN (encrypted)
  businessId    String @db.VarChar(100)          // WHATSAPP_BUSINESS_ID
  apiVersion    String @default("v21.0")         // CLOUD_API_VERSION
  
  // Webhook configurado en Meta
  webhookUrl         String?  @db.VarChar(500)  // URL configurada en Meta
  webhookVerifyToken String?  @db.VarChar(255)  // Token de verificación
  
  // Configuración
  isActive  Boolean @default(true)
  isPrimary Boolean @default(false)  // Línea por defecto
  
  // Metadatos
  metadata Json? // Configuración adicional flexible
  
  // Relaciones
  templates     WhatsAppTemplate[]   @relation("WhatsAppAccountTemplates")
  conversations UserConversation[]   @relation("WhatsAppAccountConversations")
  webhooks      Webhook[]            @relation("WhatsAppAccountWebhooks")
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  @@index([isActive])
  @@index([phoneNumberId])
  @@index([slug])
}
```

### 2️⃣ Nuevo Modelo: `WebChatWidget`

```prisma
model WebChatWidget {
  id String @id @default(uuid())
  
  // Identificación
  name        String @db.VarChar(255)  // "Widget Promociones"
  widgetId    String @unique           // "promo" (usado en embed code)
  description String? @db.Text
  
  // Configuración de comportamiento
  initialFlowId String?  // Flow que inicia automáticamente
  initialFlow   Flow?    @relation("WidgetInitialFlow", fields: [initialFlowId], references: [id])
  
  autoStartFlow Boolean @default(false)  // Iniciar sin mensaje del usuario
  
  // Apariencia (JSON flexible)
  theme          Json?   // {primaryColor, logo, position, etc.}
  welcomeMessage String? @db.Text
  placeholder    String? @default("Escribe un mensaje...")
  
  // Seguridad (CORS)
  allowedOrigins Json?   // ["https://tienda.com"]
  
  // Configuración
  isActive Boolean @default(true)
  
  // Metadatos
  metadata Json?
  
  // Relaciones
  conversations UserConversation[] @relation("WebChatWidgetConversations")
  webhooks      Webhook[]          @relation("WebChatWidgetWebhooks")
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  @@index([isActive])
  @@index([widgetId])
}
```

### 3️⃣ Actualizar Modelo: `Webhook`

```prisma
model Webhook {
  id       String        @id @default(uuid())
  name     String        @db.VarChar(255)
  url      String        @db.VarChar(500)
  events   Json // Array de WebhookEvent
  secret   String?       @db.VarChar(255)
  isActive Boolean       @default(true)
  status   WebhookStatus @default(ACTIVE)

  // === NUEVOS FILTROS DE ACTIVACIÓN ===
  
  // Filtro por flujos específicos (null = todos)
  flowIds Json? // ["flow-uuid-1", "flow-uuid-2"]
  
  // Filtro por canales (null = todos)
  channelTypes Json? // ["WEBCHAT", "WHATSAPP"]
  
  // Filtro por widgets específicos (solo WEBCHAT, null = todos)
  widgetIds         Json?          // ["promo", "support"]
  widgetRelations   WebChatWidget[] @relation("WebChatWidgetWebhooks")
  
  // Filtro por líneas de WhatsApp (solo WHATSAPP, null = todos)
  whatsappAccountIds       Json?             // ["wa-uuid-1"]
  whatsappAccountRelations WhatsAppAccount[] @relation("WhatsAppAccountWebhooks")

  // Configuración existente
  retryAttempts Int   @default(3)
  timeout       Int   @default(10000)
  headers       Json?

  // Metadata
  lastTriggeredAt DateTime?
  failureCount    Int       @default(0)
  successCount    Int       @default(0)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  logs WebhookLog[]

  @@index([isActive, status])
  @@index([flowIds])
  @@index([channelTypes])
}
```

### 4️⃣ Actualizar Modelo: `UserConversation`

```prisma
model UserConversation {
  id String @id @default(uuid())

  // Identificación multi-canal existente
  channelType   ChannelType
  channelUserId String
  
  // === NUEVAS RELACIONES OPCIONALES ===
  
  // Para WHATSAPP: línea que originó esta conversación
  whatsappAccountId String?
  whatsappAccount   WhatsAppAccount? @relation("WhatsAppAccountConversations", fields: [whatsappAccountId], references: [id])
  
  // Para WEBCHAT: widget que originó esta conversación
  widgetId String?
  widget   WebChatWidget? @relation("WebChatWidgetConversations", fields: [widgetId], references: [id])
  
  // ... resto de campos existentes (flowId, mode, status, etc.) ...

  @@index([whatsappAccountId])
  @@index([widgetId])
  @@index([channelType, channelUserId])
}
```

### 5️⃣ Actualizar Modelo: `WhatsAppTemplate`

```prisma
model WhatsAppTemplate {
  id   String @id @default(uuid())
  name String @db.VarChar(255)  // "welcome_promo"
  
  // === VINCULACIÓN CON LÍNEA ===
  whatsappAccountId String
  whatsappAccount   WhatsAppAccount @relation("WhatsAppAccountTemplates", fields: [whatsappAccountId], references: [id], onDelete: Cascade)
  
  // === AGRUPACIÓN LÓGICA (HÍBRIDO) ===
  logicalGroup String? @db.VarChar(255)  // "welcome_promo" (igual en múltiples líneas)
  
  // Sincronización con Meta
  metaTemplateId String? @db.VarChar(255)  // ID en Meta
  metaStatus     String? @db.VarChar(50)   // APPROVED, PENDING, REJECTED
  
  // Contenido de la plantilla
  language String @db.VarChar(10)
  category String @db.VarChar(50)
  body     String @db.Text
  header   String? @db.Text
  footer   String? @db.Text
  buttons  Json?
  
  isActive  Boolean @default(true)
  steps     FlowStep[] @relation("TemplateUsedInSteps")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  @@unique([name, whatsappAccountId])  // Una plantilla es única por nombre + línea
  @@index([whatsappAccountId])
  @@index([logicalGroup])
  @@index([metaStatus])
}
```

### 6️⃣ Actualizar Modelo: `FlowStep`

```prisma
model FlowStep {
  // ... campos existentes ...
  
  templateName String? @db.VarChar(255)
  
  // === CONFIGURACIÓN DE VARIABLES DINÁMICAS ===
  templateParams Json?
  /*
  Estructura esperada:
  {
    "body": [
      { "source": "user", "field": "name" },           // {{1}} = Nombre del usuario
      { "source": "answer", "stepId": "step-uuid" },   // {{2}} = Respuesta del step
      { "source": "static", "value": "DatiHub" }       // {{3}} = Valor fijo
    ],
    "header": [
      { "source": "answer", "stepId": "step-uuid" }    // {{1}} en header
    ],
    "buttons": [
      {
        "index": 0,
        "urlParam": { "source": "conversation", "field": "id" }
      }
    ]
  }
  */
  
  // ... resto de campos existentes ...
}
```

### 7️⃣ Actualizar Modelo: `Flow`

```prisma
model Flow {
  // ... campos existentes ...
  
  // === COMPATIBILIDAD CON LÍNEAS (CALCULADO) ===
  requiresTemplates               Boolean @default(false)
  compatibleWhatsAppAccountIds    Json?   // ["wa-uuid-1", "wa-uuid-2"] o null = todas
  requiredTemplateLogicalGroups   Json?   // ["welcome_promo", "confirm_order"]
  
  // Relación inversa con WebChatWidget
  widgetInitialFlows WebChatWidget[] @relation("WidgetInitialFlow")
  
  // ... resto de campos existentes ...
}
```

---

## 🔧 Comando de Migración Prisma

```bash
npx prisma migrate dev --name add_multi_channel_multi_line_system
```

**Pasos post-migración:**
1. Ejecutar seed para crear cuentas/widgets iniciales (opcional)
2. Migrar datos existentes si hay conversaciones activas
3. Actualizar `ai-specs/specs/data-model.md` con nuevos modelos

---

## 🏛️ Capa de Dominio

### 1️⃣ Entidades

#### `WhatsAppAccountEntity`

**Ubicación:** `src/domain/entities/whatsapp-account.entity.ts`

```typescript
import { ErrorFactory } from "@/domain/exceptions/error.factory";

export interface IWhatsAppAccount {
  id: string;
  name: string;
  slug: string;
  description?: string;
  phoneNumberId: string;
  accessToken: string;
  businessId: string;
  apiVersion: string;
  webhookUrl?: string;
  webhookVerifyToken?: string;
  isActive: boolean;
  isPrimary: boolean;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export class WhatsAppAccountEntity {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly slug: string,
    public readonly phoneNumberId: string,
    public readonly accessToken: string,
    public readonly businessId: string,
    public readonly apiVersion: string,
    public readonly isActive: boolean,
    public readonly isPrimary: boolean,
    public readonly description?: string,
    public readonly webhookUrl?: string,
    public readonly webhookVerifyToken?: string,
    public readonly metadata?: Record<string, any>,
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date
  ) {
    this.validate();
  }

  private validate(): void {
    if (!this.name?.trim()) {
      throw ErrorFactory.create("validation", "El nombre de la cuenta es requerido");
    }
    if (!this.slug?.trim() || !/^[a-z0-9-]+$/.test(this.slug)) {
      throw ErrorFactory.create("validation", "El slug debe contener solo letras minúsculas, números y guiones");
    }
    if (!this.phoneNumberId?.trim()) {
      throw ErrorFactory.create("validation", "El phoneNumberId de Meta es requerido");
    }
    if (!this.accessToken?.trim()) {
      throw ErrorFactory.create("validation", "El accessToken es requerido");
    }
    if (!this.businessId?.trim()) {
      throw ErrorFactory.create("validation", "El businessId es requerido");
    }
  }
}
```

#### `WhatsAppAccountBuilder`

**Ubicación:** `src/domain/builders/whatsapp-account.builder.ts`

> **Justificación:** Entidad con 11 atributos > 5 → requiere Builder según estándares.

```typescript
import { WhatsAppAccountEntity } from "../entities/whatsapp-account.entity";
import { UUID } from "../value-objects/uuid.vo";

export class WhatsAppAccountBuilder {
  private id: string = UUID.generate();
  private name: string = "";
  private slug: string = "";
  private description?: string;
  private phoneNumberId: string = "";
  private accessToken: string = "";
  private businessId: string = "";
  private apiVersion: string = "v21.0";
  private webhookUrl?: string;
  private webhookVerifyToken?: string;
  private isActive: boolean = true;
  private isPrimary: boolean = false;
  private metadata?: Record<string, any>;
  private createdAt?: Date;
  private updatedAt?: Date;

  withId(id: string): this {
    this.id = id;
    return this;
  }

  withName(name: string): this {
    this.name = name;
    return this;
  }

  withSlug(slug: string): this {
    this.slug = slug;
    return this;
  }

  withDescription(description: string): this {
    this.description = description;
    return this;
  }

  withPhoneNumberId(phoneNumberId: string): this {
    this.phoneNumberId = phoneNumberId;
    return this;
  }

  withAccessToken(accessToken: string): this {
    this.accessToken = accessToken;
    return this;
  }

  withBusinessId(businessId: string): this {
    this.businessId = businessId;
    return this;
  }

  withApiVersion(apiVersion: string): this {
    this.apiVersion = apiVersion;
    return this;
  }

  withWebhookUrl(webhookUrl: string): this {
    this.webhookUrl = webhookUrl;
    return this;
  }

  withWebhookVerifyToken(webhookVerifyToken: string): this {
    this.webhookVerifyToken = webhookVerifyToken;
    return this;
  }

  withIsActive(isActive: boolean): this {
    this.isActive = isActive;
    return this;
  }

  withIsPrimary(isPrimary: boolean): this {
    this.isPrimary = isPrimary;
    return this;
  }

  withMetadata(metadata: Record<string, any>): this {
    this.metadata = metadata;
    return this;
  }

  withTimestamps(createdAt: Date, updatedAt: Date): this {
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    return this;
  }

  build(): WhatsAppAccountEntity {
    return new WhatsAppAccountEntity(
      this.id,
      this.name,
      this.slug,
      this.phoneNumberId,
      this.accessToken,
      this.businessId,
      this.apiVersion,
      this.isActive,
      this.isPrimary,
      this.description,
      this.webhookUrl,
      this.webhookVerifyToken,
      this.metadata,
      this.createdAt,
      this.updatedAt
    );
  }

  static fromPrisma(data: any): WhatsAppAccountEntity {
    return new WhatsAppAccountBuilder()
      .withId(data.id)
      .withName(data.name)
      .withSlug(data.slug)
      .withPhoneNumberId(data.phoneNumberId)
      .withAccessToken(data.accessToken)
      .withBusinessId(data.businessId)
      .withApiVersion(data.apiVersion)
      .withIsActive(data.isActive)
      .withIsPrimary(data.isPrimary)
      .withDescription(data.description)
      .withWebhookUrl(data.webhookUrl)
      .withWebhookVerifyToken(data.webhookVerifyToken)
      .withMetadata(data.metadata)
      .withTimestamps(data.createdAt, data.updatedAt)
      .build();
  }
}
```

#### `WebChatWidgetEntity`

**Ubicación:** `src/domain/entities/webchat-widget.entity.ts`

```typescript
import { ErrorFactory } from "@/domain/exceptions/error.factory";

export interface IWebChatWidget {
  id: string;
  name: string;
  widgetId: string;
  description?: string;
  initialFlowId?: string;
  autoStartFlow: boolean;
  theme?: Record<string, any>;
  welcomeMessage?: string;
  placeholder: string;
  allowedOrigins?: string[];
  isActive: boolean;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export class WebChatWidgetEntity {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly widgetId: string,
    public readonly autoStartFlow: boolean,
    public readonly isActive: boolean,
    public readonly placeholder: string,
    public readonly description?: string,
    public readonly initialFlowId?: string,
    public readonly theme?: Record<string, any>,
    public readonly welcomeMessage?: string,
    public readonly allowedOrigins?: string[],
    public readonly metadata?: Record<string, any>,
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date
  ) {
    this.validate();
  }

  private validate(): void {
    if (!this.name?.trim()) {
      throw ErrorFactory.create("validation", "El nombre del widget es requerido");
    }
    if (!this.widgetId?.trim() || !/^[a-z0-9-]+$/.test(this.widgetId)) {
      throw ErrorFactory.create("validation", "El widgetId debe contener solo letras minúsculas, números y guiones");
    }
    if (this.allowedOrigins && !Array.isArray(this.allowedOrigins)) {
      throw ErrorFactory.create("validation", "allowedOrigins debe ser un array");
    }
  }
}
```

#### `WebChatWidgetBuilder`

**Ubicación:** `src/domain/builders/webchat-widget.builder.ts`

```typescript
import { WebChatWidgetEntity } from "../entities/webchat-widget.entity";
import { UUID } from "../value-objects/uuid.vo";

export class WebChatWidgetBuilder {
  private id: string = UUID.generate();
  private name: string = "";
  private widgetId: string = "";
  private description?: string;
  private initialFlowId?: string;
  private autoStartFlow: boolean = false;
  private theme?: Record<string, any>;
  private welcomeMessage?: string;
  private placeholder: string = "Escribe un mensaje...";
  private allowedOrigins?: string[];
  private isActive: boolean = true;
  private metadata?: Record<string, any>;
  private createdAt?: Date;
  private updatedAt?: Date;

  withId(id: string): this {
    this.id = id;
    return this;
  }

  withName(name: string): this {
    this.name = name;
    return this;
  }

  withWidgetId(widgetId: string): this {
    this.widgetId = widgetId;
    return this;
  }

  withDescription(description: string): this {
    this.description = description;
    return this;
  }

  withInitialFlowId(initialFlowId: string): this {
    this.initialFlowId = initialFlowId;
    return this;
  }

  withAutoStartFlow(autoStartFlow: boolean): this {
    this.autoStartFlow = autoStartFlow;
    return this;
  }

  withTheme(theme: Record<string, any>): this {
    this.theme = theme;
    return this;
  }

  withWelcomeMessage(welcomeMessage: string): this {
    this.welcomeMessage = welcomeMessage;
    return this;
  }

  withPlaceholder(placeholder: string): this {
    this.placeholder = placeholder;
    return this;
  }

  withAllowedOrigins(allowedOrigins: string[]): this {
    this.allowedOrigins = allowedOrigins;
    return this;
  }

  withIsActive(isActive: boolean): this {
    this.isActive = isActive;
    return this;
  }

  withMetadata(metadata: Record<string, any>): this {
    this.metadata = metadata;
    return this;
  }

  withTimestamps(createdAt: Date, updatedAt: Date): this {
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    return this;
  }

  build(): WebChatWidgetEntity {
    return new WebChatWidgetEntity(
      this.id,
      this.name,
      this.widgetId,
      this.autoStartFlow,
      this.isActive,
      this.placeholder,
      this.description,
      this.initialFlowId,
      this.theme,
      this.welcomeMessage,
      this.allowedOrigins,
      this.metadata,
      this.createdAt,
      this.updatedAt
    );
  }

  static fromPrisma(data: any): WebChatWidgetEntity {
    return new WebChatWidgetBuilder()
      .withId(data.id)
      .withName(data.name)
      .withWidgetId(data.widgetId)
      .withDescription(data.description)
      .withInitialFlowId(data.initialFlowId)
      .withAutoStartFlow(data.autoStartFlow)
      .withTheme(data.theme)
      .withWelcomeMessage(data.welcomeMessage)
      .withPlaceholder(data.placeholder)
      .withAllowedOrigins(data.allowedOrigins)
      .withIsActive(data.isActive)
      .withMetadata(data.metadata)
      .withTimestamps(data.createdAt, data.updatedAt)
      .build();
  }
}
```

### 2️⃣ Interfaces de Repositorio

#### `IWhatsAppAccountRepository`

**Ubicación:** `src/domain/repositories/whatsapp-account.repository.ts`

```typescript
import { WhatsAppAccountEntity } from "../entities/whatsapp-account.entity";

export interface IWhatsAppAccountRepository {
  create(account: WhatsAppAccountEntity): Promise<WhatsAppAccountEntity>;
  findById(id: string): Promise<WhatsAppAccountEntity | null>;
  findBySlug(slug: string): Promise<WhatsAppAccountEntity | null>;
  findByPhoneNumberId(phoneNumberId: string): Promise<WhatsAppAccountEntity | null>;
  findAll(filters?: { isActive?: boolean }): Promise<WhatsAppAccountEntity[]>;
  findPrimary(): Promise<WhatsAppAccountEntity | null>;
  update(id: string, data: Partial<WhatsAppAccountEntity>): Promise<WhatsAppAccountEntity>;
  delete(id: string): Promise<void>;
  setPrimary(id: string): Promise<void>; // Marca como primary y desmarca los demás
}
```

#### `IWebChatWidgetRepository`

**Ubicación:** `src/domain/repositories/webchat-widget.repository.ts`

```typescript
import { WebChatWidgetEntity } from "../entities/webchat-widget.entity";

export interface IWebChatWidgetRepository {
  create(widget: WebChatWidgetEntity): Promise<WebChatWidgetEntity>;
  findById(id: string): Promise<WebChatWidgetEntity | null>;
  findByWidgetId(widgetId: string): Promise<WebChatWidgetEntity | null>;
  findAll(filters?: { isActive?: boolean }): Promise<WebChatWidgetEntity[]>;
  update(id: string, data: Partial<WebChatWidgetEntity>): Promise<WebChatWidgetEntity>;
  delete(id: string): Promise<void>;
}
```

### 3️⃣ Value Objects

#### `TemplateVariable`

**Ubicación:** `src/domain/value-objects/template-variable.vo.ts`

```typescript
import { ErrorFactory } from "../exceptions/error.factory";

type VariableSource = "static" | "user" | "answer" | "conversation" | "metadata";

export interface ITemplateVariableConfig {
  source: VariableSource;
  field?: string;      // Para "user", "conversation", "metadata"
  stepId?: string;     // Para "answer"
  value?: string;      // Para "static"
}

export class TemplateVariable {
  constructor(
    public readonly source: VariableSource,
    public readonly field?: string,
    public readonly stepId?: string,
    public readonly value?: string
  ) {
    this.validate();
  }

  private validate(): void {
    if (!this.source) {
      throw ErrorFactory.create("validation", "El source de la variable es requerido");
    }

    if (this.source === "static" && !this.value) {
      throw ErrorFactory.create("validation", "Las variables estáticas requieren 'value'");
    }

    if ((this.source === "user" || this.source === "conversation" || this.source === "metadata") && !this.field) {
      throw ErrorFactory.create("validation", `Las variables de tipo '${this.source}' requieren 'field'`);
    }

    if (this.source === "answer" && !this.stepId) {
      throw ErrorFactory.create("validation", "Las variables de tipo 'answer' requieren 'stepId'");
    }
  }

  static fromConfig(config: ITemplateVariableConfig): TemplateVariable {
    return new TemplateVariable(
      config.source,
      config.field,
      config.stepId,
      config.value
    );
  }

  toConfig(): ITemplateVariableConfig {
    return {
      source: this.source,
      field: this.field,
      stepId: this.stepId,
      value: this.value
    };
  }
}
```

### 4️⃣ Domain Services

#### `TemplateVariableResolver`

**Ubicación:** `src/domain/services/template-variable-resolver.service.ts`

```typescript
import { TemplateVariable } from "../value-objects/template-variable.vo";
import { ChatbotUser, UserAnswer, UserConversation } from "@prisma/client";

export interface ITemplateVariableContext {
  conversation: UserConversation;
  user: ChatbotUser | null;
  answers: UserAnswer[];
}

export interface IResolvedTemplateParams {
  body?: string[];
  header?: string[];
  footer?: string[];
  buttons?: { index: number; urlParam?: string }[];
}

export class TemplateVariableResolverService {
  /**
   * Resuelve variables dinámicas de una plantilla
   */
  resolve(
    templateParams: any,
    context: ITemplateVariableContext
  ): IResolvedTemplateParams {
    const resolved: IResolvedTemplateParams = {};

    // Resolver variables del body
    if (templateParams.body && Array.isArray(templateParams.body)) {
      resolved.body = templateParams.body.map((varConfig: any) => {
        const variable = TemplateVariable.fromConfig(varConfig);
        return this.resolveVariable(variable, context);
      });
    }

    // Resolver variables del header
    if (templateParams.header && Array.isArray(templateParams.header)) {
      resolved.header = templateParams.header.map((varConfig: any) => {
        const variable = TemplateVariable.fromConfig(varConfig);
        return this.resolveVariable(variable, context);
      });
    }

    // Resolver variables del footer
    if (templateParams.footer && Array.isArray(templateParams.footer)) {
      resolved.footer = templateParams.footer.map((varConfig: any) => {
        const variable = TemplateVariable.fromConfig(varConfig);
        return this.resolveVariable(variable, context);
      });
    }

    // Resolver botones dinámicos
    if (templateParams.buttons && Array.isArray(templateParams.buttons)) {
      resolved.buttons = templateParams.buttons.map((btnConfig: any) => {
        if (btnConfig.urlParam) {
          const variable = TemplateVariable.fromConfig(btnConfig.urlParam);
          return {
            index: btnConfig.index,
            urlParam: this.resolveVariable(variable, context)
          };
        }
        return btnConfig;
      });
    }

    return resolved;
  }

  /**
   * Resuelve una variable individual según su source
   */
  private resolveVariable(
    variable: TemplateVariable,
    context: ITemplateVariableContext
  ): string {
    switch (variable.source) {
      case "static":
        return variable.value || "";

      case "user":
        if (!context.user) return "";
        return this.getFieldValue(context.user, variable.field!) || "";

      case "answer":
        const answer = context.answers.find(a => a.stepId === variable.stepId);
        return answer?.answer || "";

      case "conversation":
        return this.getFieldValue(context.conversation, variable.field!) || "";

      case "metadata":
        const metadata = context.conversation.channelMetadata as any;
        return metadata?.[variable.field!] || "";

      default:
        return "";
    }
  }

  /**
   * Obtiene el valor de un campo de un objeto
   */
  private getFieldValue(obj: any, field: string): string {
    const value = obj[field];
    if (value === null || value === undefined) return "";
    return String(value);
  }
}
```

#### `FlowCompatibilityCalculator`

**Ubicación:** `src/domain/services/flow-compatibility-calculator.service.ts`

```typescript
import { Flow, FlowStep, WhatsAppTemplate } from "@prisma/client";

export class FlowCompatibilityCalculatorService {
  /**
   * Calcula qué líneas de WhatsApp son compatibles con un flujo
   * basándose en las plantillas que usa
   */
  calculateCompatibility(
    flow: Flow & { steps: (FlowStep & { whatsappTemplate?: WhatsAppTemplate })[] },
    allAccountIds: string[]
  ): {
    requiresTemplates: boolean;
    compatibleAccountIds: string[] | null; // null = todas
    requiredLogicalGroups: string[];
  } {
    // Obtener las plantillas usadas en el flow (por logicalGroup)
    const templateSteps = flow.steps.filter(s => s.whatsappTemplate);
    
    if (templateSteps.length === 0) {
      // No usa plantillas → compatible con todas las líneas
      return {
        requiresTemplates: false,
        compatibleAccountIds: null,
        requiredLogicalGroups: []
      };
    }

    // Obtener grupos lógicos requeridos
    const requiredGroups = [
      ...new Set(
        templateSteps
          .map(s => s.whatsappTemplate?.logicalGroup)
          .filter(Boolean) as string[]
      )
    ];

    return {
      requiresTemplates: true,
      compatibleAccountIds: [], // Se calcula en la capa de aplicación con datos de DB
      requiredLogicalGroups: requiredGroups
    };
  }
}
```

---

## 🎯 Capa de Aplicación

### 1️⃣ Commands

#### `CreateWhatsAppAccountCommand`

**Ubicación:** `src/app/commands/whatsapp-account/create-whatsapp-account.command.ts`

```typescript
export interface CreateWhatsAppAccountInput {
  name: string;
  slug: string;
  description?: string;
  phoneNumberId: string;
  accessToken: string;
  businessId: string;
  apiVersion?: string;
  webhookUrl?: string;
  webhookVerifyToken?: string;
  isPrimary?: boolean;
  metadata?: Record<string, any>;
}

export class CreateWhatsAppAccountCommand {
  constructor(public readonly input: CreateWhatsAppAccountInput) {}
}
```

**Handler:** `src/app/commands/whatsapp-account/create-whatsapp-account.handler.ts`

```typescript
import { inject, injectable } from "tsyringe";
import { DI } from "@/infraestructure/DI/global-symbol";
import { IWhatsAppAccountRepository } from "@/domain/repositories/whatsapp-account.repository";
import { WhatsAppAccountBuilder } from "@/domain/builders/whatsapp-account.builder";
import { CreateWhatsAppAccountCommand } from "./create-whatsapp-account.command";
import { WhatsAppAccountEntity } from "@/domain/entities/whatsapp-account.entity";
import { ErrorFactory } from "@/domain/exceptions/error.factory";

@injectable()
export class CreateWhatsAppAccountHandler {
  constructor(
    @inject(DI.WhatsAppAccountRepository)
    private repository: IWhatsAppAccountRepository
  ) {}

  async execute(command: CreateWhatsAppAccountCommand): Promise<WhatsAppAccountEntity> {
    const { input } = command;

    // Validar slug único
    const existingBySlug = await this.repository.findBySlug(input.slug);
    if (existingBySlug) {
      throw ErrorFactory.create("conflict", `Ya existe una cuenta con el slug '${input.slug}'`);
    }

    // Validar phoneNumberId único
    const existingByPhone = await this.repository.findByPhoneNumberId(input.phoneNumberId);
    if (existingByPhone) {
      throw ErrorFactory.create("conflict", `Ya existe una cuenta con el phoneNumberId '${input.phoneNumberId}'`);
    }

    // Construir entidad
    const account = new WhatsAppAccountBuilder()
      .withName(input.name)
      .withSlug(input.slug)
      .withDescription(input.description || "")
      .withPhoneNumberId(input.phoneNumberId)
      .withAccessToken(input.accessToken)
      .withBusinessId(input.businessId)
      .withApiVersion(input.apiVersion || "v21.0")
      .withWebhookUrl(input.webhookUrl)
      .withWebhookVerifyToken(input.webhookVerifyToken)
      .withIsPrimary(input.isPrimary || false)
      .withMetadata(input.metadata)
      .build();

    // Si se marca como primary, desmarcar las demás
    if (input.isPrimary) {
      await this.repository.setPrimary(account.id);
    }

    // Persistir
    return await this.repository.create(account);
  }
}
```

#### `CreateWebChatWidgetCommand`

**Ubicación:** `src/app/commands/webchat-widget/create-webchat-widget.command.ts`

```typescript
export interface CreateWebChatWidgetInput {
  name: string;
  widgetId: string;
  description?: string;
  initialFlowId?: string;
  autoStartFlow?: boolean;
  theme?: Record<string, any>;
  welcomeMessage?: string;
  placeholder?: string;
  allowedOrigins?: string[];
  metadata?: Record<string, any>;
}

export class CreateWebChatWidgetCommand {
  constructor(public readonly input: CreateWebChatWidgetInput) {}
}
```

**Handler:** `src/app/commands/webchat-widget/create-webchat-widget.handler.ts`

```typescript
import { inject, injectable } from "tsyringe";
import { DI } from "@/infraestructure/DI/global-symbol";
import { IWebChatWidgetRepository } from "@/domain/repositories/webchat-widget.repository";
import { WebChatWidgetBuilder } from "@/domain/builders/webchat-widget.builder";
import { CreateWebChatWidgetCommand } from "./create-webchat-widget.command";
import { WebChatWidgetEntity } from "@/domain/entities/webchat-widget.entity";
import { ErrorFactory } from "@/domain/exceptions/error.factory";

@injectable()
export class CreateWebChatWidgetHandler {
  constructor(
    @inject(DI.WebChatWidgetRepository)
    private repository: IWebChatWidgetRepository
  ) {}

  async execute(command: CreateWebChatWidgetCommand): Promise<WebChatWidgetEntity> {
    const { input } = command;

    // Validar widgetId único
    const existing = await this.repository.findByWidgetId(input.widgetId);
    if (existing) {
      throw ErrorFactory.create("conflict", `Ya existe un widget con el ID '${input.widgetId}'`);
    }

    // Construir entidad
    const widget = new WebChatWidgetBuilder()
      .withName(input.name)
      .withWidgetId(input.widgetId)
      .withDescription(input.description || "")
      .withInitialFlowId(input.initialFlowId)
      .withAutoStartFlow(input.autoStartFlow || false)
      .withTheme(input.theme)
      .withWelcomeMessage(input.welcomeMessage)
      .withPlaceholder(input.placeholder || "Escribe un mensaje...")
      .withAllowedOrigins(input.allowedOrigins)
      .withMetadata(input.metadata)
      .build();

    // Persistir
    return await this.repository.create(widget);
  }
}
```

#### `CalculateFlowCompatibilityCommand`

**Ubicación:** `src/app/commands/flow/calculate-flow-compatibility.command.ts`

```typescript
export class CalculateFlowCompatibilityCommand {
  constructor(public readonly flowId: string) {}
}
```

**Handler:** `src/app/commands/flow/calculate-flow-compatibility.handler.ts`

```typescript
import { inject, injectable } from "tsyringe";
import { DI } from "@/infraestructure/DI/global-symbol";
import { IFlowRepository } from "@/domain/repositories/flow.repository";
import { IWhatsAppAccountRepository } from "@/domain/repositories/whatsapp-account.repository";
import { FlowCompatibilityCalculatorService } from "@/domain/services/flow-compatibility-calculator.service";
import { CalculateFlowCompatibilityCommand } from "./calculate-flow-compatibility.command";
import { PrismaClient } from "@prisma/client";

@injectable()
export class CalculateFlowCompatibilityHandler {
  constructor(
    @inject(DI.FlowRepository)
    private flowRepository: IFlowRepository,
    @inject(DI.WhatsAppAccountRepository)
    private accountRepository: IWhatsAppAccountRepository,
    @inject(DI.PrismaClient)
    private prisma: PrismaClient,
    private compatibilityCalculator: FlowCompatibilityCalculatorService
  ) {}

  async execute(command: CalculateFlowCompatibilityCommand): Promise<void> {
    const { flowId } = command;

    // Obtener flow con sus steps y plantillas
    const flow = await this.prisma.flow.findUnique({
      where: { id: flowId },
      include: {
        steps: {
          include: {
            whatsappTemplate: true
          }
        }
      }
    });

    if (!flow) {
      throw ErrorFactory.create("not-found", `Flow no encontrado: ${flowId}`);
    }

    // Obtener todas las cuentas activas
    const allAccounts = await this.accountRepository.findAll({ isActive: true });
    const allAccountIds = allAccounts.map(a => a.id);

    // Calcular compatibilidad base
    const compatibility = this.compatibilityCalculator.calculateCompatibility(
      flow,
      allAccountIds
    );

    if (!compatibility.requiresTemplates) {
      // No usa plantillas → compatible con todas
      await this.flowRepository.updateCompatibility(flowId, {
        requiresTemplates: false,
        compatibleWhatsAppAccountIds: null,
        requiredTemplateLogicalGroups: null
      });
      return;
    }

    // Verificar qué cuentas tienen TODAS las plantillas requeridas
    const compatibleAccountIds: string[] = [];

    for (const account of allAccounts) {
      const accountTemplates = await this.prisma.whatsAppTemplate.findMany({
        where: {
          whatsappAccountId: account.id,
          logicalGroup: { in: compatibility.requiredLogicalGroups },
          metaStatus: "APPROVED"
        }
      });

      const accountGroups = accountTemplates.map(t => t.logicalGroup).filter(Boolean);
      const hasAllTemplates = compatibility.requiredLogicalGroups.every(
        group => accountGroups.includes(group)
      );

      if (hasAllTemplates) {
        compatibleAccountIds.push(account.id);
      }
    }

    // Actualizar flow
    await this.flowRepository.updateCompatibility(flowId, {
      requiresTemplates: true,
      compatibleWhatsAppAccountIds: compatibleAccountIds,
      requiredTemplateLogicalGroups: compatibility.requiredLogicalGroups
    });
  }
}
```

### 2️⃣ Use Cases

#### `SendFlowFromWhatsAppAccountUseCase`

**Ubicación:** `src/app/use-cases/flow/send-flow-from-whatsapp-account.use-case.ts`

```typescript
import { inject, injectable } from "tsyringe";
import { DI } from "@/infraestructure/DI/global-symbol";
import { IWhatsAppAccountRepository } from "@/domain/repositories/whatsapp-account.repository";
import { IFlowRepository } from "@/domain/repositories/flow.repository";
import { ErrorFactory } from "@/domain/exceptions/error.factory";

export interface SendFlowFromWhatsAppAccountInput {
  flowId: string;
  whatsappAccountId: string;
  phoneNumber: string;
}

@injectable()
export class SendFlowFromWhatsAppAccountUseCase {
  constructor(
    @inject(DI.WhatsAppAccountRepository)
    private accountRepository: IWhatsAppAccountRepository,
    @inject(DI.FlowRepository)
    private flowRepository: IFlowRepository
  ) {}

  async execute(input: SendFlowFromWhatsAppAccountInput): Promise<void> {
    const { flowId, whatsappAccountId, phoneNumber } = input;

    // Validar cuenta
    const account = await this.accountRepository.findById(whatsappAccountId);
    if (!account || !account.isActive) {
      throw ErrorFactory.create("not-found", "Cuenta de WhatsApp no encontrada o inactiva");
    }

    // Validar flow
    const flow = await this.flowRepository.findById(flowId);
    if (!flow || !flow.isActive) {
      throw ErrorFactory.create("not-found", "Flow no encontrado o inactivo");
    }

    // Verificar compatibilidad si el flow usa plantillas
    if (flow.requiresTemplates && flow.compatibleWhatsAppAccountIds) {
      if (!flow.compatibleWhatsAppAccountIds.includes(whatsappAccountId)) {
        throw ErrorFactory.create(
          "bad-request",
          `El flow '${flow.name}' no es compatible con esta línea de WhatsApp. ` +
          `Faltan plantillas requeridas: ${flow.requiredTemplateLogicalGroups?.join(", ")}`
        );
      }
    }

    // TODO: Delegar a StartFlowService con contexto de whatsappAccountId
    // Esto requiere modificar el StartFlowService para aceptar whatsappAccountId
  }
}
```

### 3️⃣ Services

#### `TemplateVariableResolverService` (Application Layer Wrapper)

**Ubicación:** `src/app/services/template-variable-resolver.service.ts`

```typescript
import { inject, injectable } from "tsyringe";
import { DI } from "@/infraestructure/DI/global-symbol";
import { PrismaClient } from "@prisma/client";
import {
  TemplateVariableResolverService as DomainResolver,
  IResolvedTemplateParams
} from "@/domain/services/template-variable-resolver.service";

@injectable()
export class TemplateVariableResolverService {
  private domainResolver: DomainResolver;

  constructor(
    @inject(DI.PrismaClient)
    private prisma: PrismaClient
  ) {
    this.domainResolver = new DomainResolver();
  }

  async resolveForConversation(
    templateParams: any,
    conversationId: string
  ): Promise<IResolvedTemplateParams> {
    // Obtener contexto completo
    const conversation = await this.prisma.userConversation.findUnique({
      where: { id: conversationId }
    });

    if (!conversation) {
      throw new Error(`Conversación no encontrada: ${conversationId}`);
    }

    const user = conversation.chatbotUserId
      ? await this.prisma.chatbotUser.findUnique({
          where: { id: conversation.chatbotUserId }
        })
      : null;

    const answers = await this.prisma.userAnswer.findMany({
      where: { conversationId }
    });

    // Delegar a domain service
    return this.domainResolver.resolve(templateParams, {
      conversation,
      user,
      answers
    });
  }
}
```

---

## 🏗️ Capa de Infraestructura

### 1️⃣ Repositorios Prisma

#### `WhatsAppAccountPrismaRepository`

**Ubicación:** `src/infraestructure/database/persistences/repositories/whatsapp-account.prisma.repository.ts`

```typescript
import { injectable } from "tsyringe";
import { PrismaClient } from "@prisma/client";
import { PrismaRepositoryBase } from "@/infraestructure/database/facades/prisma-repository.base";
import { IWhatsAppAccountRepository } from "@/domain/repositories/whatsapp-account.repository";
import { WhatsAppAccountEntity } from "@/domain/entities/whatsapp-account.entity";
import { WhatsAppAccountBuilder } from "@/domain/builders/whatsapp-account.builder";

@injectable()
export class WhatsAppAccountPrismaRepository
  extends PrismaRepositoryBase
  implements IWhatsAppAccountRepository
{
  constructor(prisma: PrismaClient) {
    super(prisma);
  }

  async create(account: WhatsAppAccountEntity): Promise<WhatsAppAccountEntity> {
    return await this.executeSafe(async () => {
      const created = await this.prisma.whatsAppAccount.create({
        data: {
          id: account.id,
          name: account.name,
          slug: account.slug,
          description: account.description,
          phoneNumberId: account.phoneNumberId,
          accessToken: account.accessToken,
          businessId: account.businessId,
          apiVersion: account.apiVersion,
          webhookUrl: account.webhookUrl,
          webhookVerifyToken: account.webhookVerifyToken,
          isActive: account.isActive,
          isPrimary: account.isPrimary,
          metadata: account.metadata || {}
        }
      });

      return WhatsAppAccountBuilder.fromPrisma(created);
    });
  }

  async findById(id: string): Promise<WhatsAppAccountEntity | null> {
    return await this.executeSafe(async () => {
      const account = await this.prisma.whatsAppAccount.findUnique({
        where: { id }
      });

      return account ? WhatsAppAccountBuilder.fromPrisma(account) : null;
    });
  }

  async findBySlug(slug: string): Promise<WhatsAppAccountEntity | null> {
    return await this.executeSafe(async () => {
      const account = await this.prisma.whatsAppAccount.findUnique({
        where: { slug }
      });

      return account ? WhatsAppAccountBuilder.fromPrisma(account) : null;
    });
  }

  async findByPhoneNumberId(phoneNumberId: string): Promise<WhatsAppAccountEntity | null> {
    return await this.executeSafe(async () => {
      const account = await this.prisma.whatsAppAccount.findUnique({
        where: { phoneNumberId }
      });

      return account ? WhatsAppAccountBuilder.fromPrisma(account) : null;
    });
  }

  async findAll(filters?: { isActive?: boolean }): Promise<WhatsAppAccountEntity[]> {
    return await this.executeSafe(async () => {
      const accounts = await this.prisma.whatsAppAccount.findMany({
        where: filters?.isActive !== undefined ? { isActive: filters.isActive } : {},
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
      });

      return accounts.map(a => WhatsAppAccountBuilder.fromPrisma(a));
    });
  }

  async findPrimary(): Promise<WhatsAppAccountEntity | null> {
    return await this.executeSafe(async () => {
      const account = await this.prisma.whatsAppAccount.findFirst({
        where: { isPrimary: true, isActive: true }
      });

      return account ? WhatsAppAccountBuilder.fromPrisma(account) : null;
    });
  }

  async update(id: string, data: Partial<WhatsAppAccountEntity>): Promise<WhatsAppAccountEntity> {
    return await this.executeSafe(async () => {
      const updated = await this.prisma.whatsAppAccount.update({
        where: { id },
        data: {
          name: data.name,
          description: data.description,
          webhookUrl: data.webhookUrl,
          webhookVerifyToken: data.webhookVerifyToken,
          isActive: data.isActive,
          metadata: data.metadata
        }
      });

      return WhatsAppAccountBuilder.fromPrisma(updated);
    });
  }

  async delete(id: string): Promise<void> {
    await this.executeSafe(async () => {
      await this.prisma.whatsAppAccount.delete({
        where: { id }
      });
    });
  }

  async setPrimary(id: string): Promise<void> {
    await this.executeSafe(async () => {
      await this.prisma.$transaction([
        // Desmarcar todas
        this.prisma.whatsAppAccount.updateMany({
          where: { isPrimary: true },
          data: { isPrimary: false }
        }),
        // Marcar la nueva
        this.prisma.whatsAppAccount.update({
          where: { id },
          data: { isPrimary: true }
        })
      ]);
    });
  }
}
```

#### `WebChatWidgetPrismaRepository`

**Ubicación:** `src/infraestructure/database/persistences/repositories/webchat-widget.prisma.repository.ts`

```typescript
import { injectable } from "tsyringe";
import { PrismaClient } from "@prisma/client";
import { PrismaRepositoryBase } from "@/infraestructure/database/facades/prisma-repository.base";
import { IWebChatWidgetRepository } from "@/domain/repositories/webchat-widget.repository";
import { WebChatWidgetEntity } from "@/domain/entities/webchat-widget.entity";
import { WebChatWidgetBuilder } from "@/domain/builders/webchat-widget.builder";

@injectable()
export class WebChatWidgetPrismaRepository
  extends PrismaRepositoryBase
  implements IWebChatWidgetRepository
{
  constructor(prisma: PrismaClient) {
    super(prisma);
  }

  async create(widget: WebChatWidgetEntity): Promise<WebChatWidgetEntity> {
    return await this.executeSafe(async () => {
      const created = await this.prisma.webChatWidget.create({
        data: {
          id: widget.id,
          name: widget.name,
          widgetId: widget.widgetId,
          description: widget.description,
          initialFlowId: widget.initialFlowId,
          autoStartFlow: widget.autoStartFlow,
          theme: widget.theme || {},
          welcomeMessage: widget.welcomeMessage,
          placeholder: widget.placeholder,
          allowedOrigins: widget.allowedOrigins || [],
          isActive: widget.isActive,
          metadata: widget.metadata || {}
        }
      });

      return WebChatWidgetBuilder.fromPrisma(created);
    });
  }

  async findById(id: string): Promise<WebChatWidgetEntity | null> {
    return await this.executeSafe(async () => {
      const widget = await this.prisma.webChatWidget.findUnique({
        where: { id }
      });

      return widget ? WebChatWidgetBuilder.fromPrisma(widget) : null;
    });
  }

  async findByWidgetId(widgetId: string): Promise<WebChatWidgetEntity | null> {
    return await this.executeSafe(async () => {
      const widget = await this.prisma.webChatWidget.findUnique({
        where: { widgetId }
      });

      return widget ? WebChatWidgetBuilder.fromPrisma(widget) : null;
    });
  }

  async findAll(filters?: { isActive?: boolean }): Promise<WebChatWidgetEntity[]> {
    return await this.executeSafe(async () => {
      const widgets = await this.prisma.webChatWidget.findMany({
        where: filters?.isActive !== undefined ? { isActive: filters.isActive } : {},
        orderBy: { createdAt: "asc" }
      });

      return widgets.map(w => WebChatWidgetBuilder.fromPrisma(w));
    });
  }

  async update(id: string, data: Partial<WebChatWidgetEntity>): Promise<WebChatWidgetEntity> {
    return await this.executeSafe(async () => {
      const updated = await this.prisma.webChatWidget.update({
        where: { id },
        data: {
          name: data.name,
          description: data.description,
          initialFlowId: data.initialFlowId,
          autoStartFlow: data.autoStartFlow,
          theme: data.theme,
          welcomeMessage: data.welcomeMessage,
          placeholder: data.placeholder,
          allowedOrigins: data.allowedOrigins,
          isActive: data.isActive,
          metadata: data.metadata
        }
      });

      return WebChatWidgetBuilder.fromPrisma(updated);
    });
  }

  async delete(id: string): Promise<void> {
    await this.executeSafe(async () => {
      await this.prisma.webChatWidget.delete({
        where: { id }
      });
    });
  }
}
```

### 2️⃣ Actualizar `WebhookService`

**Ubicación:** `src/infraestructure/services/webhook/webhook.service.ts`

**Modificaciones:**

```typescript
// Actualizar método emit() para soportar filtrado granular
async emit(
  event: WebhookEvent,
  data: {
    conversationId?: string;
    flowId?: string;
    channelType?: ChannelType;
    widgetId?: string;
    whatsappAccountId?: string;
    [key: string]: any;
  }
): Promise<void> {
  const webhooks = await this.findApplicableWebhooks(event, data);

  // Disparar todos en paralelo
  const results = await Promise.allSettled(
    webhooks.map(webhook => this.triggerWebhook(webhook, event, data))
  );

  // Log de resultados
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.error(`Webhook ${webhooks[index].name} falló: ${result.reason}`);
    }
  });
}

/**
 * Encuentra webhooks aplicables según filtros
 */
private async findApplicableWebhooks(
  event: WebhookEvent,
  context: {
    flowId?: string;
    channelType?: ChannelType;
    widgetId?: string;
    whatsappAccountId?: string;
  }
): Promise<Webhook[]> {
  const allWebhooks = await this.webhookRepository.findActiveByEvent(event);

  // Filtrar según criterios
  return allWebhooks.filter(webhook => {
    // Filtro de flows
    if (webhook.flowIds && context.flowId) {
      const flowIds = webhook.flowIds as string[];
      if (!flowIds.includes(context.flowId)) return false;
    }

    // Filtro de canales
    if (webhook.channelTypes && context.channelType) {
      const channelTypes = webhook.channelTypes as string[];
      if (!channelTypes.includes(context.channelType)) return false;
    }

    // Filtro de widgets (solo WEBCHAT)
    if (webhook.widgetIds && context.channelType === "WEBCHAT" && context.widgetId) {
      const widgetIds = webhook.widgetIds as string[];
      if (!widgetIds.includes(context.widgetId)) return false;
    }

    // Filtro de líneas WhatsApp (solo WHATSAPP)
    if (webhook.whatsappAccountIds && context.channelType === "WHATSAPP" && context.whatsappAccountId) {
      const accountIds = webhook.whatsappAccountIds as string[];
      if (!accountIds.includes(context.whatsappAccountId)) return false;
    }

    return true;
  });
}
```

### 3️⃣ Actualizar `WhatsAppAdapter`

**Ubicación:** `src/infraestructure/adapters/messaging/whatsapp.adapter.ts`

**Modificaciones:**

```typescript
// Cambiar de singleton a factory pattern
export class WhatsAppAdapter implements IMessageAdapter {
  readonly channelType = ChannelType.WHATSAPP;

  private readonly apiUrl: string;
  private readonly headers: Record<string, string>;

  // Constructor ahora recibe la configuración de la cuenta específica
  constructor(private readonly account: WhatsAppAccountEntity) {
    this.apiUrl = `https://graph.facebook.com/${account.apiVersion}/${account.phoneNumberId}/messages`;
    this.headers = {
      Authorization: `Bearer ${account.accessToken}`,
      "Content-Type": "application/json"
    };
  }

  // Actualizar sendTemplateMessage para soportar todos los componentes
  async sendTemplateMessage(
    channelUserId: string,
    templateName: string,
    params?: {
      body?: string[];
      header?: string[];
      footer?: string[];
      buttons?: { index: number; urlParam?: string }[];
    }
  ): Promise<boolean> {
    const context = {
      feature: "whatsapp" as const,
      phone: channelUserId,
      templateName,
      accountId: this.account.id
    };

    try {
      const components = [];

      // Header parameters
      if (params?.header && params.header.length > 0) {
        components.push({
          type: "header",
          parameters: params.header.map(value => ({
            type: "text",
            text: value
          }))
        });
      }

      // Body parameters
      if (params?.body && params.body.length > 0) {
        components.push({
          type: "body",
          parameters: params.body.map(value => ({
            type: "text",
            text: value
          }))
        });
      }

      // Button parameters (URL dynamic)
      if (params?.buttons && params.buttons.length > 0) {
        params.buttons.forEach(btn => {
          if (btn.urlParam) {
            components.push({
              type: "button",
              sub_type: "url",
              index: btn.index.toString(),
              parameters: [{
                type: "text",
                text: btn.urlParam
              }]
            });
          }
        });
      }

      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: channelUserId,
          type: "template",
          template: {
            name: templateName,
            language: { code: "es" },
            components: components.length > 0 ? components : undefined
          }
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        logger.error(
          `Error enviando template WhatsApp: ${JSON.stringify(errorData)}`,
          context,
          "whatsapp:template-error"
        );
        return false;
      }

      logger.info("✅ Template WhatsApp enviado correctamente", context);
      return true;
    } catch (error: any) {
      logger.error(
        `Error en sendTemplateMessage: ${error.message}`,
        context,
        "whatsapp:send-error"
      );
      return false;
    }
  }
}
```

### 4️⃣ Crear `WhatsAppAdapterFactory`

**Ubicación:** `src/infraestructure/adapters/messaging/whatsapp-adapter.factory.ts`

```typescript
import { injectable, inject } from "tsyringe";
import { DI } from "@/infraestructure/DI/global-symbol";
import { IWhatsAppAccountRepository } from "@/domain/repositories/whatsapp-account.repository";
import { WhatsAppAdapter } from "./whatsapp.adapter";
import { ErrorFactory } from "@/domain/exceptions/error.factory";

@injectable()
export class WhatsAppAdapterFactory {
  private adapters: Map<string, WhatsAppAdapter> = new Map();

  constructor(
    @inject(DI.WhatsAppAccountRepository)
    private accountRepository: IWhatsAppAccountRepository
  ) {}

  /**
   * Obtiene o crea un adapter para una cuenta específica
   */
  async getAdapter(accountId: string): Promise<WhatsAppAdapter> {
    // Cache
    if (this.adapters.has(accountId)) {
      return this.adapters.get(accountId)!;
    }

    // Cargar cuenta
    const account = await this.accountRepository.findById(accountId);
    if (!account || !account.isActive) {
      throw ErrorFactory.create("not-found", `Cuenta de WhatsApp no encontrada o inactiva: ${accountId}`);
    }

    // Crear adapter
    const adapter = new WhatsAppAdapter(account);
    this.adapters.set(accountId, adapter);

    return adapter;
  }

  /**
   * Obtiene el adapter de la cuenta primaria
   */
  async getPrimaryAdapter(): Promise<WhatsAppAdapter> {
    const primary = await this.accountRepository.findPrimary();
    if (!primary) {
      throw ErrorFactory.create("not-found", "No hay cuenta de WhatsApp primaria configurada");
    }

    return this.getAdapter(primary.id);
  }

  /**
   * Invalida el cache de un adapter
   */
  invalidateAdapter(accountId: string): void {
    this.adapters.delete(accountId);
  }
}
```

### 5️⃣ Actualizar `MessageSenderService`

**Ubicación:** `src/infraestructure/services/messaging/message-sender.service.ts`

**Modificaciones:**

```typescript
import { TemplateVariableResolverService } from "@/app/services/template-variable-resolver.service";

@injectable()
export class MessageSenderService implements IMessageSender {
  constructor(
    @inject(DI.WhatsAppAdapterFactory) 
    private whatsappAdapterFactory: WhatsAppAdapterFactory,
    @inject(DI.WebChatAdapter) 
    private webChatAdapter: IMessageAdapter,
    @inject(DI.TemplateVariableResolverService)
    private templateVariableResolver: TemplateVariableResolverService,
    @inject(DI.PrismaClient)
    private prisma: PrismaClient
  ) {}

  async sendStepContent(
    step: IFlowStep,
    channelType: ChannelType,
    channelUserId: string,
    context?: {
      conversationId?: string;
      whatsappAccountId?: string;
    }
  ): Promise<void> {
    // ... código existente ...

    // Template de WhatsApp con variables dinámicas
    if (step.type === StepType.template) {
      if (!step.templateName) {
        throw new Error("Template step requires templateName");
      }

      // Obtener adapter según canal
      let adapter: IMessageAdapter;
      if (channelType === ChannelType.WHATSAPP) {
        if (!context?.whatsappAccountId) {
          // Usar cuenta primaria por defecto
          adapter = await this.whatsappAdapterFactory.getPrimaryAdapter();
        } else {
          adapter = await this.whatsappAdapterFactory.getAdapter(context.whatsappAccountId);
        }
      } else {
        adapter = this.getAdapter(channelType);
      }

      // Resolver variables si están configuradas
      let params = undefined;
      if (step.templateParams && context?.conversationId) {
        params = await this.templateVariableResolver.resolveForConversation(
          step.templateParams,
          context.conversationId
        );
      }

      await adapter.sendTemplateMessage(channelUserId, step.templateName, params);
      return;
    }

    // ... resto del código ...
  }
}
```

### 6️⃣ Controllers y Routes

#### `WhatsAppAccountController`

**Ubicación:** `src/infraestructure/http/controllers/whatsapp-account/whatsapp-account.controller.ts`

```typescript
import { Request, Response } from "express";
import { container } from "tsyringe";
import { ResponseBuilder } from "@/infraestructure/http/middlewares/response-builder";
import { CreateWhatsAppAccountHandler } from "@/app/commands/whatsapp-account/create-whatsapp-account.handler";
import { CreateWhatsAppAccountCommand } from "@/app/commands/whatsapp-account/create-whatsapp-account.command";

export class WhatsAppAccountController {
  static async create(req: Request, res: Response) {
    const handler = container.resolve(CreateWhatsAppAccountHandler);
    const command = new CreateWhatsAppAccountCommand(req.body);
    const account = await handler.execute(command);

    ResponseBuilder.sendSuccess(res, account, "Cuenta de WhatsApp creada exitosamente", 201);
  }

  static async list(req: Request, res: Response) {
    const repository = container.resolve(DI.WhatsAppAccountRepository);
    const accounts = await repository.findAll({
      isActive: req.query.isActive === "true" ? true : undefined
    });

    ResponseBuilder.sendSuccess(res, accounts, "Cuentas de WhatsApp obtenidas exitosamente");
  }

  static async getById(req: Request, res: Response) {
    const repository = container.resolve(DI.WhatsAppAccountRepository);
    const account = await repository.findById(req.params.id);

    if (!account) {
      throw ErrorFactory.create("not-found", "Cuenta de WhatsApp no encontrada");
    }

    ResponseBuilder.sendSuccess(res, account, "Cuenta de WhatsApp obtenida exitosamente");
  }

  static async setPrimary(req: Request, res: Response) {
    const repository = container.resolve(DI.WhatsAppAccountRepository);
    await repository.setPrimary(req.params.id);

    ResponseBuilder.sendSuccess(res, null, "Cuenta marcada como primaria exitosamente");
  }
}
```

**Schema Zod:**

**Ubicación:** `src/infraestructure/http/schemas/whatsapp-account.schema.ts`

```typescript
import { z } from "zod";

export const createWhatsAppAccountSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().regex(/^[a-z0-9-]+$/, "Solo letras minúsculas, números y guiones"),
  description: z.string().optional(),
  phoneNumberId: z.string().min(1),
  accessToken: z.string().min(1),
  businessId: z.string().min(1),
  apiVersion: z.string().default("v21.0"),
  webhookUrl: z.string().url().optional(),
  webhookVerifyToken: z.string().optional(),
  isPrimary: z.boolean().default(false),
  metadata: z.record(z.any()).optional()
});

export const updateWhatsAppAccountSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  webhookUrl: z.string().url().optional(),
  webhookVerifyToken: z.string().optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.any()).optional()
});
```

**Routes:**

**Ubicación:** `src/infraestructure/http/routes/whatsapp-account.routes.ts`

```typescript
import { Router } from "express";
import { WhatsAppAccountController } from "../controllers/whatsapp-account/whatsapp-account.controller";
import { validateSchema } from "../middlewares/validate-schema.middleware";
import { createWhatsAppAccountSchema } from "../schemas/whatsapp-account.schema";
import { asyncHandler } from "../middlewares/async-handler.middleware";

const router = Router();

router.post(
  "/",
  validateSchema(createWhatsAppAccountSchema),
  asyncHandler(WhatsAppAccountController.create)
);

router.get("/", asyncHandler(WhatsAppAccountController.list));

router.get("/:id", asyncHandler(WhatsAppAccountController.getById));

router.patch("/:id/set-primary", asyncHandler(WhatsAppAccountController.setPrimary));

export default router;
```

#### `WebChatWidgetController`

**Ubicación:** `src/infraestructure/http/controllers/webchat-widget/webchat-widget.controller.ts`

```typescript
import { Request, Response } from "express";
import { container } from "tsyringe";
import { ResponseBuilder } from "@/infraestructure/http/middlewares/response-builder";
import { CreateWebChatWidgetHandler } from "@/app/commands/webchat-widget/create-webchat-widget.handler";
import { CreateWebChatWidgetCommand } from "@/app/commands/webchat-widget/create-webchat-widget.command";

export class WebChatWidgetController {
  static async create(req: Request, res: Response) {
    const handler = container.resolve(CreateWebChatWidgetHandler);
    const command = new CreateWebChatWidgetCommand(req.body);
    const widget = await handler.execute(command);

    ResponseBuilder.sendSuccess(res, widget, "Widget creado exitosamente", 201);
  }

  static async list(req: Request, res: Response) {
    const repository = container.resolve(DI.WebChatWidgetRepository);
    const widgets = await repository.findAll({
      isActive: req.query.isActive === "true" ? true : undefined
    });

    ResponseBuilder.sendSuccess(res, widgets, "Widgets obtenidos exitosamente");
  }

  static async getByWidgetId(req: Request, res: Response) {
    const repository = container.resolve(DI.WebChatWidgetRepository);
    const widget = await repository.findByWidgetId(req.params.widgetId);

    if (!widget) {
      throw ErrorFactory.create("not-found", "Widget no encontrado");
    }

    ResponseBuilder.sendSuccess(res, widget, "Widget obtenido exitosamente");
  }

  static async getEmbedCode(req: Request, res: Response) {
    const repository = container.resolve(DI.WebChatWidgetRepository);
    const widget = await repository.findByWidgetId(req.params.widgetId);

    if (!widget) {
      throw ErrorFactory.create("not-found", "Widget no encontrado");
    }

    const embedCode = `<script src="${process.env.BASE_URL}/webchat/widget.js?id=${widget.widgetId}"></script>`;

    ResponseBuilder.sendSuccess(res, { embedCode }, "Código de integración obtenido exitosamente");
  }
}
```

**Schema Zod:**

**Ubicación:** `src/infraestructure/http/schemas/webchat-widget.schema.ts`

```typescript
import { z } from "zod";

export const createWebChatWidgetSchema = z.object({
  name: z.string().min(1).max(255),
  widgetId: z.string().regex(/^[a-z0-9-]+$/, "Solo letras minúsculas, números y guiones"),
  description: z.string().optional(),
  initialFlowId: z.string().uuid().optional(),
  autoStartFlow: z.boolean().default(false),
  theme: z.record(z.any()).optional(),
  welcomeMessage: z.string().optional(),
  placeholder: z.string().default("Escribe un mensaje..."),
  allowedOrigins: z.array(z.string().url()).optional(),
  metadata: z.record(z.any()).optional()
});

export const updateWebChatWidgetSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  initialFlowId: z.string().uuid().optional(),
  autoStartFlow: z.boolean().optional(),
  theme: z.record(z.any()).optional(),
  welcomeMessage: z.string().optional(),
  placeholder: z.string().optional(),
  allowedOrigins: z.array(z.string().url()).optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.any()).optional()
});
```

**Routes:**

**Ubicación:** `src/infraestructure/http/routes/webchat-widget.routes.ts`

```typescript
import { Router } from "express";
import { WebChatWidgetController } from "../controllers/webchat-widget/webchat-widget.controller";
import { validateSchema } from "../middlewares/validate-schema.middleware";
import { createWebChatWidgetSchema } from "../schemas/webchat-widget.schema";
import { asyncHandler } from "../middlewares/async-handler.middleware";

const router = Router();

router.post(
  "/",
  validateSchema(createWebChatWidgetSchema),
  asyncHandler(WebChatWidgetController.create)
);

router.get("/", asyncHandler(WebChatWidgetController.list));

router.get("/:widgetId", asyncHandler(WebChatWidgetController.getByWidgetId));

router.get("/:widgetId/embed-code", asyncHandler(WebChatWidgetController.getEmbedCode));

export default router;
```

### 7️⃣ Actualizar DI Container

**Ubicación:** `src/infraestructure/DI/container.ts`

```typescript
// Agregar tokens
export const DI = {
  // ... tokens existentes ...
  WhatsAppAccountRepository: Symbol.for("WhatsAppAccountRepository"),
  WebChatWidgetRepository: Symbol.for("WebChatWidgetRepository"),
  WhatsAppAdapterFactory: Symbol.for("WhatsAppAdapterFactory"),
  TemplateVariableResolverService: Symbol.for("TemplateVariableResolverService"),
} as const;

// Registrar implementaciones
container.registerSingleton(
  DI.WhatsAppAccountRepository,
  WhatsAppAccountPrismaRepository
);

container.registerSingleton(
  DI.WebChatWidgetRepository,
  WebChatWidgetPrismaRepository
);

container.registerSingleton(
  DI.WhatsAppAdapterFactory,
  WhatsAppAdapterFactory
);

container.registerSingleton(
  DI.TemplateVariableResolverService,
  TemplateVariableResolverService
);
```

---

## 🧪 Testing

### 1️⃣ Tests de Entidades

**Ubicación:** `test/domain/entities/whatsapp-account.entity.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { WhatsAppAccountEntity } from "@/domain/entities/whatsapp-account.entity";

describe("WhatsAppAccountEntity", () => {
  it("debe crear una entidad válida", () => {
    const account = new WhatsAppAccountEntity(
      "uuid",
      "Línea Soporte",
      "soporte",
      "123456789",
      "token",
      "business-id",
      "v21.0",
      true,
      false
    );

    expect(account.name).toBe("Línea Soporte");
    expect(account.slug).toBe("soporte");
    expect(account.isActive).toBe(true);
  });

  it("debe lanzar error si el nombre está vacío", () => {
    expect(() => {
      new WhatsAppAccountEntity(
        "uuid",
        "",
        "soporte",
        "123",
        "token",
        "business",
        "v21.0",
        true,
        false
      );
    }).toThrow("El nombre de la cuenta es requerido");
  });

  it("debe lanzar error si el slug contiene caracteres inválidos", () => {
    expect(() => {
      new WhatsAppAccountEntity(
        "uuid",
        "Soporte",
        "Soporte_123",
        "123",
        "token",
        "business",
        "v21.0",
        true,
        false
      );
    }).toThrow("El slug debe contener solo letras minúsculas");
  });
});
```

### 2️⃣ Tests de Builders

**Ubicación:** `test/domain/builders/whatsapp-account.builder.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { WhatsAppAccountBuilder } from "@/domain/builders/whatsapp-account.builder";

describe("WhatsAppAccountBuilder", () => {
  it("debe construir una entidad con valores por defecto", () => {
    const account = new WhatsAppAccountBuilder()
      .withName("Soporte")
      .withSlug("soporte")
      .withPhoneNumberId("123")
      .withAccessToken("token")
      .withBusinessId("business")
      .build();

    expect(account.name).toBe("Soporte");
    expect(account.apiVersion).toBe("v21.0");
    expect(account.isActive).toBe(true);
    expect(account.isPrimary).toBe(false);
  });

  it("debe construir desde datos de Prisma", () => {
    const prismaData = {
      id: "uuid",
      name: "Ventas",
      slug: "ventas",
      phoneNumberId: "456",
      accessToken: "token",
      businessId: "business",
      apiVersion: "v21.0",
      isActive: true,
      isPrimary: true,
      description: "Línea de ventas",
      webhookUrl: null,
      webhookVerifyToken: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const account = WhatsAppAccountBuilder.fromPrisma(prismaData);

    expect(account.name).toBe("Ventas");
    expect(account.isPrimary).toBe(true);
  });
});
```

### 3️⃣ Tests de Repositorios

**Ubicación:** `test/infraestructure/database/repositories/whatsapp-account.prisma.repository.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WhatsAppAccountPrismaRepository } from "@/infraestructure/database/persistences/repositories/whatsapp-account.prisma.repository";
import { WhatsAppAccountBuilder } from "@/domain/builders/whatsapp-account.builder";
import { PrismaClient } from "@prisma/client";

describe("WhatsAppAccountPrismaRepository", () => {
  let repository: WhatsAppAccountPrismaRepository;
  let prisma: PrismaClient;

  beforeEach(() => {
    prisma = new PrismaClient();
    repository = new WhatsAppAccountPrismaRepository(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("debe crear una cuenta de WhatsApp", async () => {
    const account = new WhatsAppAccountBuilder()
      .withName("Test Account")
      .withSlug("test")
      .withPhoneNumberId("123456")
      .withAccessToken("token")
      .withBusinessId("business")
      .build();

    const created = await repository.create(account);

    expect(created.name).toBe("Test Account");
    expect(created.slug).toBe("test");

    // Cleanup
    await prisma.whatsAppAccount.delete({ where: { id: created.id } });
  });

  it("debe encontrar cuenta por slug", async () => {
    // Setup
    const account = await prisma.whatsAppAccount.create({
      data: {
        name: "Soporte",
        slug: "soporte",
        phoneNumberId: "unique-123",
        accessToken: "token",
        businessId: "business",
        apiVersion: "v21.0",
        isActive: true,
        isPrimary: false
      }
    });

    const found = await repository.findBySlug("soporte");

    expect(found).not.toBeNull();
    expect(found?.name).toBe("Soporte");

    // Cleanup
    await prisma.whatsAppAccount.delete({ where: { id: account.id } });
  });
});
```

### 4️⃣ Tests de Servicios

**Ubicación:** `test/domain/services/template-variable-resolver.service.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { TemplateVariableResolverService } from "@/domain/services/template-variable-resolver.service";

describe("TemplateVariableResolverService", () => {
  const resolver = new TemplateVariableResolverService();

  it("debe resolver variables estáticas", () => {
    const templateParams = {
      body: [
        { source: "static", value: "DatiHub" }
      ]
    };

    const context = {
      conversation: {} as any,
      user: null,
      answers: []
    };

    const resolved = resolver.resolve(templateParams, context);

    expect(resolved.body).toEqual(["DatiHub"]);
  });

  it("debe resolver variables del usuario", () => {
    const templateParams = {
      body: [
        { source: "user", field: "name" }
      ]
    };

    const context = {
      conversation: {} as any,
      user: { name: "Juan Pérez" } as any,
      answers: []
    };

    const resolved = resolver.resolve(templateParams, context);

    expect(resolved.body).toEqual(["Juan Pérez"]);
  });

  it("debe resolver variables de respuestas", () => {
    const templateParams = {
      body: [
        { source: "answer", stepId: "step-1" }
      ]
    };

    const context = {
      conversation: {} as any,
      user: null,
      answers: [
        { stepId: "step-1", answer: "Laptop HP" } as any
      ]
    };

    const resolved = resolver.resolve(templateParams, context);

    expect(resolved.body).toEqual(["Laptop HP"]);
  });

  it("debe resolver múltiples componentes", () => {
    const templateParams = {
      header: [
        { source: "static", value: "Pedido" }
      ],
      body: [
        { source: "user", field: "name" },
        { source: "answer", stepId: "step-1" }
      ],
      buttons: [
        {
          index: 0,
          urlParam: { source: "conversation", field: "id" }
        }
      ]
    };

    const context = {
      conversation: { id: "conv-123" } as any,
      user: { name: "Juan" } as any,
      answers: [{ stepId: "step-1", answer: "ORD-456" } as any]
    };

    const resolved = resolver.resolve(templateParams, context);

    expect(resolved.header).toEqual(["Pedido"]);
    expect(resolved.body).toEqual(["Juan", "ORD-456"]);
    expect(resolved.buttons).toEqual([
      { index: 0, urlParam: "conv-123" }
    ]);
  });
});
```

---

## 📚 Documentación

### 1️⃣ Actualizar `data-model.md`

**Ubicación:** `ai-specs/specs/data-model.md`

**Agregar secciones:**

```markdown
## WhatsAppAccount

Gestión de múltiples líneas de WhatsApp Business para un mismo cliente.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | String | UUID |
| name | String | Nombre descriptivo (ej: "Línea Soporte") |
| slug | String | Identificador único para URLs (ej: "soporte") |
| phoneNumberId | String | WA_PHONE_NUMBER_ID de Meta |
| accessToken | String | CLOUD_API_ACCESS_TOKEN |
| businessId | String | WHATSAPP_BUSINESS_ID |
| apiVersion | String | Versión de API (default: v21.0) |
| webhookUrl | String? | URL configurada en Meta |
| webhookVerifyToken | String? | Token de verificación |
| isActive | Boolean | Si está activa |
| isPrimary | Boolean | Línea por defecto |
| metadata | Json? | Configuración adicional |

**Relaciones:**
- `templates: WhatsAppTemplate[]` - Plantillas de esta línea
- `conversations: UserConversation[]` - Conversaciones originadas
- `webhooks: Webhook[]` - Webhooks específicos

## WebChatWidget

Configuración de múltiples widgets de chat para diferentes campañas.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | String | UUID |
| name | String | Nombre descriptivo |
| widgetId | String | ID único para embed code |
| initialFlowId | String? | Flow que inicia automáticamente |
| autoStartFlow | Boolean | Iniciar sin mensaje del usuario |
| theme | Json? | Colores, logo, posición |
| welcomeMessage | String? | Mensaje de bienvenida |
| placeholder | String | Placeholder del input |
| allowedOrigins | Json? | Dominios permitidos (CORS) |
| isActive | Boolean | Si está activo |
| metadata | Json? | Configuración adicional |

**Relaciones:**
- `initialFlow: Flow?` - Flow inicial
- `conversations: UserConversation[]` - Conversaciones del widget
- `webhooks: Webhook[]` - Webhooks específicos

## Webhook (Actualizado)

**Nuevos filtros:**
- `flowIds: Json?` - Filtrar por flows específicos
- `channelTypes: Json?` - Filtrar por canales (WEBCHAT, WHATSAPP, etc.)
- `widgetIds: Json?` - Filtrar por widgets (solo WEBCHAT)
- `whatsappAccountIds: Json?` - Filtrar por líneas (solo WHATSAPP)

## WhatsAppTemplate (Actualizado)

**Nuevos campos:**
- `whatsappAccountId: String` - Línea a la que pertenece
- `logicalGroup: String?` - Agrupación lógica para mismo template en múltiples líneas

## FlowStep (Actualizado)

**Nuevos campos:**
- `templateParams: Json?` - Configuración de variables dinámicas

Estructura de `templateParams`:
```json
{
  "body": [
    { "source": "user", "field": "name" },
    { "source": "answer", "stepId": "step-uuid" },
    { "source": "static", "value": "DatiHub" }
  ],
  "header": [...],
  "buttons": [
    { "index": 0, "urlParam": { "source": "conversation", "field": "id" } }
  ]
}
```

## Flow (Actualizado)

**Nuevos campos:**
- `requiresTemplates: Boolean` - Si usa plantillas de WhatsApp
- `compatibleWhatsAppAccountIds: Json?` - Líneas compatibles (calculado)
- `requiredTemplateLogicalGroups: Json?` - Plantillas requeridas

## UserConversation (Actualizado)

**Nuevos campos:**
- `whatsappAccountId: String?` - Línea que originó (WHATSAPP)
- `widgetId: String?` - Widget que originó (WEBCHAT)
```

**Agregar diagrama ERD Mermaid actualizado al final del documento.**

### 2️⃣ Actualizar `api-spec.yml`

**Ubicación:** `ai-specs/specs/api-spec.yml`

**Agregar endpoints:**

```yaml
paths:
  /api/whatsapp-accounts:
    post:
      summary: Crear cuenta de WhatsApp
      tags: [WhatsApp Accounts]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, slug, phoneNumberId, accessToken, businessId]
              properties:
                name:
                  type: string
                  example: "Línea Soporte"
                slug:
                  type: string
                  pattern: "^[a-z0-9-]+$"
                  example: "soporte"
                phoneNumberId:
                  type: string
                  example: "123456789"
                accessToken:
                  type: string
                businessId:
                  type: string
                apiVersion:
                  type: string
                  default: "v21.0"
                webhookUrl:
                  type: string
                  format: uri
                isPrimary:
                  type: boolean
                  default: false
      responses:
        201:
          description: Cuenta creada exitosamente
        409:
          description: Slug o phoneNumberId duplicado

    get:
      summary: Listar cuentas de WhatsApp
      tags: [WhatsApp Accounts]
      parameters:
        - in: query
          name: isActive
          schema:
            type: boolean
      responses:
        200:
          description: Lista de cuentas

  /api/whatsapp-accounts/{id}:
    get:
      summary: Obtener cuenta por ID
      tags: [WhatsApp Accounts]
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
      responses:
        200:
          description: Cuenta obtenida
        404:
          description: Cuenta no encontrada

  /api/whatsapp-accounts/{id}/set-primary:
    patch:
      summary: Marcar como cuenta primaria
      tags: [WhatsApp Accounts]
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
      responses:
        200:
          description: Cuenta marcada como primaria

  /api/webchat-widgets:
    post:
      summary: Crear widget de WebChat
      tags: [WebChat Widgets]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, widgetId]
              properties:
                name:
                  type: string
                  example: "Widget Promociones"
                widgetId:
                  type: string
                  pattern: "^[a-z0-9-]+$"
                  example: "promo"
                initialFlowId:
                  type: string
                  format: uuid
                autoStartFlow:
                  type: boolean
                  default: false
                theme:
                  type: object
                welcomeMessage:
                  type: string
                allowedOrigins:
                  type: array
                  items:
                    type: string
                    format: uri
      responses:
        201:
          description: Widget creado exitosamente
        409:
          description: WidgetId duplicado

    get:
      summary: Listar widgets
      tags: [WebChat Widgets]
      responses:
        200:
          description: Lista de widgets

  /api/webchat-widgets/{widgetId}:
    get:
      summary: Obtener widget por widgetId
      tags: [WebChat Widgets]
      parameters:
        - in: path
          name: widgetId
          required: true
          schema:
            type: string
      responses:
        200:
          description: Widget obtenido
        404:
          description: Widget no encontrado

  /api/webchat-widgets/{widgetId}/embed-code:
    get:
      summary: Obtener código de integración del widget
      tags: [WebChat Widgets]
      parameters:
        - in: path
          name: widgetId
          required: true
          schema:
            type: string
      responses:
        200:
          description: Código de integración
          content:
            application/json:
              schema:
                type: object
                properties:
                  embedCode:
                    type: string
                    example: '<script src="https://api.datihub.com/webchat/widget.js?id=promo"></script>'
```

---

## 📋 Mensajes de Commit Sugeridos

Siguiendo **Conventional Commits** y la **Decision Matrix**:

### Grupo 1: Schema y Migración
```bash
feat(db): add multi-line whatsapp and multi-widget webchat support

- Add WhatsAppAccount model for managing multiple WhatsApp lines
- Add WebChatWidget model for multiple chat widget configurations
- Update Webhook model with granular filtering (flowIds, channelTypes, widgetIds, whatsappAccountIds)
- Update UserConversation with whatsappAccountId and widgetId relations
- Update WhatsAppTemplate with whatsappAccountId and logicalGroup
- Update FlowStep with templateParams for dynamic variables
- Update Flow with compatibility fields (requiresTemplates, compatibleWhatsAppAccountIds)
- Run migration: npx prisma migrate dev --name add_multi_channel_multi_line_system
```

### Grupo 2: Domain Layer (Entidades + Builders)
```bash
feat(domain): add WhatsAppAccount and WebChatWidget entities with builders

- Add WhatsAppAccountEntity with validation (11 attributes)
- Add WhatsAppAccountBuilder (required for >5 attributes)
- Add WebChatWidgetEntity with validation
- Add WebChatWidgetBuilder
- Add TemplateVariable value object
```

### Grupo 3: Domain Layer (Interfaces + Services)
```bash
feat(domain): add repositories and domain services for multi-channel system

- Add IWhatsAppAccountRepository interface
- Add IWebChatWidgetRepository interface
- Add TemplateVariableResolverService domain service
- Add FlowCompatibilityCalculatorService domain service
```

### Grupo 4: Application Layer (Commands)
```bash
feat(app): add commands for WhatsAppAccount and WebChatWidget management

- Add CreateWhatsAppAccountCommand + Handler
- Add CreateWebChatWidgetCommand + Handler
- Add CalculateFlowCompatibilityCommand + Handler
- Add TemplateVariableResolverService (app wrapper)
```

### Grupo 5: Infrastructure (Repositories)
```bash
feat(infra): implement Prisma repositories for multi-channel entities

- Add WhatsAppAccountPrismaRepository with executeSafe
- Add WebChatWidgetPrismaRepository with executeSafe
- Both extend PrismaRepositoryBase
```

### Grupo 6: Infrastructure (Services)
```bash
refactor(infra): update WhatsAppAdapter to factory pattern and add template variables support

- Create WhatsAppAdapterFactory for multi-account management
- Update WhatsAppAdapter to accept account-specific configuration
- Add support for header, footer, and button variables in sendTemplateMessage
- Update WebhookService with granular filtering logic (findApplicableWebhooks)
- Update MessageSenderService to resolve template variables dynamically
```

### Grupo 7: Infrastructure (Controllers + Routes)
```bash
feat(api): add WhatsAppAccount and WebChatWidget endpoints

- Add WhatsAppAccountController with CRUD operations
- Add WebChatWidgetController with CRUD operations
- Add Zod schemas for validation (createWhatsAppAccountSchema, createWebChatWidgetSchema)
- Add routes: /api/whatsapp-accounts, /api/webchat-widgets
- Register routes in main router
```

### Grupo 8: Infrastructure (DI)
```bash
chore(di): register new repositories and services in DI container

- Register WhatsAppAccountRepository
- Register WebChatWidgetRepository
- Register WhatsAppAdapterFactory
- Register TemplateVariableResolverService
- Update DI symbol tokens
```

### Grupo 9: Tests
```bash
test: add comprehensive tests for multi-channel system

- Add WhatsAppAccountEntity tests
- Add WebChatWidgetEntity tests
- Add Builder tests (WhatsAppAccountBuilder, WebChatWidgetBuilder)
- Add Repository tests (integration with Prisma)
- Add TemplateVariableResolverService tests
- Target: 90% coverage
```

### Grupo 10: Documentación
```bash
docs: update data-model and api-spec with multi-channel features

- Update ai-specs/specs/data-model.md with new models and relationships
- Add WhatsAppAccount, WebChatWidget sections
- Document new Webhook filters
- Document templateParams structure
- Update ERD Mermaid diagram
- Update ai-specs/specs/api-spec.yml with new endpoints
```

---

## ⚠️ Notas Importantes para el Implementador

### 🔴 Crítico

1. **Migración de Datos Existentes:**
   - Si hay conversaciones activas, necesitas migrar `UserConversation` para asignar `whatsappAccountId` o `widgetId`
   - Considera crear un seeder para poblar la primera cuenta de WhatsApp desde las variables de entorno actuales
   - Si existen plantillas, asignarlas a la cuenta primaria

2. **Breaking Changes:**
   - `WhatsAppAdapter` cambia de singleton a factory pattern
   - Todos los lugares que usan `@inject(DI.WhatsAppAdapter)` deben actualizarse a `WhatsAppAdapterFactory`
   - `sendTemplateMessage()` cambia su firma de parámetros

3. **Seguridad:**
   - `WhatsAppAccount.accessToken` debe estar encriptado en BD
   - Considerar implementar rotación de tokens
   - `allowedOrigins` en `WebChatWidget` debe validarse en CORS middleware

### 🟡 Importante

4. **Compatibilidad de Flows:**
   - El comando `CalculateFlowCompatibilityCommand` debe ejecutarse:
     - Al crear/actualizar un Flow
     - Al crear/actualizar/aprobar una WhatsAppTemplate
     - Como job scheduled diario (sincronización)

5. **Cache de Adapters:**
   - `WhatsAppAdapterFactory` cachea adapters en memoria
   - Implementar invalidación cuando se actualizan credenciales
   - Considerar TTL de cache o event-based invalidation

6. **Webhooks de Meta:**
   - Cada `WhatsAppAccount` necesita configuración manual en Meta Business Manager
   - El endpoint debe ser: `POST /webhooks/whatsapp/:accountSlug`
   - Implementar verificación de `webhookVerifyToken`

### 🟢 Recomendaciones

7. **Variables de Plantillas:**
   - Validar que las variables configuradas existen antes de enviar
   - Loggear cuando una variable no se puede resolver (retorna "")
   - Considerar valores por defecto o fallbacks

8. **Testing:**
   - Priorizar tests de integración para Webhooks con filtros
   - Mock de Meta API para tests de WhatsAppAdapter
   - Tests E2E de flujo completo: crear widget → iniciar conversación → webhook disparado

9. **Monitoreo:**
   - Métricas por línea de WhatsApp (mensajes enviados, errores)
   - Métricas por widget (conversaciones iniciadas, conversiones)
   - Alertas cuando una línea falla constantemente

10. **Migración Gradual:**
    - Fase 1: Schema + Repositorios + Entities (sin afectar código existente)
    - Fase 2: Factory pattern + backward compatibility
    - Fase 3: Controllers + API
    - Fase 4: Variables dinámicas
    - Fase 5: Deprecar singleton adapter

---

## 🚨 Gaps Críticos Detectados (Ver GAPS.md para detalles)

Durante la revisión del código existente, se identificaron **13 gaps críticos** que NO estaban en el plan inicial:

### 🔴 4 Bloqueadores Críticos (DEBEN implementarse primero)

1. **GAP #0: Widget REST Endpoints** ⚠️ CRÍTICO NUEVO  
   El widget actual (`datihub_frontend/public/chatbot-widget.js`) usa **REST + Polling**, NO Socket.IO.
   - ❌ Faltan 3 endpoints: `/api/chatbot-config/:id`, `/api/webchat/incoming`, `/api/conversations/:id/messages`
   - ⚡ Solución: Migrar script al backend + crear endpoints REST + mantener Socket.IO como opcional

2. **GAP #1: Webhook Receiver Multi-Línea**  
   El controller actual recibe todos los webhooks de WhatsApp pero NO identifica de qué cuenta viene.
   - Meta SÍ envía `phoneNumberId` en el body pero no lo estamos usando
   - ❌ Sin esto, no podemos guardar `UserConversation.whatsappAccountId`

3. **GAP #2: Socket.IO con widgetId**  
   WebChat se conecta pero NO capturamos de qué widget viene.
   - ❌ Sin esto, no podemos guardar `UserConversation.widgetId` ni aplicar configuración

4. **GAP #3: FlowStep.templateName Breaking Change**  
   La relación actual `@relation(fields: [templateName], references: [name])` se ROMPE.
   - Con multi-línea, `WhatsAppTemplate.name` ya no puede ser `@unique`
   - ⚡ Solución: Cambiar a `templateLogicalGroup` sin relación + resolver en runtime

5. **GAP #4: Migración de Datos**  
   Necesitamos seeder para crear cuenta primaria desde env vars actuales.
   - Migrar conversaciones/plantillas existentes a la nueva estructura

### 🟡 5 Componentes Importantes (funcionalidad incompleta sin estos)

6. **GAP #5: Widget Embed Script Migration** — Migrar CSS/JS desde frontend + servir con cache  
7. **GAP #6: ProcessIncomingMessageUseCase** — Agregar parámetros `whatsappAccountId` y `widgetId`  
8. **GAP #7: CORS Dinámico** — Validar según `WebChatWidget.allowedOrigins` (actual: `*`)  
9. **GAP #8: Encrypting Access Tokens** — `WhatsAppAccount.accessToken` con AES-256  
10. **GAP #9: Cache Invalidation** — Invalidar adapter factory al actualizar credenciales  

### 🟢 4 Mejoras Nice-to-Have (pueden ser fase 2)

11. **GAP #10:** Auto-calculate compatibility triggers (Prisma middleware o cron job)  
12. **GAP #11:** Metrics con dimensiones `whatsappAccountId` y `widgetId`  
13. **GAP #12:** Template cloning API para duplicar a múltiples líneas  
14. **GAP #13:** Webhook config helper (instrucciones para configurar en Meta)  

> ⚠️ **Impacto en Estimación**: Plan original 37h → Con gaps críticos: **50-57h**

---

## 🎯 Guía de Ejecución Paso a Paso

### 📋 Checklist Pre-Implementación

Antes de empezar, asegúrate de:
- [ ] Leer completamente este documento Y [`multi-channel-multi-line-system_GAPS.md`](./multi-channel-multi-line-system_GAPS.md)
- [ ] Tener backup de la base de datos de producción
- [ ] Crear rama de feature: `git checkout -b feat/multi-channel-system`
- [ ] Verificar que tienes Node.js v20+ y Prisma v7.2.0
- [ ] Configurar variable de entorno `ENCRYPTION_KEY` (32 bytes hex)

---

## 🚀 Orden de Ejecución Detallado

### 🔴 PASO 1: Widget REST Endpoints (GAP #0) — 3-4h — CRÍTICO

**Objetivo:** Hacer que el widget actual funcione con el backend.

**1.1. Migrar archivos del frontend al backend**
```bash
# Crear directorio
mkdir -p public/webchat

# Copiar archivos desde datihub_frontend
cp ../datihub_frontend/public/chatbot-widget.css public/webchat/widget.css
cp ../datihub_frontend/public/chatbot-widget.js public/webchat/widget.js

# Modificar widget.js: Cambiar línea 14
# const API_BASE_URL = 'https://api.datihub.com'; 
# →
# const API_BASE_URL = '__API_BASE_URL__';  // Será reemplazado por backend
```

**1.2. Crear controllers REST**
```bash
# Crear archivos:
- src/infraestructure/http/controllers/webchat/widget-script.controller.ts
- src/infraestructure/http/controllers/webchat/widget-config.controller.ts
- src/infraestructure/http/controllers/webchat/webchat-incoming.controller.ts
- src/app/queries/conversation/get-conversation-messages.query.ts
- src/infraestructure/http/routes/webchat-widget.routes.ts
```

**Ver implementación completa en:** [`GAPS.md - GAP #0`](./multi-channel-multi-line-system_GAPS.md#-gap-0-widget-rest-endpoints---crítico-nuevo)

**1.3. Commit**
```bash
git add public/webchat/ src/infraestructure/http/controllers/webchat/ src/app/queries/conversation/
git commit -m "chore(widget): migrate widget.js and widget.css from frontend to backend"
git commit -m "feat(widget): add widget script serving with cache and API_BASE_URL injection"
git commit -m "feat(webchat): add REST endpoints for existing widget (chatbot-config, incoming, messages polling)"
```

**✅ Verificar:** Probar widget cargando desde `http://localhost:3000/webchat/widget.js`

---

### 🔴 PASO 2: Schema Prisma + Template Breaking Change (GAP #3) — 3h

**Objetivo:** Actualizar schema sin romper relaciones existentes.

**2.1. Modificar schema.prisma**

**IMPORTANTE:** Hacer estos cambios en el orden exacto:

```prisma
// 1. PRIMERO: Eliminar relación rota de FlowStep
model FlowStep {
  // ❌ ELIMINAR estas líneas:
  // template     WhatsAppTemplate? @relation("TemplateUsedInSteps", fields: [templateName], references: [name])
  // templateName String?
  
  // ✅ AGREGAR:
  templateLogicalGroup String?           @db.VarChar(255)
  templateParams       Json?             // { "1": "user.name", "header_image": "product.image" }
  
  // ... resto sin cambios
}

// 2. SEGUNDO: Agregar modelos nuevos
model WhatsAppAccount {
  id                  String   @id @default(uuid())
  name                String   @db.VarChar(255)
  slug                String   @unique @db.VarChar(100)
  description         String?  @db.Text
  phoneNumberId       String   @unique @db.VarChar(255)
  accessToken         String   @db.Text  // Se encriptará con AES-256
  businessId          String   @db.VarChar(255)
  apiVersion          String   @default("v21.0") @db.VarChar(10)
  webhookUrl          String?  @db.Text
  webhookVerifyToken  String?  @db.VarChar(255)
  isPrimary           Boolean  @default(false)
  isActive            Boolean  @default(true)
  metadata            Json?    @default("{}")
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  // Relaciones
  templates      WhatsAppTemplate[]
  conversations  UserConversation[]

  @@index([slug])
  @@index([isPrimary])
  @@map("whatsapp_accounts")
}

model WebChatWidget {
  id              String   @id @default(uuid())
  widgetId        String   @unique @db.VarChar(100)
  name            String   @db.VarChar(255)
  description     String?  @db.Text
  initialFlowId   String?
  autoStartFlow   Boolean  @default(false)
  theme           Json?    // { primaryColor, secondaryColor, botName, avatarUrl, icon }
  welcomeMessage  String?  @db.Text
  placeholder     String?  @db.VarChar(255)
  allowedOrigins  String[] @default([])
  isActive        Boolean  @default(true)
  metadata        Json?    @default("{}")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  // Relaciones
  conversations UserConversation[]

  @@index([widgetId])
  @@map("webchat_widgets")
}

// 3. TERCERO: Actualizar modelos existentes
model WhatsAppTemplate {
  // ❌ ELIMINAR:
  // name  String @unique @db.VarChar(255)
  // steps FlowStep[] @relation("TemplateUsedInSteps")
  
  // ✅ AGREGAR/MODIFICAR:
  name                String  @db.VarChar(255)  // Ya no unique global
  logicalGroup        String? @db.VarChar(255)  // "welcome_message"
  whatsappAccountId   String?
  whatsappAccount     WhatsAppAccount? @relation(fields: [whatsappAccountId], references: [id], onDelete: Cascade)
  
  @@unique([name, whatsappAccountId])
  @@index([logicalGroup])
  @@map("whatsapp_templates")
}

model UserConversation {
  // ✅ AGREGAR:
  whatsappAccountId String?
  whatsappAccount   WhatsAppAccount? @relation(fields: [whatsappAccountId], references: [id])
  widgetId          String?
  widget            WebChatWidget?   @relation(fields: [widgetId], references: [id])
  
  @@index([whatsappAccountId])
  @@index([widgetId])
  // ... resto sin cambios
}

model Webhook {
  // ✅ AGREGAR:
  flowIds              String[] @default([])
  channelTypes         String[] @default([])
  widgetIds            String[] @default([])
  whatsappAccountIds   String[] @default([])
  
  @@index([flowIds])
  @@index([widgetIds])
  @@index([whatsappAccountIds])
  // ... resto sin cambios
}

model Flow {
  // ✅ AGREGAR:
  requiresTemplates              Boolean  @default(false)
  requiredTemplateLogicalGroups  String[] @default([])
  compatibleWhatsAppAccountIds   String[] @default([])
  
  // ... resto sin cambios
}
```

**2.2. Ejecutar migración**
```bash
# Generar migración
npx prisma migrate dev --name add_multi_channel_multi_line_system

# ⚠️ Si falla por la relación de FlowStep, hacer reset en dev:
# npx prisma migrate reset
# npx prisma migrate dev --name add_multi_channel_multi_line_system

# Actualizar cliente
npx prisma generate
```

**2.3. Commit**
```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add multi-line whatsapp and multi-widget webchat support

- Add WhatsAppAccount model for managing multiple WhatsApp lines
- Add WebChatWidget model for multiple chat widget configurations
- Update Webhook model with granular filtering (flowIds, channelTypes, widgetIds, whatsappAccountIds)
- Update UserConversation with whatsappAccountId and widgetId relations
- Update WhatsAppTemplate with whatsappAccountId and logicalGroup
- Update FlowStep: replace templateName with templateLogicalGroup
- Update Flow with compatibility fields (requiresTemplates, compatibleWhatsAppAccountIds)

BREAKING CHANGE: FlowStep.template relation removed. Use templateLogicalGroup with runtime resolution."
```

**✅ Verificar:** `npx prisma studio` — Ver nuevas tablas

---

### 🔴 PASO 3: Seeder Migración de Datos (GAP #4) — 2h

**Objetivo:** Migrar datos existentes a la nueva estructura.

**3.1. Crear seeder**
```bash
# Crear archivo: prisma/seeders/migrate-to-multi-line.seed.ts
```

**Ver código completo en:** [`GAPS.md - GAP #4`](./multi-channel-multi-line-system_GAPS.md#-gap-4-migración-de-datos-existentes-bloqueador)

**3.2. Ejecutar seeder**
```bash
npx tsx prisma/seeders/migrate-to-multi-line.seed.ts
```

**3.3. Commit**
```bash
git add prisma/seeders/migrate-to-multi-line.seed.ts
git commit -m "chore(seed): add migration script for existing data to primary account

- Create primary WhatsAppAccount from current env vars
- Migrate existing templates to primary account
- Migrate existing WHATSAPP conversations to primary account
- Set logicalGroup = name for existing templates"
```

**✅ Verificar:** Prisma Studio — Ver cuenta primaria + plantillas migradas

---

### 🟡 PASO 4-5: Domain Layer — 7h

**Implementar en orden:**

**4.1. Entities + Value Objects (2h)**
```bash
# Crear archivos (ver plan principal para código completo):
- src/domain/entities/whatsapp-account.entity.ts
- src/domain/entities/webchat-widget.entity.ts
- src/domain/value-objects/template-variable.vo.ts
```

**4.2. Builders (2h)**
```bash
- src/domain/builders/whatsapp-account.builder.ts
- src/domain/builders/webchat-widget.builder.ts
```

**4.3. Interfaces (1.5h)**
```bash
- src/domain/interfaces/repositories/whatsapp-account.repository.interface.ts
- src/domain/interfaces/repositories/webchat-widget.repository.interface.ts
```

**4.4. Domain Services (1.5h)**
```bash
- src/domain/services/template-variable-resolver.service.ts
- src/domain/services/flow-compatibility-calculator.service.ts
```

**4.5. Commits**
```bash
git commit -m "feat(domain): add WhatsAppAccount and WebChatWidget entities with builders"
git commit -m "feat(domain): add repositories and domain services for multi-channel system"
```

---

### 🟡 PASO 6: Application Layer — 4h

**6.1. Commands + Handlers (3h)**
```bash
- src/app/commands/whatsapp-account/create-whatsapp-account.command.ts
- src/app/commands/whatsapp-account/create-whatsapp-account.handler.ts
- src/app/commands/webchat-widget/create-webchat-widget.command.ts
- src/app/commands/webchat-widget/create-webchat-widget.handler.ts
- src/app/commands/flow/calculate-flow-compatibility.command.ts
- src/app/commands/flow/calculate-flow-compatibility.handler.ts
```

**6.2. Template Variable Resolver (1h)**
```bash
- src/app/services/template-variable-resolver.service.ts
```

**6.3. Commit**
```bash
git commit -m "feat(app): add commands for WhatsAppAccount and WebChatWidget management"
```

---

### 🟢 PASO 7: Infrastructure Repositories — 3h

```bash
- src/infraestructure/database/persistences/repositories/whatsapp-account.prisma.repository.ts
- src/infraestructure/database/persistences/repositories/webchat-widget.prisma.repository.ts
```

**Commit:**
```bash
git commit -m "feat(infra): implement Prisma repositories for multi-channel entities"
```

---

### 🔴 PASO 8-10: Infrastructure Services + GAPs #1,#2 — 8h

**8.1. GAP #1: Webhook Routing (1h)**

Modificar `src/infraestructure/http/controllers/whatsapp/whatsapp-hook.controller.ts`:
- Extraer `phoneNumberId` del webhook body
- Mapear a `whatsappAccountId`
- Pasar a `ProcessIncomingMessageUseCase`

**Ver código:** [`GAPS.md - GAP #1`](./multi-channel-multi-line-system_GAPS.md#-gap-1-webhook-receiver-multi-línea-bloqueador)

**8.2. GAP #2: Socket.IO widgetId (1h)**

Modificar `src/infraestructure/adapters/messaging/webchat.adapter.ts`:
- Capturar `widgetId` en `socket.handshake.query`
- Validar widget existe y está activo
- Guardar en metadata del socket

**Ver código:** [`GAPS.md - GAP #2`](./multi-channel-multi-line-system_GAPS.md#-gap-2-socketio-con-widgetid-bloqueador)

**8.3. WhatsAppAdapter Factory (3h)**
```bash
- src/infraestructure/adapters/messaging/whatsapp-adapter.factory.ts
- Modificar: src/infraestructure/adapters/messaging/whatsapp.adapter.ts
```

**8.4. Webhook Service Filtrado (1h)**
```bash
- Modificar: src/infraestructure/services/webhook/webhook.service.ts
```

**8.5. Message Sender con Variables (2h)**
```bash
- Modificar: src/infraestructure/services/messaging/message-sender.service.ts
```

**Commits:**
```bash
git commit -m "feat(webhook): add multi-line whatsapp webhook routing by phoneNumberId"
git commit -m "feat(webchat): add widgetId capture in socket.io connection"
git commit -m "refactor(infra): update WhatsAppAdapter to factory pattern for multi-account management

BREAKING CHANGE: WhatsAppAdapter is no longer a singleton. Use WhatsAppAdapterFactory.getAdapter(accountId)"
git commit -m "feat(webhook): add granular filtering by flow, channel, widget, and account"
git commit -m "feat(messaging): add dynamic template variable resolution (header, body, footer, buttons)"
```

---

### 🟢 PASO 11-15: API + Mejoras — 9h

**11. Controllers + Routes (4h)**
```bash
- Controllers y routes para WhatsAppAccount y WebChatWidget
- Schemas Zod
```

**12. GAP #6: ProcessIncomingMessageUseCase (1h)**
```bash
- Agregar parámetros whatsappAccountId y widgetId
```

**13. GAP #8: Encryption (2h)**
```bash
- src/shared/utils/crypto.util.ts
- Modificar repositorio para encrypt/decrypt
```

**14. GAP #7: CORS Dinámico (1h)**
```bash
- Modificar src/infraestructure/socket-io.ts
```

**15. GAP #9: Cache Invalidation (1h)**
```bash
- Agregar factory.invalidateAdapter() en update
```

**Commits:**
```bash
git commit -m "feat(api): add WhatsAppAccount and WebChatWidget endpoints"
git commit -m "feat(messaging): add whatsappAccountId and widgetId to ProcessIncomingMessageUseCase"
git commit -m "feat(security): add AES-256 encryption for WhatsAppAccount accessToken"
git commit -m "feat(cors): add dynamic CORS validation by widget allowedOrigins"
git commit -m "feat(cache): add adapter cache invalidation on account update"
```

---

### 🟢 PASO 16-18: DI + Tests + Docs — 11h

**16. DI Container (1h)**
```bash
git commit -m "chore(di): register new repositories and services in DI container"
```

**17. Tests (8h)**
```bash
git commit -m "test: add comprehensive tests for multi-channel system"
```

**18. Documentación (2h)**
```bash
# Actualizar:
- ai-specs/specs/data-model.md
- ai-specs/specs/api-spec.yml

git commit -m "docs: update data-model and api-spec with multi-channel features"
```

---

### 🟢 PASO 19 (Opcional): Nice-to-Have — 6h

GAPs #10-13 si hay tiempo disponible.

---

## ✅ Verificación Final

Antes de hacer merge:
- [ ] Todos los tests pasan: `npm test`
- [ ] Cobertura >= 90%: `npm run test:coverage`
- [ ] Linter sin errores: `npm run lint`
- [ ] Build exitoso: `npm run build`
- [ ] Widget funciona en localhost
- [ ] Prisma Studio muestra datos migrados
- [ ] Documentación actualizada

```bash
# Merge a develop
git checkout develop
git merge feat/multi-channel-system
git push origin develop
```

---

## 📊 Estimación de Complejidad (ACTUALIZADA)

### Plan Original

| Componente | Archivos Nuevos | Archivos Modificados | Complejidad | Tiempo Estimado |
|------------|-----------------|----------------------|-------------|-----------------|
| Schema + Migración | 1 | 1 | Media | 2h |
| Domain Entities + Builders | 6 | 0 | Media | 4h |
| Domain Interfaces + Services | 4 | 0 | Alta | 3h |
| Application Commands | 6 | 0 | Media | 4h |
| Infrastructure Repositories | 2 | 0 | Media | 3h |
| Infrastructure Services | 2 | 4 | **Muy Alta** | 6h |
| API (Controllers + Routes) | 6 | 1 | Media | 4h |
| DI Container | 0 | 1 | Baja | 1h |
| Tests | 10+ | 0 | Alta | 8h |
| Documentación | 0 | 2 | Media | 2h |
| **SUBTOTAL** | **37+** | **9** | **Muy Alta** | **37h** |

### Gaps Críticos Adicionales

| Gap | Descripción | Archivos Nuevos | Modificados | Tiempo |
|-----|-------------|-----------------|-------------|--------|
| **GAP #0** | Widget REST endpoints + migración | 3 | 2 | 3-4h |
| **GAP #1** | Webhook routing multi-línea | 0 | 1 | 1h |
| **GAP #2** | Socket.IO captura widgetId | 0 | 1 | 1h |
| **GAP #3** | Template breaking change | 0 | 1 | 1h |
| **GAP #4** | Seeder migración datos | 1 | 0 | 2h |
| **GAP #6** | ProcessIncomingMessage update | 0 | 1 | 1h |
| **GAP #7** | CORS dinámico | 0 | 1 | 1h |
| **GAP #8** | Encryption access tokens | 1 | 1 | 2h |
| **GAP #9** | Cache invalidation | 0 | 1 | 1h |
| **SUBTOTAL GAPS** | **5** | **9** | **Alta** | **13-14h** |

### Totales

| Categoría | Archivos Nuevos | Archivos Modificados | Tiempo Total |
|-----------|-----------------|----------------------|--------------|
| **Plan Original** | 37+ | 9 | 37h |
| **Gaps Críticos** | 5 | 9 | 13-14h |
| **TOTAL ACTUALIZADO** | **42+** | **18** | **50-51h** |
| **+ Nice-to-Have (GAPs 10-13)** | +4 | +3 | **+6h = 56-57h** |

**Nota:** Esta estimación es para un desarrollador experimentado. Considera tiempo adicional para:
- Testing manual e integración (+ 4-6h)
- Ajustes de configuración y env vars (+ 2h)
- Migración de datos existentes en producción (+ 2-3h)
- Code review y ajustes (+ 3-4h)
- **Buffer recomendado total: +10-15h**

**Estimación Conservadora Final: 60-72 horas (~1.5-2 semanas)**

---

## 🔗 Referencias

- [Clean Architecture Guide](../specs/skills/clean-architecture.md)
- [Error Handling](../specs/skills/error-handling.md)
- [Design Patterns](../specs/skills/design-patterns.md)
- [Validation & Security](../specs/skills/validation-security.md)
- [Prisma Database](../specs/skills/prisma-database.md)
- [Backend Standards](../specs/backend-standards.mdc)
- [WhatsApp Business API Docs](https://developers.facebook.com/docs/whatsapp/cloud-api)
- [Meta Template Messages Docs](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates)

---

**Fin del Plan de Implementación**

---

**Notas Finales:**

Este plan cubre una funcionalidad muy robusta y compleja. El implementador debe:
- **Leer [GAPS.md](./multi-channel-multi-line-system_GAPS.md) antes de empezar** (contiene 13 gaps críticos)
- Leer completamente este plan antes de empezar
- Seguir el orden recomendado de implementación (Fase 1 = Bloqueadores obligatorios)
- Ejecutar tests continuamente durante el desarrollo
- Hacer commits atómicos siguiendo los mensajes sugeridos
- Actualizar documentación conforme implementa
- Validar con el equipo antes de hacer breaking changes en `WhatsAppAdapter`

**Priorización si hay tiempo limitado:**

### Mínimo Viable (MVP - ~30h):
1. ✅ **GAP #0** (Widget REST endpoints) — Sin esto, el widget actual NO funciona
2. ✅ **GAP #3** (Template breaking change) — Evitar romper la relación de Prisma
3. ✅ **Multi-línea WhatsApp básico** (Schema + Domain + Repositories)
4. ✅ **GAP #1** (Webhook routing) — Identificar de qué línea viene el mensaje
5. ✅ **GAP #4** (Migración de datos) — Migrar datos existentes

### Funcionalidad Completa (~50h):
6. ✅ Multi-widget WebChat + GAP #2 (Socket.IO widgetId)
7. ✅ Webhooks con filtrado granular
8. ✅ GAP #6 (ProcessIncomingMessageUseCase update)
9. ✅ Template variable resolution service

### Mejoras de Calidad (~57h):
10. ✅ GAP #8 (Encryption), GAP #7 (CORS), GAP #9 (Cache)
11. ✅ Variables dinámicas en plantillas (header, footer, buttons)

### Nice-to-Have (Fase 2):
12. 🟢 GAPs #10-13 (Auto-calc, metrics, cloning, webhook helper)
