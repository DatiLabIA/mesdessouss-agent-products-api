---
feature: multi-channel-multi-line-system-gaps
type: backend-gaps
priority: critical
created: 2026-04-20
author: backend-developer
---

# 🚨 GAPS CRÍTICOS - Sistema Multi-Línea/Multi-Widget

## ⚠️ Resumen Ejecutivo

Este documento complementa el plan principal [`multi-channel-multi-line-system_backend.md`](./multi-channel-multi-line-system_backend.md) con **14 gaps críticos** que se detectaron al revisar el código existente.

**🔴 BLOQUEADORES** (sin estos, el sistema NO funciona):
0. **Widget REST endpoints** (el script actual usa REST, no Socket.IO) — 🚨 CRÍTICO NUEVO
1. Webhook receiver multi-línea (identificar de qué cuenta viene)
2. Socket.IO con widgetId (identificar de qué widget viene)
3. FlowStep.templateName breaking change (relación rota con multi-línea)
4. Migración de datos existentes

**🟡 IMPORTANTES** (funcionalidad incompleta sin estos):
5. Widget embed script migration (migrar CSS/JS al backend)
6. ProcessIncomingMessageUseCase actualizado
7. CORS dinámico por widget
8. Encrypting access tokens
9. Cache invalidation

**🟢 MEJORAS** (nice to have):
10. Auto-calculate compatibility triggers
11. Metrics dimensiones
12. Template cloning API
13. Webhook config helper

---

## 🚨 GAP #0: Widget REST Endpoints - CRÍTICO NUEVO

### ⚠️ DESCUBRIMIENTO IMPORTANTE

El widget actual (`datihub_frontend/public/chatbot-widget.js`) **USA REST + POLLING**, NO Socket.IO.

**Esto significa:**
- ❌ El plan original de Socket.IO es incompatible con el código en producción
- ❌ Faltan 3 endpoints REST críticos que el widget espera
- ⚠️ Necesitamos enfoque **híbrido**: REST (actual) + Socket.IO (futuro opcional)

### Endpoints que el Widget Espera (NO EXISTEN)

#### 1️⃣ Configuración del Widget
```http
GET /api/chatbot-config/:companyId

Response: {
  widget: {
    color: "#3498db",
    colorSec: "#2980b9",
    botName: "Asistente Virtual",
    avatar: "https://...",
    icon: "💬",
    type: "interno"
  }
}
```

#### 2️⃣ Recibir Mensaje WebChat
```http
POST /api/webchat/incoming

Body: {
  message: "Hola",
  channelUserId: "user_xyz",
  metadata: {
    widgetId: "company-123",      // ← Llamado companyId en widget
    sessionId: "session_abc",
    url: "https://client.com",
    conversationId: "conv-123"
  }
}

Response: {
  success: true,
  conversationId: "conv-123",
  response: {
    text: "¡Hola! ¿En qué puedo ayudarte?",
    mode: "FLOW",
    metadata: { progress: 10, stepIndex: 1, totalSteps: 5 }
  }
}
```

#### 3️⃣ Polling de Mensajes (modo HUMAN)
```http
GET /api/conversations/:id/messages?since=2026-04-20T10:00:00Z

Response: {
  messages: [
    { text: "...", sender: "agent", timestamp: "..." }
  ]
}
```

### Impacto

❌ Sin estos endpoints, el widget existente **NO funciona**  
❌ Clientes actuales en producción tendrían el chatbot roto  
❌ Socket.IO solo rompería la compatibilidad  

### Solución: Enfoque Híbrido

#### 1. Migrar Scripts al Backend

```bash
# Mover archivos del frontend al backend
cp datihub_frontend/public/chatbot-widget.css → datihub_backend/public/webchat/widget.css
cp datihub_frontend/public/chatbot-widget.js  → datihub_backend/public/webchat/widget.js
```

#### 2. Servir Script con Inyección

```typescript
// src/infraestructure/http/controllers/webchat/widget-script.controller.ts

export class WidgetScriptController {
  static serveScript = async (req: Request, res: Response) => {
    const widgetId = req.query.id as string;
    
    // Headers para cache agresivo
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const scriptPath = path.join(__dirname, `../../../../../public/webchat/widget.js`);
    let scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    
    // Inyectar API_BASE_URL
    const apiUrl = process.env.BASE_URL || 'https://api.datihub.com';
    scriptContent = scriptContent.replace('__API_BASE_URL__', apiUrl);
    
    res.send(scriptContent);
  };
  
  static serveCSS = async (req: Request, res: Response) => {
    // Similar para CSS
  };
}
```

#### 3. Crear Controllers REST

```typescript
// src/infraestructure/http/controllers/webchat/widget-config.controller.ts

export class WidgetConfigController {
  static async getConfig(req: Request, res: Response) {
    const { companyId } = req.params;
    
    const repository = container.resolve<IWebChatWidgetRepository>(
      DI.WebChatWidgetRepository
    );
    
    // Buscar widget por widgetId (llamado companyId en frontend)
    const widget = await repository.findByWidgetId(companyId);
    
    if (!widget || !widget.isActive) {
      throw ErrorFactory.create("not-found", "Widget no encontrado");
    }
    
    const config = {
      widget: {
        color: widget.theme?.primaryColor || "#3498db",
        colorSec: widget.theme?.secondaryColor || "#2980b9",
        botName: widget.theme?.botName || "Asistente Virtual",
        avatar: widget.theme?.avatarUrl || "",
        icon: widget.theme?.icon || "💬",
        type: widget.type || "interno"
      }
    };
    
    ResponseBuilder.sendSuccess(res, config, "Configuración obtenida");
  }
}
```

