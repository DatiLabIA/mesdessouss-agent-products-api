# Guía: Construir un External Tool Service para DatiHub

**Audiencia**: Desarrolladores que construyen el servicio de catálogo o cualquier herramienta externa que DatiHub consume vía Claude Tool Use.  
**Contexto**: DatiHub es una plataforma de chatbots multicanal. Cuando un Flow usa `aiProvider = ANTHROPIC`, Claude puede invocar herramientas externas (tools) para buscar productos, consultar políticas, etc. DatiHub actúa como proxy HTTP — **no tiene lógica de negocio del cliente**.

---

## 1. ¿Cómo funciona el contrato?

```
Usuario: "Busco una culotte taille XXS en negro"
        │
        ▼
DatiHub → Claude API (con toolsConfig del Flow)
        │
        Claude decide invocar tool "product_search"
        │
        ▼
DatiHub → POST https://tu-servicio.com/mesdessous/product_search
          Body: { "type": "culotte", "size": "XXS", "color": "noir" }
        │
        ▼
Tu servicio responde → { "products": [...] }
        │
        ▼
DatiHub → Claude (recibe los productos)
        │
        Claude genera la respuesta final al usuario
```

DatiHub llama a tu servicio con un `POST` que contiene exactamente el `input` que Claude construyó. Tu servicio solo tiene que:
1. Recibir el JSON
2. Consultar tu base de datos / API
3. Devolver JSON estructurado

---

## 2. Contrato HTTP

### Request (lo que DatiHub envía)

```
POST https://tu-dominio.com/{cliente}/{tool_name}
Content-Type: application/json
Authorization: Bearer {apiKey}     ← solo si configuraste apiKey en toolsConfig
```

El cuerpo es exactamente el objeto `input` que Claude construyó según el `input_schema` del tool.

### Response esperada

```
HTTP 200 OK
Content-Type: application/json

{
  ...cualquier JSON que quieras devolver a Claude...
}
```

**Reglas críticas:**
- Siempre devolver `HTTP 200` incluso cuando no hay resultados (devuelve `{ "products": [] }`)
- Si hay un error interno, devolver `HTTP 200` con `{ "error": "descripción del problema" }` — Claude lo gestionará con el usuario
- Solo usar `HTTP 4xx/5xx` para errores de autenticación o del servidor que DatiHub debe loguear
- El JSON puede tener cualquier estructura, pero **cuanto más claro para Claude, mejor será la respuesta al usuario**

---

## 3. Tools para MesDessous.fr

Las tres tools que Julie (el agente de IA) usará:

---

### 3.1 `product_search` — Búsqueda de productos

**POST** `/mesdessous/product_search`

#### Request body

```json
{
  "type": "culotte",
  "size": "XXS",
  "gender": "female",
  "brand": "Marie Jo",
  "color": "noir",
  "max_price": 30,
  "sub_type": "taille haute"
}
```

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `type` | string | ✅ Sí | Tipo de producto: `culotte`, `soutien-gorge`, `boxer`, `brassière`, `shorty`, `slip`, `corset`, `combinaison`, `nuisette`, `pyjama`, `caraco`, `guêpière`... |
| `size` | string | No | Talla exacta: `XXS`, `XS`, `S`, `M`, `L`, `XL`, `XXL`, `90A`, `90B`, `90C`, `95C`, `100D`, `FR34`, `FR36`, `T5`, `T6`... |
| `gender` | string | No | `female` o `male` |
| `brand` | string | No | Nombre de marca (búsqueda parcial): `Marie Jo`, `Simone Pérèle`... |
| `color` | string | No | Color en francés o inglés: `noir`, `blanc`, `nude`, `rose`... |
| `max_price` | number | No | Precio máximo en EUR |
| `sub_type` | string | No | Subtipo: `avec armatures`, `sans armatures`, `taille haute`, `push-up`... |

#### Response body

```json
{
  "products": [
    {
      "id": "MD-1234",
      "name": "Culotte taille haute dentelle - Noir",
      "brand": "Marie Jo",
      "type": "culotte",
      "price": 24.90,
      "old_price": 34.90,
      "has_discount": true,
      "discount_percentage": 28,
      "sizes_available": ["XS", "S", "M", "L"],
      "colors_available": ["noir", "blanc", "nude"],
      "url": "https://mesdessous.fr/products/MD-1234",
      "image_url": "https://mesdessous.fr/images/MD-1234.jpg",
      "description": "Culotte taille haute en dentelle, confort optimal"
    }
  ],
  "total": 1,
  "filters_applied": {
    "type": "culotte",
    "size": "XXS"
  }
}
```

