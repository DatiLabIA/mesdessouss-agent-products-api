# DatiHub — Nueva Arquitectura de Agentes IA
## Brief técnico para el equipo de desarrollo

---

## 1. ¿Qué problema estamos resolviendo?

Actualmente usamos **AWS Bedrock Agents + Knowledge Base** para el chatbot de MesDessous.fr. Esta arquitectura tiene problemas críticos que no podemos resolver con ajustes de prompts:

- **Búsqueda de productos imprecisa**: La KB usa búsqueda semántica (embeddings) para encontrar productos. Cuando un cliente pide "culotte taille XXS", la KB devuelve productos sin esa talla porque los embeddings no entienden tallas como datos exactos. El vector search fue diseñado para texto libre, no para datos estructurados como tipo de producto, talla, marca y precio.

- **Latencia inaceptable**: Cada mensaje tarda 15-30 segundos. El flujo pasa por un agente supervisor, luego el agente de Julie, luego la KB, luego el procesamiento de respuesta — demasiadas capas.

- **Complejidad de mantenimiento**: Hay 4 prompts de orquestación por agente (pre-processing, orchestration, KB response, post-processing) además del prompt del agente. Debugging es difícil porque hay muchas capas opacas.

- **Acoplamiento a Bedrock**: El flujo actual es específico de AWS Bedrock Agents. No es reutilizable si queremos cambiar de proveedor o escalar a otros clientes.

- **Costo elevado**: Las múltiples llamadas por turno (supervisor + agente + KB) multiplican el costo de tokens.

---

## 2. ¿Qué vamos a hacer?

Migrar el cliente **MesDessous.fr** de **Bedrock Agents + Knowledge Base** a **Claude API directa + Tools**, con un servicio de catálogo externo. Esto no afecta otros clientes — DatiHub soportará ambos motores en paralelo.

**Antes:**
```
Cliente → DatiHub → Supervisor Agent (Bedrock) → Julie Agent (Bedrock) → KB (embeddings)
                                                                            ↓
                                                                    Búsqueda semántica
                                                                    (imprecisa para productos)
```

**Después:**
```
Cliente → DatiHub → Claude API (un solo agente con tools)
                         ↓
                    Claude decide qué tool usar
                         ↓
                    DatiHub ejecuta el tool → Catalog Service (HTTP)
                         ↓                        ↓
                    Claude recibe datos      PostgreSQL / API del cliente
                         ↓                   (búsqueda exacta por talla, tipo, marca)
                    Responde al cliente
```

---

## 3. Principios de diseño

1. **DatiHub es genérico**: No sabe qué vende el cliente. No tiene lógica de negocio específica. Solo conecta Claude con los tools configurados para cada cliente.

2. **Un agente, múltiples tools**: En vez de 3 agentes separados (Julie, Sophie, Lucie) con un supervisor que rutea entre ellos, usamos un solo agente con personalidad unificada que tiene acceso a varios tools. Claude decide naturalmente cuál usar según el contexto.

3. **Los datos del cliente viven fuera de DatiHub**: Cada cliente tiene su propio servicio de catálogo (Catalog Service) que DatiHub llama por HTTP cuando Claude invoca un tool.

4. **Búsqueda exacta, no semántica**: Los productos se buscan con queries SQL/filtros exactos en vez de embeddings. Si el cliente pide talla XXS, la query filtra por XXS. Determinista y preciso.

---

## 4. Componentes a desarrollar

### 4.1 — Cambios en DatiHub (plataforma)

**Nuevo flujo de mensajes AI:**

El flujo actual usa `BedrockAgentService` para invocar agentes de Bedrock. El nuevo flujo usa directamente la API de Claude (Messages API) con tool use.

```typescript
// Flujo simplificado
async function handleAIMessage(clientId: string, message: string, conversationId: string) {
  // 1. Obtener configuración del cliente
  const config = await getClientConfig(clientId);
  
  // 2. Obtener historial de conversación
  const history = await getConversationHistory(conversationId);
  history.push({ role: "user", content: message });
  
  // 3. Llamar a Claude con el prompt y tools del cliente
  let response = await anthropic.messages.create({
    model: config.agent.model,
    system: config.agent.systemPrompt,
    messages: history,
    tools: config.agent.tools
  });
  
  // 4. Si Claude quiere usar un tool, ejecutarlo y devolver resultado
  while (response.stop_reason === "tool_use") {
    const toolCalls = response.content.filter(c => c.type === "tool_use");
    const toolResults = [];
    
    for (const call of toolCalls) {
      // DatiHub llama al servicio externo del cliente
      const result = await executeClientTool(clientId, call.name, call.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(result)
      });
    }
    
    // Enviar resultados a Claude para que genere la respuesta final
    response = await anthropic.messages.create({
      model: config.agent.model,
      system: config.agent.systemPrompt,
      messages: [
        ...history,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults }
      ],
      tools: config.agent.tools
    });
  }
  
  // 5. Extraer respuesta de texto y procesarla
  const text = response.content.find(c => c.type === "text")?.text;
  return parseAgentResponse(text);
}
```