```typescript
// src/infraestructure/http/controllers/webchat/webchat-incoming.controller.ts

export class WebChatIncomingController {
  static async receiveMessage(req: Request, res: Response) {
    const { message, channelUserId, metadata } = req.body;
    
    const processMessageUseCase = container.resolve<ProcessIncomingMessageUseCase>(
      DI.ProcessIncomingMessageUseCase
    );
    
    const result = await processMessageUseCase.execute({
      channelType: ChannelType.WEBCHAT,
      channelUserId,
      messageId: `webchat-${Date.now()}`,
      content: message,
      timestamp: new Date(),
      widgetId: metadata?.widgetId,
      metadata: {
        sessionId: metadata?.sessionId,
        url: metadata?.url
      }
    });
    
    const response = {
      success: true,
      conversationId: result.conversation.id,
      response: {
        text: result.botResponse?.text || "",
        mode: result.conversation.mode,
        currentStep: result.conversation.currentStep,
        metadata: {
          progress: result.flowProgress?.percentage,
          stepIndex: result.flowProgress?.currentStep,
          totalSteps: result.flowProgress?.totalSteps
        }
      }
    };
    
    ResponseBuilder.sendSuccess(res, response, "Mensaje procesado");
  }
}
```

```typescript
// src/app/queries/conversation/get-conversation-messages.query.ts

export interface GetConversationMessagesInput {
  conversationId: string;
  since?: Date;
  limit?: number;
}

@injectable()
export class GetConversationMessagesQuery {
  constructor(
    @inject(DI.ConversationRepository) private conversationRepo: IConversationRepository,
    @inject(DI.MessageRepository) private messageRepo: IMessageRepository
  ) {}
  
  async execute(input: GetConversationMessagesInput) {
    const conversation = await this.conversationRepo.findById(input.conversationId);
    
    if (!conversation) {
      throw ErrorFactory.create("not-found", "Conversación no encontrada");
    }
    
    const messages = await this.messageRepo.findByConversation(
      input.conversationId,
      {
        since: input.since,
        limit: input.limit || 50
      }
    );
    
    return {
      messages: messages.map(m => ({
        text: m.content,
        sender: m.senderType === "AGENT" ? "agent" : m.senderType.toLowerCase(),
        timestamp: m.timestamp.toISOString()
      }))
    };
  }
}
```

#### 4. Routes

```typescript
// src/infraestructure/http/routes/webchat-widget.routes.ts

export class WebChatWidgetRoute {
  get routes(): Router {
    const router = Router();
    
    // Servir script del widget
    router.get("/widget.js", WidgetScriptController.serveScript);
    router.get("/widget.css", WidgetScriptController.serveCSS);
    
    // Configuración del widget
    router.get("/api/chatbot-config/:companyId", WidgetConfigController.getConfig);
    
    // REST endpoint para mensajes
    router.post("/api/webchat/incoming", WebChatIncomingController.receiveMessage);
    
    // Polling de mensajes (modo HUMAN)
    router.get("/api/conversations/:conversationId/messages", async (req, res) => {
      const query = container.resolve(GetConversationMessagesQuery);
      const since = req.query.since ? new Date(req.query.since as string) : undefined;
      
      const result = await query.execute({
        conversationId: req.params.conversationId,
        since
      });
      
      ResponseBuilder.sendSuccess(res, result);
    });
    
    return router;
  }
}
```

#### 5. Embed Code Actualizado

**Frontend Admin genera:**

```html
<!-- Cargar CSS -->
<link rel="stylesheet" href="https://api.datihub.com/webchat/widget.css">

<!-- Cargar e inicializar widget -->
<script src="https://api.datihub.com/webchat/widget.js?id=widget-promo-123" 
        data-company-id="widget-promo-123"></script>
```

### Archivos Afectados

- **MIGRAR:** `datihub_frontend/public/chatbot-widget.css` → `datihub_backend/public/webchat/widget.css`
- **MIGRAR:** `datihub_frontend/public/chatbot-widget.js` → `datihub_backend/public/webchat/widget.js`
- **NUEVO:** `src/infraestructure/http/controllers/webchat/widget-script.controller.ts`
- **NUEVO:** `src/infraestructure/http/controllers/webchat/widget-config.controller.ts`
- **NUEVO:** `src/infraestructure/http/controllers/webchat/webchat-incoming.controller.ts`
- **NUEVO:** `src/app/queries/conversation/get-conversation-messages.query.ts`
- **NUEVO:** `src/infraestructure/http/routes/webchat-widget.routes.ts`

### Commits Sugeridos

```bash
# GAP #0
chore(widget): migrate widget.js and widget.css from frontend to backend public/

feat(widget): add widget script serving with cache and API_BASE_URL injection

feat(webchat): add REST endpoints for existing widget (chatbot-config, incoming, messages polling)
```

---

## 🔴 GAP #1: Webhook Receiver Multi-Línea (BLOQUEADOR)

### Problema

Actualmente existe **UN SOLO** endpoint que recibe webhooks de WhatsApp:

```typescript
// src/infraestructure/http/routes/whassapt/whatsapp.routes.ts
router.post("/webhook", WhatsaapWebHookController.receive);
```

**El problema:**
- Meta envía el webhook a esta URL para TODAS las líneas configuradas
- El webhook de Meta SÍ incluye `phoneNumberId` en el body
- Pero el código actual **NO lo usa** para identificar la cuenta
- No sabemos de QUÉ línea proviene el mensaje

### Impacto

❌ No podemos guardar `UserConversation.whatsappAccountId`  
❌ No podemos usar el adapter correcto al responder  
❌ No podemos filtrar webhooks salientes por línea  
❌ No podemos aplicar métricas por línea

### Solución

#### Opción A: Extraer `phoneNumberId` del Webhook Body