> **Tip**: Incluir `filters_applied` ayuda a Claude a saber exactamente qué filtros se usaron y puede informar al usuario si no hay resultados para su talla exacta.

#### Caso sin resultados

```json
{
  "products": [],
  "total": 0,
  "filters_applied": { "type": "culotte", "size": "XXS" },
  "suggestion": "No encontramos culottes en talla XXS. Disponibles en tallas XS, S, M, L."
}
```

---

### 3.2 `size_guide` — Guía de tallas

**POST** `/mesdessous/size_guide`

#### Request body

```json
{
  "product_type": "soutien-gorge",
  "brand": "Simone Pérèle"
}
```

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `product_type` | string | ✅ Sí | `soutien-gorge`, `culotte`, `collant`, `body`... |
| `brand` | string | No | Si la marca tiene su propia guía de tallas |

#### Response body

```json
{
  "product_type": "soutien-gorge",
  "brand": "Simone Pérèle",
  "how_to_measure": {
    "tour_de_poitrine": "Mesurer tout autour de la poitrine, au niveau du point le plus fort",
    "tour_de_dos": "Mesurer juste en dessous de la poitrine, à l'horizontale"
  },
  "size_chart": {
    "80A": { "tour_de_dos": "74-78 cm", "tour_de_poitrine": "83-85 cm" },
    "80B": { "tour_de_dos": "74-78 cm", "tour_de_poitrine": "85-88 cm" },
    "85C": { "tour_de_dos": "79-83 cm", "tour_de_poitrine": "91-94 cm" },
    "90D": { "tour_de_dos": "84-88 cm", "tour_de_poitrine": "98-101 cm" }
  },
  "conversions": {
    "FR/EU": "80B",
    "UK": "34B",
    "US": "34B",
    "IT": "2B"
  },
  "brand_notes": "Simone Pérèle coupe légèrement petite, nous conseillons de prendre une taille au-dessus."
}
```

---

### 3.3 `store_policies` — Políticas de la tienda

**POST** `/mesdessous/store_policies`

#### Request body

```json
{
  "topic": "shipping"
}
```

| Campo | Valores posibles | Descripción |
|---|---|---|
| `topic` | `shipping` | Envíos y tiempos de entrega |
| | `returns` | Devoluciones y cambios |
| | `payments` | Métodos de pago aceptados |
| | `orders` | Estado de pedidos, cancelaciones |
| | `promo` | Códigos promocionales, descuentos actuales |
| | `company` | Información de la empresa, contacto |

#### Response body (ejemplo: `topic = "shipping"`)

```json
{
  "topic": "shipping",
  "content": {
    "standard": {
      "delay": "3-5 jours ouvrés",
      "price": "4.99€",
      "free_from": "60€ d'achat"
    },
    "express": {
      "delay": "24-48h",
      "price": "9.99€"
    },
    "international": {
      "countries": ["Belgique", "Suisse", "Luxembourg", "Espagne"],
      "delay": "5-8 jours ouvrés",
      "price": "12.99€"
    },
    "carrier": "Colissimo",
    "cutoff_time": "Commandes passées avant 14h expédiées le jour même"
  }
}
```

---

## 4. Base de datos recomendada (PostgreSQL)

```sql
-- Tabla principal de productos
CREATE TABLE products (
    id           SERIAL PRIMARY KEY,
    client_id    VARCHAR(50)     NOT NULL,            -- 'mesdessous', 'otro-cliente'...
    product_id   VARCHAR(50)     NOT NULL,            -- ID original en Prestashop/Shopify
    name         TEXT            NOT NULL,
    brand        VARCHAR(100),
    type         VARCHAR(100),                        -- 'culotte', 'soutien-gorge'...
    sub_type     VARCHAR(200),                        -- 'avec armatures', 'taille haute'...
    gender       VARCHAR(20)     DEFAULT 'female',
    price        DECIMAL(10,2),
    old_price    DECIMAL(10,2),
    has_discount BOOLEAN         DEFAULT false,
    discount_pct INTEGER         DEFAULT 0,
    color        TEXT,                                -- 'Noir, Blanc, Nude'
    sizes        TEXT,                                -- 'XXS, XS, S, M, L'
    materials    TEXT,
    styles       TEXT,
    collection   VARCHAR(200),
    product_url  TEXT,
    image_url    TEXT,
    description  TEXT,
    active       BOOLEAN         DEFAULT true,
    synced_at    TIMESTAMP       DEFAULT NOW(),
    UNIQUE(client_id, product_id)
);

-- Índices para búsquedas rápidas
CREATE INDEX idx_products_client_type   ON products(client_id, type);
CREATE INDEX idx_products_client_brand  ON products(client_id, brand);
CREATE INDEX idx_products_client_gender ON products(client_id, gender);
CREATE INDEX idx_products_price         ON products(client_id, price);
CREATE INDEX idx_products_active        ON products(client_id, active);

-- Tabla de políticas (datos estáticos por cliente)
CREATE TABLE store_policies (
    id         SERIAL PRIMARY KEY,
    client_id  VARCHAR(50) NOT NULL,
    topic      VARCHAR(50) NOT NULL,                  -- 'shipping', 'returns'...
    content    JSONB       NOT NULL,
    updated_at TIMESTAMP   DEFAULT NOW(),
    UNIQUE(client_id, topic)
);
```