**Configuración por cliente:**

Cada cliente tiene su configuración de agente con prompt, modelo y tools. DatiHub no tiene lógica específica de ningún cliente.

```typescript
// Ejemplo: configuración de MesDessous en DatiHub
{
  clientId: "mesdessous",
  agent: {
    model: "claude-haiku-4-5-20251001",
    systemPrompt: "🚨 You are Julie, expert lingerie consultant...",
    tools: [
      {
        name: "product_search",
        description: "Search lingerie catalog by type, size, brand, color, price",
        endpoint: "https://catalog-api.example.com/mesdessous/product_search",
        input_schema: {
          type: "object",
          properties: {
            type: { type: "string", description: "Product type: culotte, soutien-gorge, boxer..." },
            size: { type: "string", description: "Size: XXS, 90C, T5, FR38..." },
            gender: { type: "string", enum: ["female", "male"] },
            brand: { type: "string" },
            color: { type: "string" },
            max_price: { type: "number" },
            sub_type: { type: "string", description: "avec armatures, sans armatures, taille haute..." }
          },
          required: ["type"]
        }
      },
      {
        name: "size_guide",
        description: "Get sizing guide: how to measure, size conversions FR/EU/US/UK",
        endpoint: "https://catalog-api.example.com/mesdessous/size_guide",
        input_schema: {
          type: "object",
          properties: {
            product_type: { type: "string" },
            brand: { type: "string" }
          },
          required: ["product_type"]
        }
      },
      {
        name: "store_policies",
        description: "Store policies: shipping, returns, payments, promotions",
        endpoint: "https://catalog-api.example.com/mesdessous/store_policies",
        input_schema: {
          type: "object",
          properties: {
            topic: { type: "string", enum: ["shipping","returns","payments","orders","promo","company"] }
          },
          required: ["topic"]
        }
      }
    ]
  }
}
```

**Ejecución de tools:**

DatiHub solo necesita saber el endpoint del tool y hacer un POST con el input que Claude genera.

```typescript
async function executeClientTool(clientId: string, toolName: string, input: any) {
  const config = await getClientConfig(clientId);
  const tool = config.agent.tools.find(t => t.name === toolName);
  
  const response = await fetch(tool.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": clientId,
      "Authorization": `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(input)
  });
  
  return response.json();
}
```

**Prompt caching (optimización de costos):**

El system prompt se repite en cada llamada. Con prompt caching, Claude lo cachea y las llamadas siguientes pagan 90% menos en tokens de input.

```typescript
// Usar cache_control en el system prompt
system: [{
  type: "text",
  text: config.agent.systemPrompt,
  cache_control: { type: "ephemeral" }  // cache de 5 minutos
}]
```

### 4.2 — Catalog Service (servicio nuevo, separado de DatiHub)

Un microservicio HTTP que expone endpoints de búsqueda por cliente. No es parte de DatiHub — es un servicio independiente que DatiHub consume.

**Endpoints:**

```
POST /mesdessous/product_search
POST /mesdessous/size_guide
POST /mesdessous/store_policies
```

**Base de datos (PostgreSQL):**

```sql
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    client_id VARCHAR(50) NOT NULL,
    product_id VARCHAR(20) NOT NULL,
    name TEXT NOT NULL,
    brand VARCHAR(100),
    type VARCHAR(100),
    forme VARCHAR(100),
    gender VARCHAR(20),
    price DECIMAL(10,2),
    old_price DECIMAL(10,2),
    has_discount BOOLEAN DEFAULT false,
    discount_percentage INTEGER DEFAULT 0,
    price_tier VARCHAR(20),
    product_url TEXT,
    image_url TEXT,
    color VARCHAR(200),
    sizes TEXT,
    materials TEXT,
    styles TEXT,
    collection VARCHAR(200),
    description TEXT,
    active BOOLEAN DEFAULT true,
    synced_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(client_id, product_id)
);