```typescript
// src/infraestructure/http/controllers/whatsapp/whatsapp-hook.controller.ts

private static async processWebhook(body: any): Promise<void> {
  if (!body.entry) throw new Error("Webhook inválido: falta 'entry'");

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      const value = change.value;
      
      // 🔥 NUEVO: Extraer phoneNumberId del webhook
      const phoneNumberId = value?.metadata?.phone_number_id;
      
      if (!phoneNumberId) {
        logger.warn("Webhook sin phone_number_id, usando cuenta primaria");
      }
      
      // 🔥 NUEVO: Mapear a WhatsAppAccount
      const whatsappAccountId = phoneNumberId 
        ? await this.getAccountIdByPhoneNumberId(phoneNumberId)
        : await this.getPrimaryAccountId();
      
      const messages = value?.messages;
      if (!messages || !Array.isArray(messages)) continue;

      for (const message of messages) {
        const from = message.from;
        // ... procesamiento del mensaje ...
        
        await processMessageUseCase.execute({
          channelType: ChannelType.WHATSAPP,
          channelUserId: from,
          messageId: message.id,
          content: messageContent,
          whatsappAccountId, // ← NUEVO parámetro
          timestamp: new Date()
        });
      }
    }
  }
}

private static async getAccountIdByPhoneNumberId(
  phoneNumberId: string
): Promise<string | undefined> {
  const repository = container.resolve<IWhatsAppAccountRepository>(
    DI.WhatsAppAccountRepository
  );
  const account = await repository.findByPhoneNumberId(phoneNumberId);
  return account?.id;
}

private static async getPrimaryAccountId(): Promise<string | undefined> {
  const repository = container.resolve<IWhatsAppAccountRepository>(
    DI.WhatsAppAccountRepository
  );
  const account = await repository.findPrimary();
  return account?.id;
}
```

#### Opción B: Endpoint por Cuenta (más complejo, más seguro)

```typescript
// src/infraestructure/http/routes/whassapt/whatsapp.routes.ts

// Endpoint por slug de cuenta
router.post("/webhook/:accountSlug", WhatsaapWebHookController.receiveByAccount);

// src/infraestructure/http/controllers/whatsapp/whatsapp-hook.controller.ts

static receiveByAccount = async (req: Request, res: Response) => {
  const { accountSlug } = req.params;
  
  const repository = container.resolve<IWhatsAppAccountRepository>(
    DI.WhatsAppAccountRepository
  );
  
  const account = await repository.findBySlug(accountSlug);
  if (!account) {
    logger.error(`Cuenta no encontrada: ${accountSlug}`);
    res.sendStatus(404);
    return;
  }
  
  // Verificar token de webhook
  const webhookToken = req.query['hub.verify_token'] as string;
  if (webhookToken && webhookToken !== account.webhookVerifyToken) {
    logger.error(`Token de verificación inválido para ${accountSlug}`);
    res.sendStatus(403);
    return;
  }
  
  await WhatsaapWebHookController.processWebhookForAccount(req.body, account.id);
  res.sendStatus(200);
};
```

**Recomendación:** Usar **Opción A** primero (más simple, compatible con setup actual). Opción B requiere reconfigurar webhooks en Meta.

### Archivos Afectados

- `src/infraestructure/http/controllers/whatsapp/whatsapp-hook.controller.ts` (modificar)
- `src/app/use-cases/messaging/process-incoming-message.use-case.ts` (agregar parámetro)

---

## 🔴 GAP #2: Socket.IO con widgetId (BLOQUEADOR)

### Problema

Cuando un usuario se conecta al webchat, **NO estamos capturando de qué widget viene**:

```typescript
// src/infraestructure/socket-io.ts
webChatAdapter.initialize(this.io);

// src/infraestructure/adapters/messaging/webchat.adapter.ts
initialize(io: SocketIOServer): void {
  io.on("connection", (socket) => {
    const sessionId = socket.id;
    // ❌ NO capturamos widgetId
  });
}
```

### Impacto

❌ No podemos guardar `UserConversation.widgetId`  
❌ No podemos aplicar flow inicial del widget  
❌ No podemos filtrar webhooks salientes por widget  
❌ No podemos aplicar theme del widget

### Solución

#### 1. Cliente envía widgetId en conexión

```javascript
// public/webchat/widget.js (NUEVO ARCHIVO)
(function() {
  // Extraer widgetId de query param
  const script = document.currentScript;
  const widgetId = new URLSearchParams(script.src.split('?')[1]).get('id') || 'default';
  
  // Conectar a Socket.IO con widgetId
  const socket = io('https://api.datihub.com', {
    query: { widgetId }  // ← Pasar widgetId
  });
  
  // Renderizar widget con theme
  socket.on('connect', () => {
    console.log('WebChat conectado', { widgetId, sessionId: socket.id });
  });
  
  // ... resto del código del widget ...
})();
```

#### 2. Servidor captura widgetId

```typescript
// src/infraestructure/adapters/messaging/webchat.adapter.ts

initialize(io: SocketIOServer): void {
  io.on("connection", async (socket) => {
    const sessionId = socket.id;
    const widgetId = socket.handshake.query.widgetId as string; // ← NUEVO
    
    logger.info(`🌐 WebChat conectado`, { sessionId, widgetId });
    
    // Validar que el widget existe
    const widgetRepository = container.resolve<IWebChatWidgetRepository>(
      DI.WebChatWidgetRepository
    );
    const widget = await widgetRepository.findByWidgetId(widgetId);
    
    if (!widget || !widget.isActive) {
      logger.warn(`Widget inválido o inactivo: ${widgetId}`);
      socket.disconnect();
      return;
    }
    
    // Guardar widgetId en metadata del socket
    (socket as any).widgetId = widgetId;
    (socket as any).widget = widget;
    
    // Enviar configuración del widget al cliente
    socket.emit("widget-config", {
      theme: widget.theme,
      welcomeMessage: widget.welcomeMessage,
      placeholder: widget.placeholder,
      autoStartFlow: widget.autoStartFlow,
      initialFlowId: widget.initialFlowId
    });
    
    // Si tiene autoStartFlow, iniciar el flow
    if (widget.autoStartFlow && widget.initialFlowId) {
      // TODO: Trigger flow automáticamente
    }
    
    // ... resto de handlers ...
  });
}
```

#### 3. Pasar widgetId al crear conversación

```typescript
// Cuando se procesa el primer mensaje del widget
socket.on("user-message", async (data) => {
  const widgetId = (socket as any).widgetId;
  
  await processMessageUseCase.execute({
    channelType: ChannelType.WEBCHAT,
    channelUserId: socket.id,
    content: data.message,
    widgetId, // ← NUEVO parámetro
    timestamp: new Date()
  });
});
```