---

## 5. Lógica de búsqueda de productos

La clave del servicio es la búsqueda **exacta** (no semántica). El campo `sizes` es texto (`"XXS, XS, S, M, L"`) — hay que extraer tallas individuales:

```typescript
// Node.js + pg
async function productSearch(clientId: string, input: ProductSearchInput) {
  const conditions: string[] = ["client_id = $1", "active = true"];
  const params: unknown[] = [clientId];
  let idx = 2;

  if (input.type) {
    conditions.push(`(LOWER(type) LIKE $${idx} OR LOWER(sub_type) LIKE $${idx})`);
    params.push(`%${input.type.toLowerCase()}%`);
    idx++;
  }

  if (input.size) {
    // Regex para talla exacta: no confundir "S" con "XS" o "XS" con "XXS"
    // Busca la talla como token completo dentro del string de tallas
    conditions.push(`sizes ~* $${idx}`);
    params.push(`(^|[,\\s])${escapeRegex(input.size)}([,\\s]|$)`);
    idx++;
  }

  if (input.gender) {
    conditions.push(`(gender = $${idx} OR gender IS NULL OR gender = '')`);
    params.push(input.gender);
    idx++;
  }

  if (input.brand) {
    conditions.push(`LOWER(brand) LIKE $${idx}`);
    params.push(`%${input.brand.toLowerCase()}%`);
    idx++;
  }

  if (input.color) {
    conditions.push(`LOWER(color) LIKE $${idx}`);
    params.push(`%${input.color.toLowerCase()}%`);
    idx++;
  }

  if (input.max_price) {
    conditions.push(`price <= $${idx}`);
    params.push(input.max_price);
    idx++;
  }

  if (input.sub_type) {
    conditions.push(
      `(LOWER(sub_type) LIKE $${idx} OR LOWER(name) LIKE $${idx})`
    );
    params.push(`%${input.sub_type.toLowerCase()}%`);
    idx++;
  }

  // Solo productos con imágenes válidas
  conditions.push(
    `(image_url LIKE '%.jpg' OR image_url LIKE '%.png' OR image_url LIKE '%.webp')`
  );

  const where = conditions.join(" AND ");
  const sql = `
    SELECT id, name, brand, type, sub_type, price, old_price,
           has_discount, discount_pct, color, sizes, product_url, image_url, description
    FROM products
    WHERE ${where}
    ORDER BY has_discount DESC, price ASC
    LIMIT 10
  `;

  const { rows } = await db.query(sql, params);

  return {
    products: rows,
    total: rows.length,
    filters_applied: input,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

---

## 6. Estructura del proyecto (Express + TypeScript)

```
catalog-service/
├── src/
│   ├── server.ts                 # Entry point
│   ├── routes/
│   │   └── mesdessous.routes.ts  # POST /mesdessous/*
│   ├── handlers/
│   │   ├── product-search.ts
│   │   ├── size-guide.ts
│   │   └── store-policies.ts
│   ├── db/
│   │   ├── client.ts             # Pool de conexión PostgreSQL
│   │   └── migrations/
│   └── sync/
│       └── prestashop-sync.ts    # Cron de sincronización
├── .env
├── package.json
└── tsconfig.json
```

### `src/server.ts` (esqueleto mínimo)

```typescript
import express from "express";
import { mesdessousRouter } from "./routes/mesdessous.routes";

const app = express();
app.use(express.json());

