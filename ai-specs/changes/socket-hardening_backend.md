# Plan: Socket Hardening — Auditoría y corrección de bugs en la capa de WebSocket

**Fecha:** 2026-05  
**Tipo:** `fix` + `refactor`  
**Prioridad:** 🔴 Alta — afecta a todos los usuarios simultáneos

---

## 1. Resumen ejecutivo

Se realizó una auditoría completa del flujo de mensajes WebSocket desde el cliente hasta el Use Case `ProcessIncomingMessageUseCase`. Se identificaron **5 bugs críticos** y **3 áreas de mejora** que provocan pérdida de mensajes, duplicación de conversaciones y comportamiento no determinista bajo carga concurrente.

---

## 2. Bugs identificados

### 🔴 BUG-1: Race condition en `createConversation` bajo carga concurrente
**Archivo:** `src/infraestructure/database/persistences/repositories/conversation.prisma.repository.ts`  
**Líneas:** 36–80

**Descripción:**  
El flujo `getActiveConversation → archivar → createConversation` son **tres operaciones Prisma separadas sin transacción**. Si dos mensajes del mismo usuario llegan simultáneamente (doble-tap, reconexión rápida, o múltiples requests HTTP paralelas desde el widget):

1. Ambos requests llegan → ambos obtienen `existingConversation = null`
2. Ambos intentan `create` → el segundo falla con `P2002` (unique constraint)
3. Resultado: el segundo mensaje lanza un error `500` y **el flujo de autorespuesta no se inicia**

```
Petición A:  findFirst → null
Petición B:  findFirst → null
Petición A:  create ✅
Petición B:  create 💥 P2002 UniqueConstraint
```

**Fix:**  
Envolver en una transacción Prisma con `upsert` o `$transaction`:

```ts
// En createConversation — reemplazar las 3 ops sueltas por:
return await this.executeSafe(async () => {
  return await this.prisma.$transaction(async (tx) => {
    const existing = await tx.userConversation.findFirst({
      where: { channelType: channelType as any, channelUserId, status: 'in_progress' },
    });

    if (existing) {
      await tx.userConversation.update({
        where: { id: existing.id },
        data: {
          status: 'completed',
          completedAt: existing.completedAt || new Date(),
          channelUserId: `${channelUserId}_archived_${existing.id.substring(0, 8)}`,
        },
      });
    }

    return await tx.userConversation.create({
      data: { channelType: channelType as any, channelUserId, flowId, currentStepId: currentStepId || undefined, mode, status: 'in_progress', invalidAnswersCount: 0, /* ...channelAccountId */ },
    });
  });
});
```

---

### 🔴 BUG-2: Doble registro de socket con mismo sessionId (reconexión)
**Archivo:** `src/infraestructure/adapters/messaging/webchat.adapter.ts`  
**Líneas:** 43–47

**Descripción:**  
Cuando un cliente se reconecta (pérdida de red, navegador en background), Socket.IO emite un nuevo evento `connection` con un nuevo `socket.id` pero el mismo `sessionId`. La línea:

```ts
this.connectedSockets.set(key, socket); // sobreescribe silenciosamente
```

Sobreescribe el socket anterior sin hacer `socket.leave()` en el antiguo. El socket viejo queda vivo en memoria del servidor de Socket.IO pero eliminado del Map. Consecuencias:
- Mensajes en tránsito al socket antiguo se pierden silenciosamente
- El socket antiguo no recibe cleanup → memory leak acumulativo

**Fix:**  
Al registrar un socket nuevo para un `key` existente, desconectar el anterior:

```ts
io.on('connection', (socket: Socket) => {
  const key = sessionId || socket.id;
  
  // Limpiar socket anterior si existe para el mismo sessionId
  const existingSocket = this.connectedSockets.get(key);
  if (existingSocket && existingSocket.id !== socket.id) {
    logger.info('[WebChat] Replacing stale socket for session', { key, oldSocketId: existingSocket.id, newSocketId: socket.id });
    existingSocket.disconnect(true);
  }
  
  this.connectedSockets.set(key, socket);
  // ...
});
```

---

### 🔴 BUG-3: `startAutoResponseFlow` no es idempotente — puede crear conversaciones duplicadas
**Archivo:** `src/app/use-cases/messaging/process-incoming-message.use-case.ts`  
**Líneas:** 376–540