### Archivos Afectados

- **NUEVO:** `public/webchat/widget.js` (archivo JavaScript del widget)
- `src/infraestructure/adapters/messaging/webchat.adapter.ts` (capturar widgetId)
- `src/app/use-cases/messaging/process-incoming-message.use-case.ts` (agregar parámetro)
- `src/infraestructure/socket-io.ts` (configuración CORS dinámica)

---

## 🔴 GAP #3: FlowStep.templateName Breaking Change (BLOQUEADOR)

### Problema

El schema actual tiene:

```prisma
model FlowStep {
  template     WhatsAppTemplate? @relation("TemplateUsedInSteps", fields: [templateName], references: [name])
  templateName String?           @db.VarChar(255)
}

model WhatsAppTemplate {
  name  String @unique @db.VarChar(255)
  steps FlowStep[] @relation("TemplateUsedInSteps")
}
```

**Con multi-línea, `WhatsAppTemplate.name` ya NO puede ser `@unique`** porque:
- Línea Soporte tiene `welcome_message` (metaTemplateId: "abc123")
- Línea Ventas tiene `welcome_message` (metaTemplateId: "xyz789")

**Esto ROMPE la relación de Prisma.**

### Solución

#### Opción A: Cambiar a logicalGroup (RECOMENDADA)

```prisma
model FlowStep {
  // ❌ ELIMINAR
  // template     WhatsAppTemplate? @relation(fields: [templateName], references: [name])
  // templateName String?
  
  // ✅ NUEVO
  templateLogicalGroup String? @db.VarChar(255)
  
  // NO hay relación directa, se resuelve en runtime
}

model WhatsAppTemplate {
  name         String  @db.VarChar(255)  // Ya no unique global
  logicalGroup String? @db.VarChar(255)  // "welcome_message"
  
  // ❌ ELIMINAR
  // steps FlowStep[] @relation("TemplateUsedInSteps")
  
  @@unique([name, whatsappAccountId])
  @@index([logicalGroup])
}
```

#### Opción B: Relación Many-to-Many (más complejo)

```prisma
model FlowStep {
  templateDefinitions FlowStepTemplate[]
}

model FlowStepTemplate {
  flowStepId           String
  flowStep             FlowStep @relation(fields: [flowStepId], references: [id])
  templateDefinitionId String
  templateDefinition   TemplateDefinition @relation(...)
  
  @@id([flowStepId, templateDefinitionId])
}

model TemplateDefinition {
  id               String @id
  logicalGroup     String @unique
  implementations  WhatsAppTemplate[]
  flowSteps        FlowStepTemplate[]
}
```

**Recomendación:** Usar **Opción A** (logicalGroup sin relación). Más simple y funcional.

### Template Resolution Service (NECESARIO)

```typescript
// src/app/services/template-resolution.service.ts

@injectable()
export class TemplateResolutionService {
  constructor(
    @inject(DI.PrismaClient) private prisma: PrismaClient
  ) {}
  
  /**
   * Resuelve qué template usar para un step en una línea específica
   */
  async resolveTemplate(
    logicalGroup: string,
    whatsappAccountId: string
  ): Promise<WhatsAppTemplate> {
    const template = await this.prisma.whatsAppTemplate.findFirst({
      where: {
        logicalGroup,
        whatsappAccountId,
        isActive: true,
        metaStatus: "APPROVED"
      }
    });
    
    if (!template) {
      throw ErrorFactory.create(
        "not-found",
        `Plantilla "${logicalGroup}" no disponible para esta línea de WhatsApp`
      );
    }
    
    return template;
  }
}
```

### Actualizar MessageSenderService

```typescript
// src/infraestructure/services/messaging/message-sender.service.ts

async sendStepContent(step: IFlowStep, ..., context: { whatsappAccountId?: string }) {
  if (step.templateLogicalGroup) {
    // Resolver template para esta línea
    const template = await this.templateResolutionService.resolveTemplate(
      step.templateLogicalGroup,
      context.whatsappAccountId!
    );
    
    // Obtener adapter de la línea
    const adapter = await this.whatsappAdapterFactory.getAdapter(
      context.whatsappAccountId!
    );
    
    // Resolver variables
    const params = await this.templateVariableResolver.resolve(...);
    
    // Enviar usando el metaTemplateId correcto
    await adapter.sendTemplateMessage(
      channelUserId,
      template.name,  // ← Nombre específico de la línea
      params
    );
  }
}
```

### Migración de Datos

```sql
-- Agregar columna logicalGroup
ALTER TABLE "WhatsAppTemplate" ADD COLUMN "logicalGroup" VARCHAR(255);

-- Copiar name a logicalGroup para plantillas existentes
UPDATE "WhatsAppTemplate" SET "logicalGroup" = "name";

-- Actualizar FlowStep
ALTER TABLE "FlowStep" ADD COLUMN "templateLogicalGroup" VARCHAR(255);
UPDATE "FlowStep" SET "templateLogicalGroup" = "templateName";

-- Crear índice
CREATE INDEX "WhatsAppTemplate_logicalGroup_idx" ON "WhatsAppTemplate"("logicalGroup");
```

### Archivos Afectados

- `prisma/schema.prisma` (breaking change en relación)
- **NUEVO:** `src/app/services/template-resolution.service.ts`
- `src/infraestructure/services/messaging/message-sender.service.ts` (usar resolución)
- `src/domain/interfaces/types/flow-step.interface.ts` (cambiar templateName → templateLogicalGroup)

---

## 🔴 GAP #4: Migración de Datos Existentes (BLOQUEADOR)

### Problema

Si hay datos existentes en producción:
- `UserConversation` sin `whatsappAccountId` → ¿qué línea usar?
- `WhatsAppTemplate` sin `whatsappAccountId` → ¿a qué línea pertenecen?
- Variables de entorno actuales (WA_PHONE_NUMBER_ID) → ¿cómo migrar?