CREATE INDEX idx_products_client ON products(client_id);
CREATE INDEX idx_products_type ON products(client_id, type);
CREATE INDEX idx_products_brand ON products(client_id, brand);
CREATE INDEX idx_products_gender ON products(client_id, gender);
```

**Lógica de búsqueda (ejemplo product_search):**

```typescript
async function productSearch(clientId: string, input: ProductSearchInput) {
  let query = `SELECT * FROM products WHERE client_id = $1 AND active = true`;
  const params: any[] = [clientId];
  let paramIndex = 2;
  
  // Filtro por tipo de producto
  if (input.type) {
    query += ` AND (LOWER(type) LIKE $${paramIndex} OR LOWER(forme) LIKE $${paramIndex})`;
    params.push(`%${input.type.toLowerCase()}%`);
    paramIndex++;
  }
  
  // Filtro por talla (exacto, no semántico)
  if (input.size) {
    // Buscar la talla como palabra completa dentro del campo sizes
    // Maneja todos los formatos: "XXS", "FR34", "90 C", "T5 ( XL )"
    query += ` AND sizes ~* $${paramIndex}`;
    params.push(`(^|[,\\s-])${escapeRegex(input.size)}([,\\s\\)-]|$)`);
    paramIndex++;
  }
  
  // Filtro por género
  if (input.gender) {
    query += ` AND (gender = $${paramIndex} OR gender = '')`;
    params.push(input.gender);
    paramIndex++;
  }
  
  // Filtro por marca
  if (input.brand) {
    query += ` AND LOWER(brand) LIKE $${paramIndex}`;
    params.push(`%${input.brand.toLowerCase()}%`);
    paramIndex++;
  }
  
  // Filtro por color
  if (input.color) {
    query += ` AND LOWER(color) LIKE $${paramIndex}`;
    params.push(`%${input.color.toLowerCase()}%`);
    paramIndex++;
  }
  
  // Filtro por precio máximo
  if (input.max_price) {
    query += ` AND price <= $${paramIndex}`;
    params.push(input.max_price);
    paramIndex++;
  }
  
  // Filtro por sub-tipo (avec/sans armatures, taille haute, etc.)
  if (input.sub_type) {
    query += ` AND LOWER(name) LIKE $${paramIndex}`;
    params.push(`%${input.sub_type.toLowerCase()}%`);
    paramIndex++;
  }
  
  // Validar que image_url es una imagen real
  query += ` AND (image_url LIKE '%.jpg' OR image_url LIKE '%.png' OR image_url LIKE '%.webp')`;
  
  // Ordenar y limitar
  query += ` ORDER BY has_discount DESC, price ASC LIMIT 10`;
  
  const results = await db.query(query, params);
  return results.rows;
}
```

**Sync de datos:**

Los productos se sincronizan periódicamente desde la fuente del cliente (Prestashop, Shopify, API, CSV) mediante un cron job o webhook.

```typescript
// Cron: sync de productos cada 4 horas
async function syncMesDessousProducts() {
  const products = await prestashopApi.getAllProducts();
  
  for (const product of products) {
    await db.query(`
      INSERT INTO products (client_id, product_id, name, brand, type, ...)
      VALUES ('mesdessous', $1, $2, $3, $4, ...)
      ON CONFLICT (client_id, product_id)
      DO UPDATE SET name=$2, brand=$3, price=$5, sizes=$9, synced_at=NOW()
    `, [product.id, product.name, product.brand, ...]);
  }
}
```

---

## 5. Qué cambia y qué no

### Para MesDessous.fr (este cliente):
- ❌ Ya no usa Bedrock Agents (supervisor, Julie, Sophie, Lucie)
- ❌ Ya no usa Knowledge Base de productos
- ✅ Usa Claude API + Tools + Catalog Service

### Para DatiHub (la plataforma):
- ✅ Bedrock Agents **se mantiene** como opción para otros clientes
- ✅ Se agrega Claude API + Tools como **segunda opción** de motor de IA
- ✅ La configuración del cliente determina qué motor usa

DatiHub debe soportar ambos motores según la configuración del cliente:

```typescript
// Configuración por cliente — define qué motor usa
{
  clientId: "mesdessous",
  aiEngine: "claude-api",         // ← Claude API + Tools
  agent: { systemPrompt, tools, model }
}