// Autenticación por Bearer token
app.use((req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== process.env.API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

app.use("/mesdessous", mesdessousRouter);

app.listen(process.env.PORT ?? 3000, () => {
  console.log("Catalog Service running");
});
```

### `src/routes/mesdessous.routes.ts`

```typescript
import { Router } from "express";
import { productSearch } from "../handlers/product-search";
import { sizeGuide } from "../handlers/size-guide";
import { storePolicies } from "../handlers/store-policies";

export const mesdessousRouter = Router();

mesdessousRouter.post("/product_search", productSearch);
mesdessousRouter.post("/size_guide", sizeGuide);
mesdessousRouter.post("/store_policies", storePolicies);
```

### `src/handlers/product-search.ts`

```typescript
import { Request, Response } from "express";
import { db } from "../db/client";

export async function productSearch(req: Request, res: Response) {
  try {
    const result = await searchProducts("mesdessous", req.body);
    res.json(result);
  } catch (err) {
    // Siempre HTTP 200 — DatiHub/Claude deben gestionar el error con el usuario
    res.json({ error: "Error interno al buscar productos", products: [], total: 0 });
  }
}
```

---

## 7. Variables de entorno

```bash
# .env del Catalog Service
PORT=3000
DATABASE_URL=postgresql://user:pass@localhost:5432/catalog_db
API_KEY=sk-catalog-mesdessous-xxxxx    # El mismo que pondrás en DatiHub
```

---

## 8. Configurar el Flow en DatiHub

Una vez que el Catalog Service esté desplegado, configura el Flow con la API de DatiHub:

### Paso 1 — Verificar que el Flow tiene `aiProvider = ANTHROPIC`

```bash
GET /api/flows/{flowId}
```

El campo `aiProvider` debe ser `ANTHROPIC`. Si no, actualizarlo vía el endpoint de update de flow.

### Paso 2 — Configurar las tools

```bash
PUT /api/flows/{flowId}/tools
Content-Type: application/json
Authorization: Bearer {datihub-admin-token}

{
  "tools": [
    {
      "name": "product_search",
      "description": "Search lingerie catalog by type, size, brand, color, price",
      "endpoint": "https://catalog-api.tu-dominio.com/mesdessous/product_search",
      "apiKey": "$CATALOG_MESDESSOUS_API_KEY",
      "timeoutMs": 8000,
      "input_schema": {
        "type": "object",
        "properties": {
          "type":      { "type": "string", "description": "Product type: culotte, soutien-gorge, boxer, brassière, shorty, slip, corset, pyjama..." },
          "size":      { "type": "string", "description": "Exact size: XXS, XS, S, M, L, XL, 90A, 90B, 90C, 95C, FR34, FR36, T5, T6..." },
          "gender":    { "type": "string", "enum": ["female", "male"] },
          "brand":     { "type": "string", "description": "Brand name partial match" },
          "color":     { "type": "string", "description": "Color in French or English" },
          "max_price": { "type": "number", "description": "Maximum price in EUR" },
          "sub_type":  { "type": "string", "description": "avec armatures, sans armatures, taille haute, push-up, plongeant..." }
        },
        "required": ["type"]
      }
    },
    {
      "name": "size_guide",
      "description": "Get sizing guide and size conversions FR/EU/US/UK for a product type",
      "endpoint": "https://catalog-api.tu-dominio.com/mesdessous/size_guide",
      "apiKey": "$CATALOG_MESDESSOUS_API_KEY",
      "timeoutMs": 5000,
      "input_schema": {
        "type": "object",
        "properties": {
          "product_type": { "type": "string", "description": "soutien-gorge, culotte, collant, body..." },
          "brand":        { "type": "string", "description": "Brand name if brand-specific sizing" }
        },
        "required": ["product_type"]
      }
    },
    {
      "name": "store_policies",
      "description": "Store policies: shipping times and prices, return policy, accepted payments, promotions",
      "endpoint": "https://catalog-api.tu-dominio.com/mesdessous/store_policies",
      "apiKey": "$CATALOG_MESDESSOUS_API_KEY",
      "timeoutMs": 3000,
      "input_schema": {
        "type": "object",
        "properties": {
          "topic": {
            "type": "string",
            "enum": ["shipping", "returns", "payments", "orders", "promo", "company"],
            "description": "Policy topic to retrieve"
          }
        },
        "required": ["topic"]
      }
    }
  ]
}
```

> **Nota sobre `apiKey`**: El prefijo `$` indica que DatiHub resolverá el valor desde una variable de entorno del servidor. `"$CATALOG_MESDESSOUS_API_KEY"` → `process.env.CATALOG_MESDESSOUS_API_KEY`. El secreto real nunca se almacena en la base de datos.

### Paso 3 — Añadir la variable de entorno en el servidor de DatiHub

```bash
# En el .env del servidor DatiHub (o en las secrets del deploy)
CATALOG_MESDESSOUS_API_KEY=sk-catalog-mesdessous-xxxxx
```

### Paso 4 — Verificar configuración

```bash
GET /api/flows/{flowId}/tools

# Respuesta esperada:
{
  "tools": [
    { "name": "product_search", "endpoint": "https://...", ... },
    { "name": "size_guide", ... },
    { "name": "store_policies", ... }
  ]
}
```

---

## 9. Probar la integración

### Test directo al Catalog Service

```bash
# product_search
curl -X POST https://catalog-api.tu-dominio.com/mesdessous/product_search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-catalog-mesdessous-xxxxx" \
  -d '{ "type": "culotte", "size": "S", "color": "noir" }'

# size_guide
curl -X POST https://catalog-api.tu-dominio.com/mesdessous/size_guide \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-catalog-mesdessous-xxxxx" \
  -d '{ "product_type": "soutien-gorge" }'

# store_policies
curl -X POST https://catalog-api.tu-dominio.com/mesdessous/store_policies \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-catalog-mesdessous-xxxxx" \
  -d '{ "topic": "shipping" }'
```

### Test end-to-end vía WebChat

1. Abrir el widget de chat del flow de MesDessous
2. Enviar: `"Je cherche une culotte taille S en noir, pas trop chère"`
3. Verificar en los logs de DatiHub que aparece:
   - `Executing external tool: product_search`
   - `Tool executed successfully: product_search`
   - `Claude Tool Use response completed` con `rounds: 2`

---

## 10. Sincronización de productos desde Prestashop

```typescript
// sync/prestashop-sync.ts — ejecutar como cron cada 4h
import cron from "node-cron";
import { db } from "../db/client";

interface PrestashopProduct {
  id: number;
  name: string;
  // ...campos de Prestashop
}

async function syncProducts() {
  console.log("[sync] Iniciando sync de MesDessous...");

  // Obtener todos los productos activos de Prestashop
  const response = await fetch(
    `${process.env.PRESTASHOP_API_URL}/products?filter[active]=1&output_format=JSON`,
    { headers: { "Authorization": `Basic ${process.env.PRESTASHOP_API_KEY}` } }
  );
  const { products } = await response.json() as { products: PrestashopProduct[] };

  let upserted = 0;
  for (const p of products) {
    await db.query(
      `INSERT INTO products (client_id, product_id, name, brand, type, price, sizes, color, image_url, product_url, active, synced_at)
       VALUES ('mesdessous', $1, $2, $3, $4, $5, $6, $7, $8, $9, true, NOW())
       ON CONFLICT (client_id, product_id)
       DO UPDATE SET
         name=$2, brand=$3, type=$4, price=$5, sizes=$6,
         color=$7, image_url=$8, product_url=$9, synced_at=NOW()`,
      [
        String(p.id),
        extractName(p),
        extractBrand(p),
        extractType(p),
        extractPrice(p),
        extractSizes(p),
        extractColors(p),
        extractImageUrl(p),
        extractProductUrl(p),
      ]
    );
    upserted++;
  }

  console.log(`[sync] Completado: ${upserted} productos actualizados`);
}

// Ejecutar al inicio y luego cada 4 horas
syncProducts();
cron.schedule("0 */4 * * *", syncProducts);
```

---

## 11. Checklist antes de conectar a DatiHub

- [ ] El servicio responde en **menos de 8 segundos** (el timeout configurable, default 5s)
- [ ] Devuelve siempre `HTTP 200` con JSON válido (incluso en caso de error interno)
- [ ] El campo `sizes` permite búsqueda de talla exacta (no confundir "S" con "XS")
- [ ] La autenticación con Bearer token está activa
- [ ] El endpoint está accesible desde internet (HTTPS)
- [ ] Las variables de entorno `CATALOG_MESDESSOUS_API_KEY` están configuradas en DatiHub
- [ ] El Flow en DatiHub tiene `aiProvider = ANTHROPIC` y `toolsConfig` configurado

---

**Última actualización**: Mayo 2026  
**Relacionado con**: [`ai-specs/changes/claude-tool-use-integration_backend.md`](../../ai-specs/changes/claude-tool-use-integration_backend.md)