### Solución

#### Seeder para Cuenta Primaria

```typescript
// prisma/seeders/migrate-to-multi-line.seed.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migrateToMultiLine() {
  console.log('🔄 Migrando a sistema multi-línea...');
  
  // 1. Crear cuenta primaria desde env vars actuales
  const primaryAccount = await prisma.whatsAppAccount.upsert({
    where: { slug: 'primary' },
    update: {},
    create: {
      name: 'Línea Principal',
      slug: 'primary',
      description: 'Cuenta migrada desde configuración anterior',
      phoneNumberId: process.env.WA_PHONE_NUMBER_ID!,
      accessToken: process.env.CLOUD_API_ACCESS_TOKEN!,
      businessId: process.env.WHATSAPP_BUSINESS_ID!,
      apiVersion: process.env.CLOUD_API_VERSION || 'v21.0',
      isPrimary: true,
      isActive: true
    }
  });
  
  console.log(`✅ Cuenta primaria creada: ${primaryAccount.id}`);
  
  // 2. Asignar todas las plantillas existentes a la cuenta primaria
  const templatesUpdated = await prisma.whatsAppTemplate.updateMany({
    where: { whatsappAccountId: null },
    data: { 
      whatsappAccountId: primaryAccount.id,
      logicalGroup: prisma.raw('name') // Copiar name a logicalGroup
    }
  });
  
  console.log(`✅ ${templatesUpdated.count} plantillas migradas`);
  
  // 3. Asignar conversaciones activas a la cuenta primaria
  const conversationsUpdated = await prisma.userConversation.updateMany({
    where: { 
      channelType: 'WHATSAPP',
      whatsappAccountId: null 
    },
    data: { whatsappAccountId: primaryAccount.id }
  });
  
  console.log(`✅ ${conversationsUpdated.count} conversaciones migradas`);
  
  console.log('🎉 Migración completada');
}

migrateToMultiLine()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

#### Ejecutar Post-Migración

```bash
# Después de ejecutar la migración de Prisma
npx prisma migrate dev --name add_multi_channel_multi_line_system

# Ejecutar seeder de migración
npx tsx prisma/seeders/migrate-to-multi-line.seed.ts
```

### Archivos Afectados

- **NUEVO:** `prisma/seeders/migrate-to-multi-line.seed.ts`

---

## 🟡 GAP #5: Widget Embed Script Real

### Problema

El endpoint retorna el HTML del embed code:

```typescript
const embedCode = `<script src="${process.env.BASE_URL}/webchat/widget.js?id=${widget.widgetId}"></script>`;
```

Pero **NO existe** el archivo `public/webchat/widget.js` que:
- Renderiza el chat UI
- Se conecta a Socket.IO con el widgetId
- Aplica el theme del widget

### ⚖️ Decisión Arquitectónica: Backend vs Frontend

**❌ NO RECOMENDADO: Script generado desde Frontend Admin**
- Cada cliente tiene código duplicado inline
- Sin capacidad de hot-fix (código queda en HTML del cliente)
- Versionado imposible
- Sin telemetría de uso

**✅ RECOMENDADO: Script servido desde Backend**
- Actualizaciones centralizadas instantáneas
- Versionado (`?v=2.0.0`) y rollback
- Cache CDN agresivo (24h)
- Telemetría y analytics integrados
- Admin solo genera: `<script src="...?id=xxx"></script>`

### Solución

#### Crear Widget Script

```javascript
// public/webchat/widget.js

(function() {
  'use strict';
  
  // Extraer widgetId del script tag
  const script = document.currentScript;
  const scriptUrl = new URL(script.src);
  const widgetId = scriptUrl.searchParams.get('id') || 'default';
  const apiUrl = scriptUrl.origin;
  
  // Cargar Socket.IO
  const socketScript = document.createElement('script');
  socketScript.src = 'https://cdn.socket.io/4.5.4/socket.io.min.js';
  socketScript.onload = initWidget;
  document.head.appendChild(socketScript);
  
  function initWidget() {
    // Conectar con widgetId
    const socket = io(apiUrl, {
      query: { widgetId },
      transports: ['websocket', 'polling']
    });
    
    let widgetConfig = null;
    
    // Recibir configuración del widget
    socket.on('widget-config', (config) => {
      widgetConfig = config;
      renderWidget(config);
      
      // Auto-start flow si está configurado
      if (config.autoStartFlow) {
        console.log('Auto-starting flow:', config.initialFlowId);
      }
    });
    
    // Renderizar UI del widget
    function renderWidget(config) {
      const container = document.createElement('div');
      container.id = 'datihub-webchat-widget';
      container.innerHTML = `
        <style>
          #datihub-webchat-widget {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 350px;
            height: 500px;
            background: white;
            border-radius: 10px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            display: flex;
            flex-direction: column;
            z-index: 9999;
          }
          #datihub-chat-header {
            background: ${config.theme?.primaryColor || '#0084ff'};
            color: white;
            padding: 15px;
            border-radius: 10px 10px 0 0;
            font-weight: bold;
          }
          #datihub-chat-messages {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
          }
          #datihub-chat-input-container {
            border-top: 1px solid #eee;
            padding: 10px;
            display: flex;
            gap: 10px;
          }
          #datihub-chat-input {
            flex: 1;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 20px;
            outline: none;
          }
          #datihub-chat-send {
            background: ${config.theme?.primaryColor || '#0084ff'};
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 20px;
            cursor: pointer;
          }
          .datihub-message {
            margin-bottom: 10px;
            padding: 10px;
            border-radius: 8px;
            max-width: 80%;
          }
          .datihub-message.bot {
            background: #f0f0f0;
            align-self: flex-start;
          }
          .datihub-message.user {
            background: ${config.theme?.primaryColor || '#0084ff'};
            color: white;
            align-self: flex-end;
            margin-left: auto;
          }
        </style>
        
        <div id="datihub-chat-header">
          ${config.theme?.headerTitle || 'Chat'}
        </div>
        
        <div id="datihub-chat-messages">
          ${config.welcomeMessage ? `<div class="datihub-message bot">${config.welcomeMessage}</div>` : ''}
        </div>
        
        <div id="datihub-chat-input-container">
          <input 
            id="datihub-chat-input" 
            type="text" 
            placeholder="${config.placeholder || 'Escribe un mensaje...'}"
          />
          <button id="datihub-chat-send">Enviar</button>
        </div>
      `;
      
      document.body.appendChild(container);
      
      // Event listeners
      const input = document.getElementById('datihub-chat-input');
      const sendBtn = document.getElementById('datihub-chat-send');
      const messages = document.getElementById('datihub-chat-messages');
      
      function sendMessage() {
        const text = input.value.trim();
        if (!text) return;
        
        // Mostrar mensaje del usuario
        const userMsg = document.createElement('div');
        userMsg.className = 'datihub-message user';
        userMsg.textContent = text;
        messages.appendChild(userMsg);
        messages.scrollTop = messages.scrollHeight;
        
        // Enviar al servidor
        socket.emit('user-message', { message: text });
        
        input.value = '';
      }
      
      sendBtn.addEventListener('click', sendMessage);
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
      });
      
      // Recibir mensajes del bot
      socket.on('bot-message', (data) => {
        const botMsg = document.createElement('div');
        botMsg.className = 'datihub-message bot';
        botMsg.textContent = data.message;
        messages.appendChild(botMsg);
        messages.scrollTop = messages.scrollHeight;
      });
    }
  }
})();
```

### Endpoint para Servir el Script

```typescript
// src/infraestructure/http/routes/webchat-widget.routes.ts