{
  clientId: "rcv",
  aiEngine: "bedrock-agent",      // ← Bedrock Agents (como funciona hoy)
  agent: { agentId, aliasId, supervisorId }
}
```

El flujo de mensajes en DatiHub rutea al motor correcto:

```typescript
async function handleAIMessage(clientId: string, message: string, conversationId: string) {
  const config = await getClientConfig(clientId);
  
  switch (config.aiEngine) {
    case "claude-api":
      return await handleClaudeAPI(config, message, conversationId);
    case "bedrock-agent":
      return await handleBedrockAgent(config, message, conversationId); // flujo actual
  }
}
```

Esto significa que el código actual de Bedrock no se borra — se encapsula. El nuevo flujo de Claude API se agrega al lado.

---

## 6. Qué se mantiene en DatiHub

- ✅ Todo el flujo de Bedrock Agents (para clientes que lo usen)
- ✅ El schema JSON de respuesta (products, questions, metadata) — es el mismo para ambos motores
- ✅ El parseo de respuesta en DatiHub (parseAgentResponse)
- ✅ El manejo de conversaciones y historial
- ✅ El widget de WebChat y la integración con WhatsApp
- ✅ Los flujos de autorespuesta (idioma, tipo de consulta)

El nuevo motor Claude API se agrega **al lado** del existente. No reemplaza nada a nivel plataforma.

---

## 7. Flujo completo de un mensaje (ejemplo real)

```
1. Cliente escribe: "Je cherche un soutien-gorge sans armatures en 90C"

2. DatiHub recibe el mensaje por WebChat

3. DatiHub llama Claude API:
   - system: prompt de Julie
   - messages: historial + mensaje del cliente
   - tools: [product_search, size_guide, store_policies]

4. Claude responde con tool_use:
   {
     type: "tool_use",
     name: "product_search",
     input: {
       type: "soutien-gorge",
       size: "90C",
       gender: "female",
       sub_type: "sans armatures"
     }
   }

5. DatiHub ejecuta el tool → POST al Catalog Service:
   POST https://catalog-api.example.com/mesdessous/product_search
   Body: { type: "soutien-gorge", size: "90C", gender: "female", sub_type: "sans armatures" }

6. Catalog Service ejecuta query SQL:
   SELECT * FROM products
   WHERE client_id = 'mesdessous'
     AND type ILIKE '%soutien-gorge%'
     AND sizes ~* '(^|[,\s-])90 C([,\s\)-]|$)'
     AND LOWER(name) LIKE '%sans armature%'
     AND (image_url LIKE '%.jpg' OR ...)
   ORDER BY has_discount DESC, price ASC
   LIMIT 10

7. Catalog Service devuelve 4 productos con talla 90C exacta

8. DatiHub envía los productos a Claude como tool_result

9. Claude genera la respuesta final en JSON:
   {
     "responseType": "recommendations",
     "language": "fr",
     "message": "Voici quelques soutiens-gorge sans armatures en taille 90C :",
     "products": [/* 4 productos reales con datos exactos */]
   }

10. DatiHub parsea el JSON y envía al frontend del WebChat
    Latencia total: 3-7 segundos (vs 15-30 segundos actual)
```

---

## 8. Beneficios esperados

| Métrica | Actual (Bedrock) | Nuevo (Claude API + Tools) |
|---|---|---|
| Latencia por mensaje | 15-30s | 3-7s |
| Precisión de tallas | ~60% (semántico) | ~99% (SQL exacto) |
| Costo por conversación | ~$0.12 | ~$0.035 |
| Prompts a mantener | 4 por agente | 1 por agente |
| Acoplamiento | AWS Bedrock | API estándar, portable |
| Escalabilidad a otros clientes | Difícil (KB por cliente) | Fácil (config + endpoint) |

---

## 9. Plan de implementación sugerido

### Fase 1 — Catalog Service (semana 1-2)
- Crear servicio HTTP con endpoints de búsqueda
- Crear tabla `products` en PostgreSQL
- Importar los 120k productos de MesDessous desde los JSON existentes
- Implementar lógica de búsqueda con filtros exactos de talla
- Implementar endpoint de size_guide y store_policies
- Tests de búsqueda: verificar que XXS, 90C, 135F, avec/sans armatures funcionan

### Fase 2 — DatiHub Claude API integration (semana 2-3)
- Implementar flujo de Claude Messages API con tool use
- Implementar ejecución de tools por configuración de cliente
- Implementar prompt caching
- Adaptar prompt de Julie para tools (sin reglas de KB)
- Adaptar parseo de respuesta (misma estructura JSON)

### Fase 3 — Testing y migración (semana 3-4)
- Testing end-to-end con conversaciones reales
- Comparar resultados Bedrock vs Claude API
- Migrar MesDessous al nuevo flujo
- Monitoreo de latencia, costos y precisión
- Desactivar agentes de Bedrock

### Fase 4 — Sync automático (semana 4-5)
- Implementar sync periódico desde Prestashop
- Webhook o cron para actualización de productos
- Dashboard de estado de sincronización
