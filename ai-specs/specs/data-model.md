# Documentación del Modelo de Datos - DatiHub

Este documento describe el modelo de datos de DatiHub, un sistema de chatbot conversacional multi-canal con soporte para flujos estructurados, IA generativa, y derivación a agentes humanos.

El modelo está implementado sobre **PostgreSQL** usando **Prisma ORM**.

---

## Índice

1. [Enums del Sistema](#1-enums-del-sistema)
2. [User & Session](#2-user--session)
3. [Flujos Conversacionales](#3-flujos-conversacionales)
4. [Pasos y Opciones](#4-pasos-y-opciones)
5. [Conversaciones y Canales](#5-conversaciones-y-canales)
6. [Usuarios del Chatbot](#6-usuarios-del-chatbot)
7. [Segmentación y Etiquetas](#7-segmentación-y-etiquetas)
8. [Métricas y Auditoría](#8-métricas-y-auditoría)
9. [Webhooks](#9-webhooks)
10. [Base de Conocimiento (RAG)](#10-base-de-conocimiento-rag)
11. [WhatsApp Multi-Cuenta](#11-whatsapp-multi-cuenta)
12. [WebChat Widgets](#12-webchat-widgets)
13. [Handoff a Agentes Humanos](#13-handoff-a-agentes-humanos)
14. [Jobs y Scheduling](#14-jobs-y-scheduling)

---

## 1. Enums del Sistema

### Role
Roles de usuarios internos del sistema.
```typescript
enum Role {
  ADMIN      // Administrador del sistema
  OPERATOR   // Operador de chats
  SUPER_ADMIN // Super administrador
}
```

### ChannelType
Canales de comunicación soportados.
```typescript
enum ChannelType {
  WHATSAPP  // WhatsApp Business API
  WEBCHAT   // Widget web embebible
  TELEGRAM  // Bot de Telegram
  SMS       // Mensajes SMS
}
```

### ConversationMode
Modo de conversación activo.
```typescript
enum ConversationMode {
  FLOW    // Flujo estructurado pre-definido
  AI      // Conversación con IA (LLM)
  HUMAN   // Derivado a agente humano
}
```

### FlowType
Tipo de comportamiento del flujo.
```typescript
enum FlowType {
  STANDARD  // Solo flujo rígido (comportamiento actual)
  ROUTER    // Decide dinámicamente entre FLOW o AI
  FLOW_TO_AI // Comienza en flujo, puede pasar a IA
  AI_ONLY   // Solo respuestas generadas por IA
}
```

### AIProvider
Proveedores de IA soportados.
```typescript
enum AIProvider {
  BEDROCK   // AWS Bedrock (Claude, etc.)
  OPENAI    // OpenAI GPT
  ANTHROPIC // Anthropic Claude directo
}
```

### StepType
Tipos de pasos en un flujo.
```typescript
enum StepType {
  text          // Mensaje de texto
  options       // Opciones seleccionables
  input         // Campo de entrada del usuario
  file_upload   // Solicitud de archivo
  template      // Plantilla de WhatsApp
  ai_handoff   // Transición a modo IA
  flow_trigger  // Trigger para cambiar a otro flujo
  system        // Step silencioso - ejecuta acción sin enviar mensaje
}
```

### MessageFormat
Formato del mensaje.
```typescript
enum MessageFormat {
  plain       // Texto plano
  interactive  // Mensaje interactivo (botones, listas)
}
```

### ActionType
Tipos de acciones ejecutables en un paso.
```typescript
enum ActionType {
  send_email
  send_webhooks
  crm_handover
  custom
  crm_create_contact
  crm_update_contact
  crm_create_task
  save_consent
  crm_send_followup
}
```

### ConversationStatus
Estado de una conversación.
```typescript
enum ConversationStatus {
  in_progress
  completed
  abandoned
  stucked
  restarted
  adverse_event_detected
}
```

### FileType
Tipos de archivo soportados.
```typescript
enum FileType {
  image
  pdf
  document
  other
}
```

### ScheduleStatus
Estado de un flujo programado.
```typescript
enum ScheduleStatus {
  pending
  completed
  error
}
```

### MetricType
Tipos de eventos métricos.
```typescript
enum MetricType {
  start
  completed
  abandoned
  step_visited
  redirected_to_human
  adverse_event_detected
  file_received
  message_received
  message_sent
  fallback
  completion_time
  step_time
  mass_send_error
  // Métricas de IA
  flow_to_ai
  ai_to_flow
  flow_to_flow
  ai_response_generated
  rag_query_executed
  function_called
}
```

### ExecutionMessageType
Tipos de mensaje en logs de ejecución.
```typescript
enum ExecutionMessageType {
  sent
  received
  error
  webhook
  action
  fallback
  email
}
```

### WebhookEvent
Eventos que pueden disparar webhooks.
```typescript
enum WebhookEvent {
  CONVERSATION_STARTED
  CONVERSATION_COMPLETED
  CONVERSATION_ABANDONED
  AI_MODE_ACTIVATED
  FLOW_MODE_ACTIVATED
  HUMAN_MODE_ACTIVATED
  FLOW_STEP_COMPLETED
  ADVERSE_EVENT_DETECTED
  USER_TRANSFER_REQUESTED
  FOLLOWUP_CREATED
}
```

### WebhookStatus
Estado de un webhook.
```typescript
enum WebhookStatus {
  ACTIVE
  INACTIVE
  FAILED
}
```

### NotificationType
Tipos de notificación.
```typescript
enum NotificationType {
  adverse_event
  manual_flow_start
  flow_completed
  crm_handover
  custom
}
```

### CrmType
Tipos de CRM soportados.
```typescript
enum CrmType {
  ODOO
  SALESFORCE
  HUBSPOT
  PIPEDRIVE
  ZOHO
  CUSTOM
}
```

### HandoffDestinationType
Tipo de destino para derivación.
```typescript
enum HandoffDestinationType {
  EXTERNAL_WEBHOOK  // CRM externo (Odoo, Dolibarr, etc.)
  INTERNAL_DASHBOARD // Dashboard interno via Socket.IO
}
```

### JobSource
Origen de un job programado.
```typescript
enum JobSource {
  MANUAL
  EVENT
}
```

### ExecStatus
Estado de ejecución de un job.
```typescript
enum ExecStatus {
  RUNNING
  SUCCESS
  FAILED
  DEAD
}
```

---

## 2. User & Session

### User
Usuarios internos del sistema (administradores y operadores).

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `email` | String @unique | Correo electrónico |
| `password` | String | Hash de contraseña |
| `name` | String | Nombre completo |
| `role` | Role | Rol del usuario (ADMIN, OPERATOR, SUPER_ADMIN) |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `sessions`: Uno-a-muchos con Session

---

### Session
Gestión de sesiones activas de usuarios internos.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `userId` | String (FK) | Referencia a User |
| `token` | String @unique | Token de sesión (512 chars) |
| `refreshToken` | String? @unique | Token de refresco opcional |
| `expiresAt` | DateTime | Expiración del access token |
| `refreshExpiresAt` | DateTime? | Expiración del refresh token |
| `userAgent` | String? | Navegador/dispositivo |
| `ip` | String? | Dirección IP |

**Relaciones:**
- `user`: Muchos-a-uno con User

---

## 3. Flujos Conversacionales

### Flow
Representa un flujo conversacional completo.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `name` | String | Nombre del flujo |
| `description` | String | Descripción funcional |
| `status` | String | Estado del flujo |
| `isActive` | Boolean | Si está activo |
| `isAutoResponse` | Boolean | Si se usa como respuesta automática |
| `triggerType` | TriggerType | auto o manual |
| `triggerConditions` | Json? | Condiciones de trigger |
| `repeatIntervalDays` | Int? | Intervalo de repetición |
| `basedOnField` | String? | Campo base para decisiones |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

#### Configuración de IA

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `flowType` | FlowType? | STANDARD, ROUTER, FLOW_TO_AI, AI_ONLY |
| `aiProvider` | AIProvider? | BEDROCK, OPENAI, ANTHROPIC |
| `aiModel` | String? | Modelo LLM (ej: "anthropic.claude-3-sonnet-20240229-v1:0") |
| `systemPrompt` | String? | Prompt base del sistema |
| `temperature` | Float? | Nivel de creatividad (default 0.7) |
| `maxTokens` | Int? | Límite de tokens (default 1000) |
| `useRAG` | Boolean? | Habilita recuperación de conocimiento |
| `knowledgeBaseId` | String? | FK a KnowledgeBase para RAG |
| `ragMaxResults` | Int? | Resultados máximos en RAG (default 5) |
| `enableFunctions` | Boolean? | Habilita funciones Tool Use |
| `allowedFunctions` | Json? | Lista de funciones permitidas |
| `toolsConfig` | Json? | Tools externos para Claude Tool Use. Solo aplica cuando `aiProvider = ANTHROPIC`. Formato: `{ "tools": [{ name, description, endpoint, apiKey?, timeoutMs?, input_schema }] }`. El campo `apiKey` acepta prefijo `$` para resolver desde variable de entorno (el secreto nunca se almacena en texto plano). |

#### Configuración de Bedrock Agents

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `agentId` | String? | Bedrock Agent ID directo |
| `agentAliasId` | String? | Bedrock Agent Alias ID |

#### Supervisor Multi-Agente

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `supervisorAgentId` | String? | Supervisor que actúa como router |
| `supervisorAgentAliasId` | String? | Alias del supervisor |
| `subAgentsConfig` | Json? | Mapa de sub-agentes `{ "nombre": { agentId, agentAliasId } }` |

#### Compatibilidad con Templates

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `requiresTemplates` | Boolean | Si el flujo usa templates de WhatsApp |
| `requiredTemplateLogicalGroups` | String[] | Grupos lógicos de templates requeridos |
| `compatibleWhatsAppAccountIds` | String[] | Cuentas con templates necesarias |

#### Handoff a Agentes Humanos

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `handoffDestinationId` | String? | FK a HandoffDestination |

**Relaciones:**
- `flowSteps`: Uno-a-muchos con FlowStep
- `conversations`: Uno-a-muchos con UserConversation
- `metrics`: Uno-a-muchos con FlowMetricEvent
- `tags`: Muchos-a-muchos con Tag (vía FlowTag)
- `segments`: Muchos-a-muchos con Segment (vía FlowSegment)
- `flowSchedules`: Uno-a-muchos con FlowSchedule
- `knowledgeBase`: Muchos-a-uno con KnowledgeBase (opcional)
- `handoffDestination`: Muchos-a-uno con HandoffDestination (opcional)

---

### FlowSchedule
Programación de envíos de flujos.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `userId` | String | Usuario que creó la programación |
| `flowId` | String (FK) | Referencia a Flow |
| `scheduledDate` | DateTime | Fecha/hora programada |
| `status` | ScheduleStatus | pending, completed, error |
| `errorMessage` | String? | Mensaje de error si falló |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `flow`: Muchos-a-uno con Flow

---

## 4. Pasos y Opciones

### FlowStep
Define cada paso individual dentro de un flujo.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `flowId` | String (FK) | Referencia a Flow |
| `stepIndex` | Int | Orden del paso |
| `type` | StepType | Tipo de paso |
| `content` | String | Contenido del mensaje |
| `messageFormat` | MessageFormat | plain o interactive |
| `imageUrl` | String? | URL de imagen |
| `videoUrl` | String? | URL de video |
| `documentUrl` | String? | URL de documento |
| `documentFilename` | String? | Nombre del archivo |
| `locationLatitude` | Float? | Latitud para ubicación |
| `locationLongitude` | Float? | Longitud para ubicación |
| `locationName` | String? | Nombre del lugar |
| `locationAddress` | String? | Dirección del lugar |
| `nextStepDefaultId` | String? | Paso siguiente por defecto |
| `requiresHandover` | Boolean | Si requiere derivación |
| `templateLogicalGroup` | String? | Grupo lógico de template |
| `templateParams` | Json? | Parámetros de resolución de variables |
| `actionType` | ActionType? | Tipo de acción a ejecutar |
| `crmField` | String? | Campo CRM a mapear |
| `aiHandoffConfig` | Json? | Configuración de handoff a IA |
| `targetFlowId` | String? | ID del flujo a activar |
| `actionConfigId` | String? | FK a StepActionConfig |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `flow`: Muchos-a-uno con Flow
- `options`: Uno-a-muchos con StepOption
- `userConversations`: Uno-a-muchos con UserConversation (currentStep)
- `metrics`: Uno-a-muchos con FlowMetricEvent
- `executionLogs`: Uno-a-muchos con FlowExecutionLog
- `actionConfig`: Muchos-a-uno con StepActionConfig (opcional)
- `userAnswers`: Uno-a-muchos con UserAnswer

---

### StepOption
Opciones seleccionables en un paso de tipo "options".

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `flowStepId` | String (FK) | Referencia a FlowStep |
| `label` | String | Texto visible |
| `value` | String | Valor interno |
| `nextStepId` | String? | Paso siguiente al seleccionar |
| `triggersAction` | Boolean | Si dispara una acción |
| `crmField` | String? | Campo CRM a mapear |
| `targetFlowId` | String? | Flujo a activar al seleccionar |
| `triggersAIHandoff` | Boolean | Si activa transición a IA |
| `aiHandoffConfig` | Json? | Configuración específica del handoff |

**Relaciones:**
- `flowStep`: Muchos-a-uno con FlowStep

---

### StepActionConfig
Configuración reusable de acciones para pasos.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `name` | String @unique | Nombre descriptivo |
| `type` | ActionType | Tipo de acción |
| `config` | Json | Configuración específica |
| `isActive` | Boolean | Si está activa |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `steps`: Uno-a-muchos con FlowStep

---

## 5. Conversaciones y Canales

### UserConversation
Representa una conversación activa o histórica con un usuario final.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `channelType` | ChannelType | WHATSAPP, WEBCHAT, TELEGRAM, SMS |
| `channelUserId` | String | Identificador en el canal (phone, sessionId, etc.) |
| `chatbotUserId` | String? | FK a ChatbotUser (null = anónimo) |
| `whatsappAccountId` | String? | FK a WhatsAppAccount (línea usada) |
| `widgetId` | String? | FK a WebChatWidget |
| `flowId` | String (FK) | Referencia a Flow |
| `mode` | ConversationMode | FLOW, AI, HUMAN |
| `startedAt` | DateTime | Cuándo inició |
| `completedAt` | DateTime? | Cuándo completó |
| `status` | ConversationStatus | Estado de la conversación |
| `currentStepId` | String? | Paso actual |
| `invalidAnswersCount` | Int | Respuestas inválidas acumuladas |
| `originalConversationId` | String? | Conversación original (para usuarios atascados) |
| `visitorMetadata` | Json? | Metadata del visitante {name, email, location} |
| `channelMetadata` | Json? | Metadata específica del canal |
| `modeHistory` | Json? | Historial de cambios de modo |
| `aiContext` | Json? | Contexto de conversación con IA |
| `aiMessageCount` | Int | Contador de mensajes IA |
| `handoffAt` | DateTime? | Cuándo se activó modo HUMAN |
| `handoffReason` | String? | Razón de la derivación |
| `handoffExternalId` | String? | ID del ticket en CRM externo |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Índices:**
- `@@unique([channelType, channelUserId])` - Un usuario no puede tener 2 conversaciones activas en el mismo canal

**Relaciones:**
- `chatbotUser`: Muchos-a-uno con ChatbotUser (opcional)
- `whatsappAccount`: Muchos-a-uno con WhatsAppAccount (opcional)
- `widget`: Muchos-a-uno con WebChatWidget (opcional)
- `flow`: Muchos-a-uno con Flow
- `currentStep`: Muchos-a-uno con FlowStep (opcional)
- `userAnswers`: Uno-a-muchos con UserAnswer
- `userFiles`: Uno-a-muchos con UserFile
- `flowLogs`: Uno-a-muchos con FlowExecutionLog

---

### UserAnswer
Respuestas del usuario en una conversación.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `conversationId` | String (FK) | Referencia a UserConversation |
| `stepId` | String (FK) | Referencia a FlowStep |
| `answer` | String | Respuesta del usuario |
| `createdAt` | DateTime | Fecha de creación |

**Relaciones:**
- `conversation`: Muchos-a-uno con UserConversation
- `step`: Muchos-a-uno con FlowStep

---

### UserFile
Archivos subidos por el usuario.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `conversationId` | String (FK) | Referencia a UserConversation |
| `stepId` | String | Paso donde se subió |
| `fileType` | FileType | image, pdf, document, other |
| `fileUrl` | String | URL del archivo |
| `originalName` | String | Nombre original |
| `createdAt` | DateTime | Fecha de creación |

**Relaciones:**
- `conversation`: Muchos-a-uno con UserConversation

---

## 6. Usuarios del Chatbot

### ChatbotUser
Usuario final del chatbot, independiente del canal.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `phone` | String? | Teléfono (no único, no obligatorio) |
| `email` | String? | Email |
| `name` | String? | Nombre |
| `crmId` | String? | ID en CRM externo |
| `crmType` | CrmType? | Tipo de CRM |
| `crmStatus` | String? | Estado en el CRM |
| `crmSyncedAt` | DateTime? | Última sincronización |
| `acceptsWhatsapp` | Boolean | Si acepta WhatsApp |
| `currentFlowId` | String? | Flujo actual |
| `lastFlowSentAt` | DateTime? | Último flujo enviado |
| `nextFollowupDate` | DateTime? | Próxima fecha de seguimiento |
| `customFields` | Json? | Campos personalizados por industria |
| `flowHistory` | Json? | Historial de flujos |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `conversations`: Uno-a-muchos con UserConversation
- `channelLinks`: Uno-a-muchos con UserChannelLink
- `tags`: Muchos-a-muchos con Tag (vía UserTag)
- `segments`: Muchos-a-muchos con Segment (vía UserSegment)

**Índices:**
- `@@index([crmId, crmType])`
- `@@index([phone])`
- `@@index([email])`

---

### UserChannelLink
Mapeo de un usuario a múltiples canales.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `chatbotUserId` | String (FK) | Referencia a ChatbotUser |
| `whatsappPhone` | String? | Teléfono de WhatsApp |
| `webchatEmail` | String? | Email de WebChat |
| `webchatSessionId` | String? | Session ID de WebChat |
| `telegramId` | String? | ID de Telegram |
| `smsPhone` | String? | Teléfono SMS |
| `customIdentifiers` | Json? | Identificadores custom {slack_id, discord_id, etc.} |
| `linkedAt` | DateTime | Cuándo se vinculó |
| `verifiedAt` | DateTime? | Cuándo se verificó |
| `isActive` | Boolean | Si está activo |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `chatbotUser`: Muchos-a-uno con ChatbotUser

**Índices:**
- `@@unique([chatbotUserId, whatsappPhone])`
- `@@unique([chatbotUserId, webchatEmail])`
- `@@unique([chatbotUserId, telegramId])`
- `@@index([chatbotUserId])`
- `@@index([whatsappPhone])`
- `@@index([webchatEmail])`
- `@@index([telegramId])`

---

## 7. Segmentación y Etiquetas

### Tag
Etiquetas para categorización.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `name` | String @unique | Nombre único |
| `description` | String? | Descripción |
| `color` | String? | Color en hex |
| `category` | String? | Categoría |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `users`: Muchos-a-muchos con ChatbotUser (vía UserTag)
- `flows`: Muchos-a-muchos con Flow (vía FlowTag)

---

### UserTag
Asociación usuario-etiqueta.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `userId` | String (FK) | Referencia a ChatbotUser |
| `tagId` | String (FK) | Referencia a Tag |
| `addedAt` | DateTime | Cuándo se agregó |

**Relaciones:**
- `user`: Muchos-a-uno con ChatbotUser
- `tag`: Muchos-a-uno con Tag

**Índices:**
- `@@unique([userId, tagId])`

---

### Segment
Segmento de usuarios.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `name` | String @unique | Nombre único |
| `description` | String? | Descripción |
| `isActive` | Boolean | Si está activo |
| `rules` | Json? | Reglas de pertenencia |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `users`: Muchos-a-muchos con ChatbotUser (vía UserSegment)
- `flows`: Muchos-a-muchos con Flow (vía FlowSegment)

---

### UserSegment
Asociación usuario-segmento.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `userId` | String (FK) | Referencia a ChatbotUser |
| `segmentId` | String (FK) | Referencia a Segment |
| `addedAt` | DateTime | Cuándo se agregó |
| `autoAdded` | Boolean | Si fue agregado automáticamente |

**Relaciones:**
- `user`: Muchos-a-uno con ChatbotUser
- `segment`: Muchos-a-uno con Segment

**Índices:**
- `@@unique([userId, segmentId])`

---

### FlowTag
Asociación flujo-etiqueta.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `flowId` | String (FK) | Referencia a Flow |
| `tagId` | String (FK) | Referencia a Tag |
| `createdAt` | DateTime | Fecha de creación |

**Relaciones:**
- `flow`: Muchos-a-uno con Flow
- `tag`: Muchos-a-uno con Tag

**Índices:**
- `@@unique([flowId, tagId])`

---

### FlowSegment
Asociación flujo-segmento.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `flowId` | String (FK) | Referencia a Flow |
| `segmentId` | String (FK) | Referencia a Segment |
| `createdAt` | DateTime | Fecha de creación |

**Relaciones:**
- `flow`: Muchos-a-uno con Flow
- `segment`: Muchos-a-uno con Segment

**Índices:**
- `@@unique([flowId, segmentId])`

---

## 8. Métricas y Auditoría

### FlowMetricEvent
Eventos de medición y analítica.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `flowId` | String (FK) | Referencia a Flow |
| `stepId` | String? (FK) | Referencia a FlowStep opcional |
| `eventType` | MetricType | Tipo de métrica |
| `timestamp` | DateTime | Momento del evento |
| `durationMs` | Int? | Duración en ms |
| `meta` | Json? | Metadata adicional |

**Relaciones:**
- `flow`: Muchos-a-uno con Flow
- `step`: Muchos-a-uno con FlowStep (opcional)

---

### FlowExecutionLog
Registro detallado de ejecución de mensajes y acciones.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `conversationId` | String (FK) | Referencia a UserConversation |
| `stepId` | String? (FK) | Referencia a FlowStep opcional |
| `messageType` | ExecutionMessageType | sent, received, error, etc. |
| `content` | String | Contenido del mensaje |
| `metadata` | Json? | Metadata adicional (tokens, latencia) |
| `timestamp` | DateTime | Momento del evento |

**Relaciones:**
- `conversation`: Muchos-a-uno con UserConversation
- `step`: Muchos-a-uno con FlowStep (opcional)

---

### FlowSendHistory
Historial de envíos de flujos massivos.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `flowId` | String (FK) | Referencia a Flow |
| `userId` | String | ID del destinatario |
| `sentAt` | DateTime | Cuándo se envió |

**Índices:**
- `@@index([flowId, userId, sentAt])`

---

## 9. Webhooks

### Webhook
Endpoints externos para notificaciones de eventos.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `name` | String | Nombre descriptivo |
| `url` | String | Endpoint URL |
| `events` | Json | Array de WebhookEvent suscritos |
| `secret` | String? | Secreto para firma HMAC-SHA256 |
| `isActive` | Boolean | Si está activo |
| `status` | WebhookStatus | ACTIVE, INACTIVE, FAILED |
| `flowIds` | String[] | Solo disparar para estos flows |
| `channelTypes` | String[] | Solo disparar para estos canales |
| `widgetIds` | String[] | Solo disparar para estos widgets |
| `whatsappAccountIds` | String[] | Solo disparar para estas líneas |
| `retryAttempts` | Int | Intentos de reintento (default 3) |
| `timeout` | Int | Timeout en ms (default 10000) |
| `headers` | Json? | Headers HTTP personalizados |
| `lastTriggeredAt` | DateTime? | Último disparo |
| `failureCount` | Int | Cantidad de fallos |
| `successCount` | Int | Cantidad de éxitos |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `logs`: Uno-a-muchos con WebhookLog

**Índices:**
- `@@index([isActive, status])`
- `@@index([flowIds])`
- `@@index([widgetIds])`
- `@@index([whatsappAccountIds])`

---

### WebhookLog
Registro de ejecuciones de webhook.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `webhookId` | String (FK) | Referencia a Webhook |
| `event` | String | WebhookEvent que disparó |
| `payload` | Json | Payload enviado |
| `response` | Json? | Respuesta del servidor |
| `statusCode` | Int? | Código HTTP de respuesta |
| `success` | Boolean | Si fue exitoso |
| `error` | String? | Mensaje de error |
| `attempt` | Int | Número de intento |
| `duration` | Int? | Duración en ms |
| `triggeredAt` | DateTime | Cuándo se ejecutó |

**Relaciones:**
- `webhook`: Muchos-a-uno con Webhook

**Índices:**
- `@@index([webhookId, triggeredAt])`
- `@@index([event, triggeredAt])`
- `@@index([success])`

---

## 10. Base de Conocimiento (RAG)

### KnowledgeBase
Base de conocimiento para Retrieval-Augmented Generation.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `name` | String | Nombre |
| `description` | String? | Descripción |
| `documentType` | String? | Tipo de documento (FAQ, Manual, etc.) |
| `source` | String? | Origen (ej: "Equipo de producto v2.1") |
| `language` | String? | Idioma (es, en, fr) |
| `syncTarget` | String | postgres o s3-bedrock |
| `syncTargetConfig` | Json? | Config del target (bucket, region, bedrockKbId) |
| `isActive` | Boolean | Si está activa |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `documents`: Uno-a-muchos con KnowledgeBaseDocument
- `flows`: Uno-a-muchos con Flow

**Índices:**
- `@@index([isActive])`

---

### KnowledgeBaseDocument
Documento individual en una base de conocimiento.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `knowledgeBaseId` | String (FK) | Referencia a KnowledgeBase |
| `fileName` | String | Nombre original del archivo |
| `content` | String | Texto extraído |
| `fileSize` | Int | Tamaño en bytes |
| `approximateTokens` | Int | Estimación de tokens (~content.length / 4) |
| `mimeType` | String? | MIME type (text/plain, etc.) |
| `isActive` | Boolean | Si está activo |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `knowledgeBase`: Muchos-a-uno con KnowledgeBase

**Índices:**
- `@@index([knowledgeBaseId, isActive])`

---

## 11. WhatsApp Multi-Cuenta

### WhatsAppAccount
Cuenta de WhatsApp Business vinculada.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `name` | String | Nombre descriptivo |
| `slug` | String @unique | Identificador URL-safe |
| `description` | String? | Descripción |
| `phoneNumberId` | String @unique | ID del número en Meta API |
| `accessToken` | String | Token encriptado AES-256-CBC |
| `businessId` | String | Business Account ID |
| `apiVersion` | String | Versión de API (default v21.0) |
| `webhookUrl` | String? | URL del webhook |
| `webhookVerifyToken` | String? | Token de verificación |
| `isPrimary` | Boolean | Si es la cuenta principal |
| `isActive` | Boolean | Si está activa |
| `metadata` | Json? | Configuración adicional |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `templates`: Uno-a-muchos con WhatsAppTemplate
- `conversations`: Uno-a-muchos con UserConversation

**Índices:**
- `@@index([slug])`
- `@@index([isPrimary])`

---

### WhatsAppTemplate
Plantilla de mensaje sincronizada desde Meta Business.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `name` | String | Nombre oficial en Meta |
| `logicalGroup` | String? | Grupo lógico (welcome_message, etc.) |
| `language` | String | Código de idioma |
| `category` | String | Categoría Meta |
| `body` | String | Texto del cuerpo |
| `header` | String? | Texto del header |
| `footer` | String? | Texto del footer |
| `buttons` | Json? | Botones de la plantilla |
| `isActive` | Boolean | Si está activa |
| `whatsappAccountId` | String? (FK) | Cuenta a la que pertenece |
| `createdAt` | DateTime | Fecha de creación |

**Relaciones:**
- `whatsappAccount`: Muchos-a-uno con WhatsAppAccount (opcional)

**Índices:**
- `@@unique([name, whatsappAccountId])`
- `@@index([logicalGroup])`

---

## 12. WebChat Widgets

### WebChatWidget
Configuración de widget de chat web embebible.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `widgetId` | String @unique | ID público para embed |
| `name` | String | Nombre descriptivo |
| `description` | String? | Descripción |
| `initialFlowId` | String? | Flujo inicial |
| `autoStartFlow` | Boolean | Iniciar sin interacción |
| `theme` | Json? | { primaryColor, secondaryColor, botName, avatarUrl, icon } |
| `welcomeMessage` | String? | Mensaje de bienvenida |
| `placeholder` | String? | Placeholder del input |
| `allowedOrigins` | String[] | Dominios permitidos para CORS |
| `isActive` | Boolean | Si está activo |
| `metadata` | Json? | Configuración adicional |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `conversations`: Uno-a-muchos con UserConversation

**Índices:**
- `@@index([widgetId])`

---

## 13. Handoff a Agentes Humanos

### HandoffDestination
Destino para derivación de conversaciones a agentes humanos.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `name` | String | Nombre (ej: "Odoo Producción") |
| `type` | HandoffDestinationType | EXTERNAL_WEBHOOK o INTERNAL_DASHBOARD |
| `webhookUrl` | String? | URL del CRM externo |
| `secret` | String? | Secreto HMAC-SHA256 |
| `headers` | Json? | Headers HTTP extras |
| `timeout` | Int | Timeout en ms (default 10000) |
| `socketRoom` | String? | Room Socket.IO (default "human-agents") |
| `callbackAuthToken` | String? | Token para callbacks del CRM |
| `isActive` | Boolean | Si está activo |
| `metadata` | Json? | Configuración adicional |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `flows`: Uno-a-muchos con Flow

**Índices:**
- `@@index([isActive])`

---

## 14. Jobs y Scheduling

### ScheduledJob
Job programado con cron.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `name` | String @unique | Nombre único del job |
| `description` | String? | Descripción |
| `schedule` | String | Expresión cron (ej: "0 * * * *") |
| `isActive` | Boolean | Si está activo |
| `source` | JobSource | MANUAL o EVENT |
| `eventName` | String? | Nombre del evento a disparar |
| `payload` | Json? | Datos del job |
| `createdBy` | String? | Usuario que lo creó |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

**Relaciones:**
- `executions`: Uno-a-muchos con JobExecutionLog

---

### JobExecutionLog
Log de ejecución de un job.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `jobId` | String (FK) | Referencia a ScheduledJob |
| `status` | ExecStatus | RUNNING, SUCCESS, FAILED, DEAD |
| `startedAt` | DateTime | Cuándo inició |
| `finishedAt` | DateTime? | Cuándo terminó |
| `durationMs` | Int? | Duración en ms |
| `attempt` | Int | Número de intento |
| `workerIntanceId` | String? | Instancia que ejecutó |
| `errorMessage` | String? | Mensaje de error |
| `output` | Json? | Resultado o respuesta |

**Relaciones:**
- `job`: Muchos-a-uno con ScheduledJob

**Índices:**
- `@@index([jobId, startedAt])`

---

## Modelos Menores

### AdverseKeyword
Palabras clave para detectar eventos adversos.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `word` | String @unique | Palabra clave |
| `isActive` | Boolean | Si está activa |

---

### AutoResponse
Respuestas automáticas por palabra clave.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `triggerText` | String | Texto que dispara |
| `responseText` | String | Respuesta automática |
| `createdAt` | DateTime | Fecha de creación |

---

### NotificationSettings
Configuración de notificaciones.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `type` | NotificationType | Tipo de notificación |
| `recipient` | String | Destinatario |
| `subject` | String? | Asunto |
| `templateBody` | String? | Cuerpo del template |
| `isActive` | Boolean | Si está activa |
| `createdAt` | DateTime | Fecha de creación |
| `updatedAt` | DateTime | Última actualización |

---

### OdooFields
Campos disponibles en Odoo.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (UUID) | Identificador único |
| `fieldName` | String @unique | Nombre del campo |
| `fieldLabel` | String | Label para mostrar |
| `fieldType` | String | Tipo del campo |

---

## Relaciones Many-to-Many Resumidas

```
User ──────────< Session

Flow ──────────< FlowStep ──────────< StepOption
  │                                    │
  │                                    │
  ├────────< FlowSchedule              │
  ├────────< FlowMetricEvent           │
  ├────────< FlowExecutionLog          │
  ├────────< FlowSendHistory           │
  ├────────< UserConversation >────────┼
  │                │
  │                ├──────< UserAnswer
  │                ├──────< UserFile
  │                │
  ├────────< FlowTag >────── Tag >─────< UserTag >────── ChatbotUser
  │                │                              │
  ├────────< FlowSegment >── Segment >──< UserSegment
  │                │
  │                │
  └────────< HandoffDestination

ChatbotUser ──────< UserChannelLink

Flow ──────────< KnowledgeBase >──────< KnowledgeBaseDocument

WhatsAppAccount ──────< WhatsAppTemplate
        │
        └────────< UserConversation

WebChatWidget ──────< UserConversation

Webhook ──────────< WebhookLog

ScheduledJob ──────────< JobExecutionLog
```

---

## Notas de Implementación

1. **Encriptación**: `WhatsAppAccount.accessToken` se encripta con AES-256-CBC usando `CryptoUtil.encrypt()`.

2. **Índices Compuestos**: Las relaciones many-to-many usan unique constraints para evitar duplicados.

3. **Soft Deletes**: No hay soft delete implementado actualmente - los registros se eliminan físicamente.

4. **JSON Fields**: Los campos Json permiten flexibilidad para metadata, configuraciones y datos variables.

5. **Timestamps**: Todos los modelos tienen `createdAt` y `updatedAt` con actualización automática.

6. **UUIDs**: Todos los IDs usan `uuid()` como default, generando UUIDs v4.

---

*Última actualización: Mayo 2026*
*Fuente: prisma/schema.prisma*