router.get("/widget.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "../../../public/webchat/widget.js"));
});
```

### Archivos Afectados

- **MIGRAR:** `public/webchat/widget.css` (desde datihub_frontend)
- **MIGRAR:** `public/webchat/widget.js` (desde datihub_frontend)
- **NUEVO:** `src/infraestructure/http/controllers/webchat/widget-script.controller.ts`
- **NUEVO:** `src/infraestructure/http/routes/webchat-widget.routes.ts`
- **NUEVO:** `src/infraestructure/http/controllers/webchat/widget-config.controller.ts` (GET /api/chatbot-config/:companyId)
- **NUEVO:** `src/infraestructure/http/controllers/webchat/webchat-incoming.controller.ts` (POST /api/webchat/incoming)
- **NUEVO:** `src/app/queries/conversation/get-conversation-messages.query.ts` (GET /api/conversations/:id/messages?since=...)

---

## 🟡 GAP #6: ProcessIncomingMessageUseCase Actualización

### Problema

El Use Case actual no recibe `whatsappAccountId` ni `widgetId`:

```typescript
export interface ProcessIncomingMessageInput {
  channelType: ChannelType;
  channelUserId: string;
  messageId: string;
  content: string;
  timestamp: Date;
  interactiveResponse?: any;
}
```

### Solución

```typescript
export interface ProcessIncomingMessageInput {
  channelType: ChannelType;
  channelUserId: string;
  messageId: string;
  content: string;
  timestamp: Date;
  interactiveResponse?: any;
  
  // 🔥 NUEVOS parámetros
  whatsappAccountId?: string;  // Para WHATSAPP
  widgetId?: string;           // Para WEBCHAT
}

@injectable()
export class ProcessIncomingMessageUseCase {
  async execute(input: ProcessIncomingMessageInput): Promise<void> {
    // ... lógica existente ...
    
    // Crear o actualizar conversación con contexto
    const conversation = await this.conversationRepository.upsert({
      channelType: input.channelType,
      channelUserId: input.channelUserId,
      whatsappAccountId: input.whatsappAccountId, // ← NUEVO
      widgetId: input.widgetId,                   // ← NUEVO
      // ... resto de campos ...
    });
    
    // ... resto de lógica ...
  }
}
```

### Archivos Afectados

- `src/app/use-cases/messaging/process-incoming-message.use-case.ts`

---

## 🟡 GAP #7: CORS Dinámico por Widget

### Problema

CORS actualmente está configurado globalmente:

```typescript
// src/infraestructure/socket-io.ts
this.io = new SocketIOServer(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});
```

Con `WebChatWidget.allowedOrigins`, necesitamos validar origen según widget.

### Solución

```typescript
// src/infraestructure/socket-io.ts

this.io = new SocketIOServer(server, {
  cors: {
    origin: async (origin, callback) => {
      if (!origin) {
        // Permitir requests sin origen (ej: Postman)
        callback(null, true);
        return;
      }
      
      // Buscar widgets que permitan este origen
      const widgets = await prisma.webChatWidget.findMany({
        where: {
          isActive: true,
          allowedOrigins: {
            array_contains: [origin]
          }
        }
      });
      
      if (widgets.length > 0) {
        callback(null, true);
      } else {
        callback(new Error(`Origen no permitido: ${origin}`));
      }
    },
    methods: ["GET", "POST"]
  }
});
```

**Nota:** Esto puede ser costoso. Alternativa: cachear `allowedOrigins` en Redis.

### Archivos Afectados

- `src/infraestructure/socket-io.ts`

---

## 🟡 GAP #8: Encrypting Access Tokens

### Problema

`WhatsAppAccount.accessToken` es muy sensible (permite enviar mensajes). Debería estar encriptado en BD.

### Solución

#### Middleware de Encriptación

```typescript
// src/shared/utils/crypto.util.ts

import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!; // 32 bytes
const IV_LENGTH = 16;

export class CryptoUtil {
  static encrypt(text: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(
      'aes-256-cbc',
      Buffer.from(ENCRYPTION_KEY, 'hex'),
      iv
    );
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
  }
  
  static decrypt(encryptedText: string): string {
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.from(ENCRYPTION_KEY, 'hex'),
      iv
    );
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
}
```

#### Usar en Repository

```typescript
// src/infraestructure/database/persistences/repositories/whatsapp-account.prisma.repository.ts