**Descripción:**  
`startAutoResponseFlow` llama directamente a `this.conversationRepository.createConversation()` sin verificar si ya existe una conversación `in_progress` en el momento de crear (por encima de la protección en el repositorio). 

El flujo completo es:
```
getActiveConversation → null
  → startAutoResponseFlow
    → createConversation (verifica de nuevo y crea)
```

Entre el `getActiveConversation → null` y el `createConversation`, si un segundo request simultáneo pasa el primer check, ambos intentan crear → BUG-1 se amplifica.

Además, si `createConversation` lanza una excepción, el error se propaga al controller sin mensaje de error al usuario.

**Fix:**  
- Depender del fix BUG-1 (transacción) para el caso de concurrencia
- Agregar `try/catch` alrededor del bloque completo de `startAutoResponseFlow` con fallback de mensaje al usuario:

```ts
private async startAutoResponseFlow(message: IncomingMessage): Promise<void> {
  try {
    // ...lógica actual...
  } catch (error: any) {
    logger.error(`Error iniciando autorespuesta: ${error.message}`, { context: 'messaging:autoresponse' });
    // Informar al usuario en lugar de silenciar el error
    await this.messageSender.sendTextMessage(
      message.channelType,
      message.channelUserId,
      'Disculpa, tuvimos un problema iniciando la conversación. Por favor recarga la página.',
    );
    // No relanzar — no hay conversación que recuperar
  }
}
```

---

### 🟡 BUG-4: `messageId` no es único — colisiones con alta frecuencia
**Archivo:** `src/infraestructure/http/controllers/webchat/webchat-incoming.controller.ts`  
**Línea:** 126

**Descripción:**  
```ts
messageId: `webchat-${Date.now()}`,
```

`Date.now()` tiene resolución de milisegundos. Si dos usuarios envían un mensaje en el mismo milisegundo (muy posible bajo carga), los `messageId` colisionan. Esto afecta a cualquier sistema que indexe por `messageId` (logs, deduplicación).

**Fix:**  
```ts
import { randomUUID } from 'crypto'; // nativo Node.js, sin dependencias

messageId: `webchat-${randomUUID()}`,
```

---

### 🟡 BUG-5: Validación de input sin schema Zod en `receiveMessage`
**Archivo:** `src/infraestructure/http/controllers/webchat/webchat-incoming.controller.ts`  
**Líneas:** 89–95

**Descripción:**  
La validación actual es manual:
```ts
if (!message || !channelUserId) {
  throw ErrorFactory.create('bad-request', 'Faltan campos requeridos');
}
```

No valida tipos, longitud máxima de `message` (puede recibir un payload de varios MB), ni el formato de `metadata`. Un cliente malicioso puede enviar un mensaje de 10MB y causar presión de memoria en el proceso.

**Fix:**  
Crear schema Zod en `src/infraestructure/http/schemas/webchat-incoming.schema.ts`:

```ts
import { z } from 'zod';

export const WebChatIncomingSchema = z.object({
  message: z.string().min(1).max(2000),
  channelUserId: z.string().min(1).max(200),
  metadata: z.object({
    widgetId: z.string().optional(),
    sessionId: z.string().optional(),
    url: z.string().url().optional(),
    conversationId: z.string().uuid().nullish(),
  }).optional(),
});

export type WebChatIncomingDto = z.infer<typeof WebChatIncomingSchema>;
```

Aplicar en el controller via middleware o en el handler con `WebChatIncomingSchema.safeParse(req.body)`.

---

## 3. Áreas de mejora (no críticas)

### ⚪ MEJORA-1: No hay rooms de Socket.IO — sin soporte multi-instancia
**Descripción:**  
`connectedSockets` es un `Map` en memoria del proceso Node.js. Si el backend escala horizontalmente (2+ instancias), un mensaje enviado por la instancia A no llega al socket conectado en la instancia B.

**Solución propuesta:** Usar Socket.IO rooms con el `sessionId` como room name:
```ts
socket.join(sessionId);
// Enviar:
this.io.to(sessionId).emit('message', data);
```
Esto es compatible con el adapter de Redis de Socket.IO cuando se necesite escalar.  
**No implementar ahora** si no hay planes de escalado horizontal, pero el refactor de `emit` directo → `io.to(room).emit` es bajo riesgo y prepara el terreno.

---