async create(account: WhatsAppAccountEntity): Promise<WhatsAppAccountEntity> {
  return await this.executeSafe(async () => {
    const created = await this.prisma.whatsAppAccount.create({
      data: {
        // ...
        accessToken: CryptoUtil.encrypt(account.accessToken), // ← Encriptar
        // ...
      }
    });
    
    return WhatsAppAccountBuilder.fromPrisma({
      ...created,
      accessToken: CryptoUtil.decrypt(created.accessToken) // ← Desencriptar al retornar
    });
  });
}
```

### Archivos Afectados

- **NUEVO:** `src/shared/utils/crypto.util.ts`
- `src/infraestructure/database/persistences/repositories/whatsapp-account.prisma.repository.ts`
- `.env` (agregar `ENCRYPTION_KEY`)

---

## 🟡 GAP #9: Cache Invalidation

### Problema

`WhatsAppAdapterFactory` cachea adapters en memoria. Si se actualizan credenciales, el cache queda stale.

### Solución

#### API Endpoint para Invalidar

```typescript
// src/infraestructure/http/controllers/whatsapp-account/whatsapp-account.controller.ts

static async update(req: Request, res: Response) {
  const { id } = req.params;
  const repository = container.resolve(DI.WhatsAppAccountRepository);
  const factory = container.resolve(DI.WhatsAppAdapterFactory);
  
  const updated = await repository.update(id, req.body);
  
  // 🔥 Invalidar cache
  factory.invalidateAdapter(id);
  
  ResponseBuilder.sendSuccess(res, updated, "Cuenta actualizada exitosamente");
}
```

#### Event-Based Invalidation

```typescript
// src/app/commands/whatsapp-account/update-whatsapp-account.handler.ts

@injectable()
export class UpdateWhatsAppAccountHandler {
  constructor(
    @inject(DI.WhatsAppAccountRepository) private repository: IWhatsAppAccountRepository,
    @inject(DI.WhatsAppAdapterFactory) private factory: WhatsAppAdapterFactory,
    @inject(DI.EventBus) private eventBus: IEventBus
  ) {}
  
  async execute(command: UpdateWhatsAppAccountCommand): Promise<void> {
    const updated = await this.repository.update(command.id, command.data);
    
    // Publicar evento
    await this.eventBus.publish({
      type: 'whatsapp-account.updated',
      payload: { accountId: command.id }
    });
    
    // Invalidar cache
    this.factory.invalidateAdapter(command.id);
  }
}
```

### Archivos Afectados

- `src/infraestructure/adapters/messaging/whatsapp-adapter.factory.ts` (ya tiene método `invalidateAdapter`)
- `src/infraestructure/http/controllers/whatsapp-account/whatsapp-account.controller.ts`

---

## 🟢 GAP #10: Auto-Calculate Compatibility Triggers

### Problema

El command `CalculateFlowCompatibilityCommand` existe pero no se ejecuta automáticamente cuando:
- Se crea/actualiza un Flow con templates
- Se crea/actualiza/aprueba una WhatsAppTemplate

### Solución

#### Opción A: Prisma Middleware

```typescript
// src/infraestructure/database/middlewares/flow-compatibility.middleware.ts

prisma.$use(async (params, next) => {
  const result = await next(params);
  
  // Trigger recalculation when Flow is updated
  if (params.model === 'Flow' && (params.action === 'create' || params.action === 'update')) {
    const flowId = result.id;
    
    // Ejecutar en background
    setImmediate(async () => {
      const handler = container.resolve(CalculateFlowCompatibilityHandler);
      await handler.execute(new CalculateFlowCompatibilityCommand(flowId));
    });
  }
  
  // Trigger recalculation when Template is created/updated
  if (params.model === 'WhatsAppTemplate' && (params.action === 'create' || params.action === 'update')) {
    const logicalGroup = result.logicalGroup;
    
    if (logicalGroup) {
      setImmediate(async () => {
        // Buscar todos los flows que usan este logicalGroup
        const flows = await prisma.flow.findMany({
          where: {
            requiredTemplateLogicalGroups: {
              array_contains: [logicalGroup]
            }
          }
        });
        
        const handler = container.resolve(CalculateFlowCompatibilityHandler);
        for (const flow of flows) {
          await handler.execute(new CalculateFlowCompatibilityCommand(flow.id));
        }
      });
    }
  }
  
  return result;
});
```

#### Opción B: Job Scheduled

```typescript
// src/infraestructure/jobs/calculate-flow-compatibility.job.ts

import cron from 'node-cron';

export function scheduleFlowCompatibilityCalculation() {
  // Ejecutar diariamente a las 3 AM
  cron.schedule('0 3 * * *', async () => {
    logger.info('🔄 Recalculando compatibilidad de flows...');
    
    const flows = await prisma.flow.findMany({
      where: { requiresTemplates: true }
    });
    
    const handler = container.resolve(CalculateFlowCompatibilityHandler);
    
    for (const flow of flows) {
      try {
        await handler.execute(new CalculateFlowCompatibilityCommand(flow.id));
      } catch (error) {
        logger.error(`Error calculando compatibilidad de flow ${flow.id}:`, error);
      }
    }
    
    logger.info(`✅ Compatibilidad recalculada para ${flows.length} flows`);
  });
}
```

### Archivos Afectados

- **NUEVO:** `src/infraestructure/database/middlewares/flow-compatibility.middleware.ts`
- **NUEVO:** `src/infraestructure/jobs/calculate-flow-compatibility.job.ts`

---

## 🟢 GAP #11: Metrics Dimensiones

### Problema

Sistema de métricas actual no incluye `whatsappAccountId` ni `widgetId` como dimensiones.

### Solución

```typescript
// src/app/builders/metric-event.builder.ts

withWhatsAppAccountId(whatsappAccountId: string): this {
  this.whatsappAccountId = whatsappAccountId;
  return this;
}