### ⚪ MEJORA-2: Falta `messageId` en respuestas del bot para deduplicación en cliente
**Descripción:**  
El widget ya tiene lógica de deduplicación (`_renderedMessageIds`), pero el servidor solo genera `messageId` para mensajes de usuario, no para las respuestas del bot. Si hay reconexión durante una respuesta de bot, el cliente puede renderizar el mensaje dos veces.

**Fix:** Generar `messageId` en `sendTextMessage` y `endStreaming` del adapter:
```ts
const messageId = randomUUID();
socket.emit('message', { ...messageData, messageId });
```

---

### ⚪ MEJORA-3: CORS origin validation hace DB query en cada conexión socket
**Archivo:** `src/infraestructure/socket-io.ts`  
**Descripción:**  
`isOriginAllowed` lanza una query `findAll(true)` en cada handshake de Socket.IO. Con 100 conexiones simultáneas, son 100 queries no cacheadas.

**Fix:** Cachear el resultado con TTL de 60 segundos usando un `Map` en memoria o Redis:
```ts
private _originsCache: { allowed: string[]; hasRestrictions: boolean; ts: number } | null = null;
private readonly CACHE_TTL_MS = 60_000;

private async getOriginsConfig(): Promise<{ allowed: string[]; hasRestrictions: boolean }> {
  if (this._originsCache && Date.now() - this._originsCache.ts < this.CACHE_TTL_MS) {
    return this._originsCache;
  }
  // ...query DB y actualizar cache
}
```

---

## 4. Plan de implementación por fases

### Fase 1 — Fixes críticos (hacer ya)

| # | Archivo | Cambio | Commit |
|---|---------|--------|--------|
| 1 | `conversation.prisma.repository.ts` | Envolver `createConversation` en `$transaction` | `fix(db): wrap createConversation in prisma transaction to prevent race condition` |
| 2 | `webchat.adapter.ts` | Desconectar socket viejo al reconectar mismo sessionId | `fix(socket): disconnect stale socket on session reconnect` |
| 3 | `process-incoming-message.use-case.ts` | Agregar catch con mensaje al usuario en `startAutoResponseFlow` | `fix(messaging): send user-facing error when autoresponse flow fails` |
| 4 | `webchat-incoming.controller.ts` | Cambiar `Date.now()` por `randomUUID()` | `fix(webchat): use crypto.randomUUID for messageId to prevent collisions` |
| 5 | `webchat-incoming.schema.ts` (nuevo) + controller | Agregar Zod schema con `max(2000)` en message | `feat(validation): add zod schema to webchat incoming endpoint` |

### Fase 2 — Mejoras de estabilidad (próximo sprint)

| # | Archivo | Cambio | Commit |
|---|---------|--------|--------|
| 6 | `webchat.adapter.ts` | Migrar de `socket.emit` directo a `io.to(room).emit` | `refactor(socket): use io rooms instead of direct socket reference` |
| 7 | `webchat.adapter.ts` | Añadir `messageId` en respuestas del bot | `feat(socket): emit messageId on bot messages for client deduplication` |
| 8 | `socket-io.ts` | Cachear resultado de `isOriginAllowed` (TTL 60s) | `perf(socket): cache allowed origins to reduce DB queries on connect` |

---

## 5. Notas de implementación

### Sobre BUG-1 y `executeSafe`
El `$transaction` de Prisma **debe estar dentro de `executeSafe`** para que los errores de Prisma se mapeen correctamente a errores de dominio. La firma es:

```ts
return await this.executeSafe(async () => {
  return await this.prisma.$transaction(async (tx) => { ... });
});
```

### Sobre MEJORA-1 (rooms)
Antes de cambiar `socket.emit` → `io.to(room).emit`, verificar que `this.io` esté disponible en todos los métodos de envío (actualmente algunos hacen `this.connectedSockets.get()` que fallaría si el socket no está en el Map local). La migración a rooms requiere que `this.io` no sea `null`.

### No hay cambios en `schema.prisma`
Este plan no requiere migración de base de datos.

### Tests afectados
- `test/infraestructure/repositories/conversation.prisma.repository.test.ts` — agregar test de concurrencia con dos llamadas simultáneas a `createConversation`
- `test/infraestructure/adapters/webchat.adapter.test.ts` — agregar test de reconexión con mismo sessionId
- `test/app/use-cases/process-incoming-message.use-case.test.ts` — agregar test de `startAutoResponseFlow` con error de repositorio