withWidgetId(widgetId: string): this {
  this.widgetId = widgetId;
  return this;
}
```

```typescript
// Al crear métrica
metricBuilder
  .withEventType(MetricEventType.CONVERSATION_STARTED)
  .withConversationId(conversation.id)
  .withChannelType(conversation.channelType)
  .withWhatsAppAccountId(conversation.whatsappAccountId) // ← NUEVO
  .withWidgetId(conversation.widgetId)                   // ← NUEVO
  .build();
```

### Archivos Afectados

- `src/app/builders/metric-event.builder.ts`
- Todos los lugares que crean métricas

---

## 🟢 GAP #12: Template Cloning API

### Problema

Admins necesitan duplicar plantillas a múltiples líneas fácilmente.

### Solución

```typescript
// src/app/commands/whatsapp-template/clone-template.command.ts

export interface CloneTemplateInput {
  sourceTemplateId: string;
  targetAccountIds: string[];
}

export class CloneTemplateCommand {
  constructor(public readonly input: CloneTemplateInput) {}
}

// Handler
@injectable()
export class CloneTemplateHandler {
  async execute(command: CloneTemplateCommand): Promise<WhatsAppTemplate[]> {
    const { sourceTemplateId, targetAccountIds } = command.input;
    
    const sourceTemplate = await this.templateRepository.findById(sourceTemplateId);
    if (!sourceTemplate) {
      throw ErrorFactory.create("not-found", "Plantilla origen no encontrada");
    }
    
    const cloned: WhatsAppTemplate[] = [];
    
    for (const accountId of targetAccountIds) {
      const newTemplate = await this.templateRepository.create({
        ...sourceTemplate,
        id: undefined, // Generar nuevo ID
        whatsappAccountId: accountId,
        name: `${sourceTemplate.name}_${accountId.substring(0, 6)}`, // Evitar colisión
        logicalGroup: sourceTemplate.logicalGroup, // Mismo grupo lógico
        metaTemplateId: null, // Debe crearse manualmente en Meta
        metaStatus: "PENDING"
      });
      
      cloned.push(newTemplate);
    }
    
    return cloned;
  }
}
```

### Archivos Afectados

- **NUEVO:** `src/app/commands/whatsapp-template/clone-template.command.ts`
- **NUEVO:** `src/app/commands/whatsapp-template/clone-template.handler.ts`

---

## 🟢 GAP #13: Webhook Configuration UI Helper

### Problema

Configurar webhooks en Meta para cada línea es manual y propenso a errores.

### Solución

#### Endpoint Helper

```typescript
// GET /api/whatsapp-accounts/:id/webhook-config

static async getWebhookConfig(req: Request, res: Response) {
  const { id } = req.params;
  const repository = container.resolve(DI.WhatsAppAccountRepository);
  const account = await repository.findById(id);
  
  if (!account) {
    throw ErrorFactory.create("not-found", "Cuenta no encontrada");
  }
  
  const baseUrl = process.env.BASE_URL || 'https://api.datihub.com';
  
  const config = {
    webhookUrl: `${baseUrl}/whatsapp/webhook`,
    verifyToken: account.webhookVerifyToken || 'GENERATE_ONE',
    instructions: [
      '1. Ve a Meta Business Manager',
      '2. Selecciona tu app de WhatsApp',
      '3. Ve a Webhooks',
      '4. Suscríbete a los siguientes campos: messages, message_status',
      `5. Configura la URL de callback: ${baseUrl}/whatsapp/webhook`,
      `6. Usa el verify token: ${account.webhookVerifyToken || 'GENERATE_ONE'}`,
      '7. Verifica el webhook'
    ]
  };
  
  ResponseBuilder.sendSuccess(res, config, "Configuración de webhook obtenida");
}
```

### Archivos Afectados

- `src/infraestructure/http/controllers/whatsapp-account/whatsapp-account.controller.ts`

---

## 📊 Priorización de Gaps

### Fase 1: Bloqueadores (implementar primero)
1. ✅ GAP #1: Webhook receiver multi-línea
2. ✅ GAP #2: Socket.IO con widgetId
3. ✅ GAP #3: FlowStep.templateName breaking change
4. ✅ GAP #4: Migración de datos

### Fase 2: Funcionalidad Core
5. ✅ GAP #6: ProcessIncomingMessageUseCase
6. ✅ GAP #5: Widget embed script

### Fase 3: Mejoras de Calidad
7. ✅ GAP #8: Encrypting access tokens
8. ✅ GAP #7: CORS dinámico
9. ✅ GAP #9: Cache invalidation

### Fase 4: Nice to Have
10. ✅ GAP #10: Auto-calculate compatibility
11. ✅ GAP #11: Metrics dimensiones
12. ✅ GAP #12: Template cloning API
13. ✅ GAP #13: Webhook config helper

---

## 📝 Commits Adicionales Sugeridos

```bash
# GAP #1
feat(webhook): add multi-line whatsapp webhook routing by phoneNumberId

# GAP #2
feat(webchat): add widgetId capture in socket.io connection

# GAP #3 (BREAKING)
refactor(templates)!: change FlowStep.templateName to templateLogicalGroup

BREAKING CHANGE: FlowStep.template relation removed. Use templateLogicalGroup with runtime resolution.

# GAP #4
chore(seed): add migration script for existing data to primary account

# GAP #5
feat(widget): add webchat widget.js embed script with socket.io integration

# GAP #6
feat(messaging): add whatsappAccountId and widgetId to ProcessIncomingMessageUseCase

# GAP #7
feat(cors): add dynamic CORS validation by widget allowedOrigins

# GAP #8
feat(security): add AES-256 encryption for WhatsAppAccount accessToken

# GAP #9
feat(cache): add adapter cache invalidation on account update

# GAP #10
feat(jobs): add scheduled job to recalculate flow compatibility

# GAP #11
feat(metrics): add whatsappAccountId and widgetId dimensions to metric events

# GAP #12
feat(templates): add clone template command for multi-line replication

# GAP #13
feat(webhooks): add helper endpoint for Meta webhook configuration instructions
```

---

**Fin del Documento de GAPS**
