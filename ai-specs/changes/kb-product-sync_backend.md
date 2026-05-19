# 🔄 Plan: Sincronización Multi-Origen de Base de Conocimientos

**Ticket**: kb-product-sync  
**Fecha**: 2026-04-13  
**Estado**: 📋 Plan (v2 — multi-source)  
**Capas afectadas**: Domain, Application, Infrastructure  

---

## 📌 Contexto

### Estado actual
1. **Fuente de datos actual**: XML exportado con ~38k productos para e-commerce Messdesous.
2. **Script de preparación**: `scripts/prepare-bedrock-kb.js` genera 1 JSON/producto en `bedrock-kb/products/`.
3. **Consumo**: `BedrockAgentService` (KB gestionado en AWS) + `KnowledgeBaseLoaderService` (context stuffing PostgreSQL).
4. **Problema**: Sync 100% manual, sin detección de cambios, sin soporte para múltiples tipos de fuente.

### Problema real: cada cliente es diferente
| Caso | Fuente | Frecuencia de cambio | Volumen |
|---|---|---|---|
| E-commerce (Messdesous) | XML feed exportado periódicamente | Diario (precios, stock) | ~30k docs |
| Empresa con docs internos | Archivos en Google Drive / SharePoint | Semanal / mensual | ~50-500 docs |
| SaaS con FAQ | Documentos Markdown / PDF subidos manualmente | Ocasional | ~20-100 docs |
| API de catálogo | REST API con paginación | Bajo demanda | Variable |

**No tiene sentido hardcodear la lógica para XML.** El sistema debe ser extensible a cualquier fuente.

### Objetivo
Crear un sistema de sincronización **agnóstico al origen** que:
- Soporte **múltiples tipos de fuente** a través de un patrón Strategy (providers).
- **Detecte cambios** de forma eficiente con hashes (cada provider decide cómo).
- **Suba solo los deltas** al destino (S3, PostgreSQL, o el que corresponda).
- Sea **extensible**: añadir un nuevo tipo de fuente = crear 1 clase nueva.
- Sea invocable como **endpoint API**, **CLI**, o **scheduled job** (PGMQ).

---

## 🏗️ Arquitectura Propuesta

### Diagrama general

```
                     ┌──────────────────────────────┐
                     │     SyncKnowledgeBase        │
                     │        UseCase               │
                     │   (Application Layer)        │
                     └──────────┬───────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │                       │
                    ▼                       ▼
     ┌──────────────────────┐   ┌──────────────────────┐
     │  IKBSourceProvider   │   │  IKBTargetPort       │
     │  (Domain Interface)  │   │  (Domain Interface)  │
     │                      │   │                      │
     │  - fetchDocuments()  │   │  - uploadDocuments() │
     │  - getSourceId()     │   │  - deleteDocuments() │
     │  - getSourceType()   │   │  - getManifest()     │
     └──────┬───────────────┘   │  - saveManifest()    │
            │                   │  - triggerReindex()   │
            │ Strategy          └──────────┬───────────┘
    ┌───────┼───────┐                      │
    │       │       │                      │ implementa
    ▼       ▼       ▼                      ▼
  ┌────┐ ┌────┐ ┌──────┐       ┌──────────────────────┐
  │XML │ │API │ │Upload│       │  S3BedrockTarget     │
  │Feed│ │REST│ │Files │       │  (Infrastructure)    │
  └────┘ └────┘ └──────┘       │  - S3 + Bedrock      │
                               └──────────────────────┘
                               ┌──────────────────────┐
                               │  PostgresTarget      │
                               │  (Infrastructure)    │
                               │  - KBDocument table  │
                               └──────────────────────┘
```

### Principio clave: **Strategy + Provider Registry**

```
KBSourceProviderRegistry (Infra)
  ├── 'xml-feed'      → XMLFeedSourceProvider
  ├── 'file-upload'   → FileUploadSourceProvider
  ├── 'rest-api'      → RestAPISourceProvider
  └── (futuro)        → GoogleDriveSourceProvider, etc.

KBTargetRegistry (Infra)
  ├── 'bedrock-s3'    → S3BedrockTargetAdapter
  └── 'postgres'      → PostgresTargetAdapter (context stuffing)
```

El Use Case **no conoce** ni XML ni S3 — solo trabaja con `IKBSourceProvider` y `IKBTargetPort`.

---

## 📁 Archivos a crear/modificar

### 1. Domain Layer

#### 1.1 Entidad: `SyncManifest`
**Archivo**: `src/domain/entities/sync-manifest.entity.ts`

Manifiesto genérico de sincronización — no acoplado a "productos".

```typescript
export interface ManifestEntry {
  documentId: string;           // ID único del documento
  sourceKey: string;            // Identificador en la fuente (path, URL, etc.)
  targetKey: string;            // Ubicación en el destino (S3 key, DB id, etc.)
  contentHash: string;          // SHA-256 del contenido normalizado
  metadata: Record<string, string>; // Metadata libre (brand, type, etc.)
  lastSyncedAt: Date;
}

export interface SyncDiff {
  toCreate: ManifestEntry[];
  toUpdate: ManifestEntry[];    // Mismo documentId, hash diferente
  toDelete: ManifestEntry[];    // En manifest pero no en source
  unchanged: number;
}
```

**Métodos de la entidad**:
- `computeDiff(currentDocuments: ManifestEntry[]): SyncDiff`
- `applyDiff(diff: SyncDiff): void`
- `getEntry(documentId: string): ManifestEntry | undefined`
- `get totalDocuments(): number`

#### 1.2 Value Object: `ContentHash`
**Archivo**: `src/domain/value-objects/content-hash.vo.ts`

```typescript
export class ContentHash {
  private constructor(private readonly value: string) {}

  static fromContent(content: string | object): ContentHash {
    // Si es object → JSON.stringify con keys ordenadas
    // SHA-256 del string resultante
  }

  equals(other: ContentHash): boolean { ... }
  toString(): string { return this.value; }
}
```

#### 1.3 Interfaz: `IKBSourceProvider` (Strategy)
**Archivo**: `src/domain/interfaces/ports/ikb-source-provider.port.ts`

Contrato que cada tipo de fuente debe implementar:

```typescript
/** Documento genérico extraído de cualquier fuente */
export interface KBSourceDocument {
  documentId: string;              // ID único y estable
  content: string;                 // Texto plano o structured text
  metadata: Record<string, string>; // Metadata indexable (brand, type, etc.)
  contentHash: string;             // Hash para detección de cambios
  suggestedTargetKey: string;      // Ruta sugerida en el destino
}

/** Configuración específica de cada fuente (varía por tipo) */
export type SourceConfig = Record<string, unknown>;

/** Resultado de la extracción */
export interface FetchResult {
  documents: KBSourceDocument[];
  totalFetched: number;
  totalFiltered: number;           // Rechazados por reglas de calidad
  sourceMetadata: Record<string, unknown>; // Stats de la fuente
}

export interface IKBSourceProvider {
  /** Identificador del tipo de fuente */
  readonly sourceType: string;     // 'xml-feed' | 'file-upload' | 'rest-api' | ...

  /** Extrae documentos de la fuente y los normaliza */
  fetch(config: SourceConfig): Promise<FetchResult>;

  /** Valida que la configuración sea válida para esta fuente */
  validateConfig(config: SourceConfig): void; // Throws si inválida
}
```

#### 1.4 Interfaz: `IKBTargetPort` (Destino)
**Archivo**: `src/domain/interfaces/ports/ikb-target.port.ts`

Contrato para el destino donde se persisten los documentos:

```typescript
export interface UploadResult {
  uploaded: number;
  errors: Array<{ key: string; error: string }>;
}

export interface IKBTargetPort {
  /** Lee el manifest de la última sync */
  getManifest(knowledgeBaseId: string): Promise<SyncManifest | null>;

  /** Guarda el manifest actualizado */
  saveManifest(knowledgeBaseId: string, manifest: SyncManifest): Promise<void>;

  /** Sube documentos nuevos o actualizados */
  uploadDocuments(
    knowledgeBaseId: string,
    documents: KBSourceDocument[],
    batchSize: number
  ): Promise<UploadResult>;

  /** Elimina documentos del destino */
  deleteDocuments(knowledgeBaseId: string, targetKeys: string[]): Promise<void>;

  /** Dispara re-indexación si el destino lo soporta (opcional) */
  triggerReindex?(knowledgeBaseId: string): Promise<string | null>;
}
```

#### 1.5 Interfaz: `IKBSourceProviderRegistry` (Factory)
**Archivo**: `src/domain/interfaces/ports/ikb-source-provider-registry.port.ts`

```typescript
export interface IKBSourceProviderRegistry {
  get(sourceType: string): IKBSourceProvider;
  has(sourceType: string): boolean;
  getAvailableTypes(): string[];
}
```

---

### 2. Application Layer

#### 2.1 Use Case: `SyncKnowledgeBaseUseCase`
**Archivo**: `src/app/use-cases/knowledge-base/sync-knowledge-base.use-case.ts`

Orquesta el flujo completo de sincronización, **agnóstico al origen y destino**:

```typescript
@injectable()
export class SyncKnowledgeBaseUseCase {
  constructor(
    @inject(DI.KBSourceProviderRegistry) private readonly providers: IKBSourceProviderRegistry,
    @inject(DI.KBTargetPort)             private readonly target: IKBTargetPort,
  ) {}

  async execute(input: SyncKnowledgeBaseInput): Promise<SyncResult> {
    // 1. Resolver provider por sourceType
    const provider = this.providers.get(input.sourceType);
    provider.validateConfig(input.sourceConfig);

    // 2. Fetch documents desde la fuente
    const fetchResult = await provider.fetch(input.sourceConfig);

    // 3. Obtener manifest previo del destino
    const manifest = await this.target.getManifest(input.knowledgeBaseId)
                     ?? SyncManifest.empty();

    // 4. Computar diff
    const entries = fetchResult.documents.map(doc => ({
      documentId: doc.documentId,
      sourceKey: doc.documentId,
      targetKey: doc.suggestedTargetKey,
      contentHash: doc.contentHash,
      metadata: doc.metadata,
      lastSyncedAt: new Date(),
    }));
    const diff = manifest.computeDiff(entries);

    // 5. Si dryRun, retornar estadísticas sin ejecutar
    if (input.dryRun) {
      return this.buildResult(diff, fetchResult, 0, []);
    }

    // 6. Upload nuevos + modificados
    const docsToUpload = fetchResult.documents.filter(d =>
      diff.toCreate.some(e => e.documentId === d.documentId) ||
      diff.toUpdate.some(e => e.documentId === d.documentId)
    );
    const uploadResult = await this.target.uploadDocuments(
      input.knowledgeBaseId, docsToUpload, input.batchSize ?? 100
    );

    // 7. Delete removidos
    if (diff.toDelete.length > 0) {
      await this.target.deleteDocuments(
        input.knowledgeBaseId,
        diff.toDelete.map(e => e.targetKey)
      );
    }

    // 8. Guardar manifest actualizado
    manifest.applyDiff(diff);
    await this.target.saveManifest(input.knowledgeBaseId, manifest);

    // 9. Trigger re-indexación (si aplica)
    let ingestionJobId: string | null = null;
    if (this.target.triggerReindex && !input.dryRun) {
      ingestionJobId = await this.target.triggerReindex(input.knowledgeBaseId);
    }

    return this.buildResult(diff, fetchResult, elapsed, uploadResult.errors, ingestionJobId);
  }
}
```

**Input Type**:
```typescript
export interface SyncKnowledgeBaseInput {
  knowledgeBaseId: string;            // KB destino
  sourceType: string;                 // 'xml-feed' | 'file-upload' | 'rest-api'
  sourceConfig: SourceConfig;         // Config específica del provider
  dryRun?: boolean;                   // Solo calcular diff
  forceFullSync?: boolean;            // Ignorar manifest previo
  batchSize?: number;                 // Default: 100
}
```

**Output Type**:
```typescript
export interface SyncResult {
  knowledgeBaseId: string;
  sourceType: string;
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  totalDocuments: number;
  totalFetched: number;
  totalFiltered: number;
  ingestionJobId?: string | null;
  durationMs: number;
  errors: Array<{ key: string; error: string }>;
}
```

---

### 3. Infrastructure Layer

#### 3.1 Source Provider: `XMLFeedSourceProvider`
**Archivo**: `src/infraestructure/services/kb-sync/providers/xml-feed-source.provider.ts`

Implementa `IKBSourceProvider` para fuentes XML (e-commerce):

```typescript
@injectable()
export class XMLFeedSourceProvider implements IKBSourceProvider {
  readonly sourceType = 'xml-feed';

  validateConfig(config: SourceConfig): void {
    // Zod inline: { filePath: string, filterField?: string }
  }

  async fetch(config: SourceConfig): Promise<FetchResult> {
    // 1. Lee el XML desde filePath (local o URL)
    // 2. Parsea bloques <IA>
    // 3. Filtra (ej: solo con linkvariation)
    // 4. Genera KBSourceDocument[] con:
    //    - documentId = reference/productId
    //    - content = texto enriquecido
    //    - metadata = { brand, type, price, ... }
    //    - contentHash = SHA-256 del JSON normalizado
    //    - suggestedTargetKey = 'products/{Brand}/product-{index}.json'
  }
}
```

**Config schema** (`xml-feed`):
```typescript
{
  filePath: string;            // Ruta al XML (local o URL)
  filterField?: string;        // Campo que debe existir (default: 'linkvariation')
  maxDescriptionLength?: number; // Default: 1500
}
```

#### 3.2 Source Provider: `FileUploadSourceProvider`
**Archivo**: `src/infraestructure/services/kb-sync/providers/file-upload-source.provider.ts`

Para documentos subidos manualmente (PDF, Markdown, TXT) — caso Drive / upload directo:

```typescript
@injectable()
export class FileUploadSourceProvider implements IKBSourceProvider {
  readonly sourceType = 'file-upload';

  async fetch(config: SourceConfig): Promise<FetchResult> {
    // 1. Lee directorio o lista de archivos desde config.directoryPath
    // 2. Para cada archivo:
    //    - Lee contenido (text extraction si PDF, raw si .md/.txt)
    //    - documentId = hash del path relativo
    //    - contentHash = SHA-256 del contenido
    //    - metadata = { fileName, mimeType, sizeBytes }
    //    - suggestedTargetKey = 'documents/{fileName}'
  }
}
```

**Config schema** (`file-upload`):
```typescript
{
  directoryPath: string;       // Carpeta con los archivos
  extensions?: string[];       // Filtro por extensión (default: ['.md', '.txt', '.pdf'])
  recursive?: boolean;         // Buscar en subdirectorios (default: true)
}
```

#### 3.3 Source Provider: `RestAPISourceProvider`
**Archivo**: `src/infraestructure/services/kb-sync/providers/rest-api-source.provider.ts`

Para catálogos expuestos por API REST con paginación:

```typescript
@injectable()
export class RestAPISourceProvider implements IKBSourceProvider {
  readonly sourceType = 'rest-api';

  async fetch(config: SourceConfig): Promise<FetchResult> {
    // 1. Fetch paginado: GET config.url?page=1&limit=config.pageSize
    // 2. Seguir paginación hasta que no haya más resultados
    // 3. Para cada item:
    //    - documentId = item[config.idField]
    //    - content = config.contentTemplate(item) o JSON.stringify
    //    - contentHash = SHA-256
    //    - metadata extraída según config.metadataFields
  }
}
```

**Config schema** (`rest-api`):
```typescript
{
  url: string;                  // Base URL del endpoint
  headers?: Record<string, string>; // Headers (auth, etc.)
  method?: 'GET' | 'POST';     // Default: GET
  pageSize?: number;            // Default: 100
  idField: string;              // Campo del ID en el response
  contentFields: string[];      // Campos a concatenar como contenido
  metadataFields?: string[];    // Campos a extraer como metadata
  paginationType?: 'offset' | 'cursor' | 'none'; // Default: offset
}
```

#### 3.4 Provider Registry: `KBSourceProviderRegistry`
**Archivo**: `src/infraestructure/services/kb-sync/kb-source-provider-registry.ts`

```typescript
@injectable()
export class KBSourceProviderRegistry implements IKBSourceProviderRegistry {
  private readonly providers = new Map<string, IKBSourceProvider>();

  constructor(
    @inject(DI.XMLFeedSourceProvider)     xmlFeed: IKBSourceProvider,
    @inject(DI.FileUploadSourceProvider)  fileUpload: IKBSourceProvider,
    @inject(DI.RestAPISourceProvider)     restApi: IKBSourceProvider,
  ) {
    this.register(xmlFeed);
    this.register(fileUpload);
    this.register(restApi);
  }

  private register(provider: IKBSourceProvider): void {
    this.providers.set(provider.sourceType, provider);
  }

  get(sourceType: string): IKBSourceProvider {
    const provider = this.providers.get(sourceType);
    if (!provider) {
      throw ErrorFactory.create('bad-request',
        `Source type "${sourceType}" not supported. Available: ${this.getAvailableTypes().join(', ')}`
      );
    }
    return provider;
  }

  has(sourceType: string): boolean {
    return this.providers.has(sourceType);
  }

  getAvailableTypes(): string[] {
    return Array.from(this.providers.keys());
  }
}
```

#### 3.5 Target: `S3BedrockTargetAdapter`
**Archivo**: `src/infraestructure/services/kb-sync/targets/s3-bedrock-target.adapter.ts`

Implementa `IKBTargetPort` para S3 + Bedrock KB:

```typescript
@injectable()
export class S3BedrockTargetAdapter implements IKBTargetPort {
  // S3Client para upload/delete
  // BedrockAgentClient para StartIngestionJob

  async getManifest(knowledgeBaseId: string): Promise<SyncManifest | null> {
    // GetObjectCommand: `_meta/${knowledgeBaseId}/_sync-manifest.json`
  }

  async saveManifest(knowledgeBaseId: string, manifest: SyncManifest): Promise<void> {
    // PutObjectCommand
  }

  async uploadDocuments(kbId: string, docs: KBSourceDocument[], batchSize: number): Promise<UploadResult> {
    // PutObjectCommand en batches con concurrencia limitada (p-limit, 10)
    // ContentType: 'application/json'
    // Body: JSON con { metadataAttributes: doc.metadata, content: doc.content }
  }

  async deleteDocuments(kbId: string, targetKeys: string[]): Promise<void> {
    // DeleteObjectsCommand en chunks de 1000
  }

  async triggerReindex(knowledgeBaseId: string): Promise<string | null> {
    // StartIngestionJobCommand({ knowledgeBaseId, dataSourceId })
    // Retorna ingestionJobId
  }
}
```

**Configuración** (env vars):
```env
AWS_KB_S3_BUCKET=messdesous-kb-production
AWS_BEDROCK_KB_ID=<knowledge-base-id>
AWS_BEDROCK_KB_DATA_SOURCE_ID=<data-source-id>
```

#### 3.6 Target: `PostgresTargetAdapter`
**Archivo**: `src/infraestructure/services/kb-sync/targets/postgres-target.adapter.ts`

Implementa `IKBTargetPort` para el modelo `KnowledgeBaseDocument` existente (context stuffing via `KnowledgeBaseLoaderService`):

```typescript
@injectable()
export class PostgresTargetAdapter implements IKBTargetPort {
  constructor(
    @inject(DI.KnowledgeBaseRepository) private readonly repo: IKnowledgeBaseRepository,
    @inject(DI.KnowledgeBaseLoader)     private readonly loader: IKnowledgeBaseLoader,
  ) {}

  async uploadDocuments(kbId: string, docs: KBSourceDocument[], batchSize: number): Promise<UploadResult> {
    // upsert KnowledgeBaseDocument records
    // Después: this.loader.reload(kbId) para invalidar cache
  }

  async deleteDocuments(kbId: string, targetKeys: string[]): Promise<void> {
    // Delete KnowledgeBaseDocument by fileName matching targetKeys
    // Después: this.loader.reload(kbId)
  }

  async triggerReindex(): Promise<string | null> {
    return null; // No aplica — context stuffing recarga en la siguiente request
  }

  // Manifest se guarda como un KnowledgeBaseDocument especial con fileName = '_sync-manifest'
}
```

> **Cuándo usar**: Para KBs pequeñas (<500 docs) donde context stuffing es suficiente y no se necesita Bedrock.

#### 3.7 Schema Zod
**Archivo**: `src/infraestructure/http/schemas/knowledge-base/sync-knowledge-base.schema.ts`

```typescript
export const syncKnowledgeBaseSchema = z.object({
  knowledgeBaseId: z.string().uuid(),
  sourceType: z.string().min(1),              // Se valida contra el registry
  sourceConfig: z.record(z.unknown()),        // Cada provider valida su config internamente
  dryRun: z.boolean().optional().default(false),
  forceFullSync: z.boolean().optional().default(false),
  batchSize: z.number().int().min(1).max(500).optional().default(100),
});

export type SyncKnowledgeBaseInput = z.infer<typeof syncKnowledgeBaseSchema>;
```

#### 3.8 Controller: Nuevo endpoint en `KnowledgeBaseController`
**Archivo a modificar**: `src/infraestructure/http/controllers/knowledge/knowledge-base.controller.ts`

```
POST /api/knowledge-bases/:id/sync
Body: { sourceType, sourceConfig, dryRun?, forceFullSync?, batchSize? }
Response: SyncResult

GET  /api/knowledge-bases/:id/sync/providers
Response: { providers: ['xml-feed', 'file-upload', 'rest-api'] }
```

#### 3.9 Route
**Archivo a modificar**: `src/infraestructure/http/routes/knowledge/knowledge-base.routes.ts`

```typescript
router.post('/:id/sync', authMiddleware, adminOnly, (req, res) => controller.sync(req, res));
router.get('/:id/sync/providers', authMiddleware, (req, res) => controller.getSyncProviders(req, res));
```

#### 3.10 DI Registration
**Archivo a modificar**: `src/infraestructure/DI/modules/knowledge-base.module.ts`

```typescript
// Source Providers
container.registerSingleton<IKBSourceProvider>(DI.XMLFeedSourceProvider, XMLFeedSourceProvider);
container.registerSingleton<IKBSourceProvider>(DI.FileUploadSourceProvider, FileUploadSourceProvider);
container.registerSingleton<IKBSourceProvider>(DI.RestAPISourceProvider, RestAPISourceProvider);
container.registerSingleton<IKBSourceProviderRegistry>(DI.KBSourceProviderRegistry, KBSourceProviderRegistry);

// Target (default: S3 Bedrock — cambiar a Postgres si aplica)
container.registerSingleton<IKBTargetPort>(DI.KBTargetPort, S3BedrockTargetAdapter);

// Use Case
container.register<SyncKnowledgeBaseUseCase>(DI.SyncKnowledgeBaseUseCase, SyncKnowledgeBaseUseCase);
```

#### 3.11 DI Tokens
**Archivo a modificar**: `src/infraestructure/DI/global-symbol.ts`

```typescript
// KB Sync
KBSourceProviderRegistry: Symbol.for('IKBSourceProviderRegistry'),
KBTargetPort: Symbol.for('IKBTargetPort'),
XMLFeedSourceProvider: Symbol.for('XMLFeedSourceProvider'),
FileUploadSourceProvider: Symbol.for('FileUploadSourceProvider'),
RestAPISourceProvider: Symbol.for('RestAPISourceProvider'),
SyncKnowledgeBaseUseCase: Symbol.for('SyncKnowledgeBaseUseCase'),
```

#### 3.12 CLI Script
**Archivo**: `scripts/sync-knowledge-base.ts`

```bash
# E-commerce XML feed
npx ts-node scripts/sync-knowledge-base.ts \
  --kb-id "uuid" \
  --source xml-feed \
  --config '{"filePath": "scripts/650.ia_agent.xml"}'

# Archivos locales (docs de Drive descargados)
npx ts-node scripts/sync-knowledge-base.ts \
  --kb-id "uuid" \
  --source file-upload \
  --config '{"directoryPath": "/path/to/drive-docs", "extensions": [".pdf", ".md"]}'

# API REST
npx ts-node scripts/sync-knowledge-base.ts \
  --kb-id "uuid" \
  --source rest-api \
  --config '{"url": "https://api.ejemplo.com/products", "idField": "sku", "contentFields": ["name", "description"]}'

# Dry run (cualquier fuente)
npx ts-node scripts/sync-knowledge-base.ts --kb-id "uuid" --source xml-feed --config '...' --dry-run
```

---

### 4. Dependencias npm

```bash
pnpm add @aws-sdk/client-s3 @aws-sdk/client-bedrock-agent p-limit
```

> `@aws-sdk/client-bedrock-agent-runtime` ya está instalado. Se necesita `@aws-sdk/client-bedrock-agent` (sin `-runtime`) para `StartIngestionJobCommand`. `p-limit` para concurrencia controlada en uploads.

---

## 🔄 Flujo de Sincronización (agnóstico)

```
┌──────────────────────────────────────────────────────────────┐
│                    SYNC FLOW (Generic)                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Resolver provider por sourceType                         │
│     └─ Registry.get('xml-feed') → XMLFeedSourceProvider      │
│                                                              │
│  2. Validar sourceConfig con provider.validateConfig()       │
│                                                              │
│  3. Fetch documents desde la fuente                          │
│     └─ Provider.fetch(config) → FetchResult                  │
│        (Cada provider sabe cómo extraer y normalizar)        │
│                                                              │
│  4. Obtener manifest previo del destino                      │
│     └─ Target.getManifest(kbId) → SyncManifest | null        │
│                                                              │
│  5. Computar diff via SyncManifest.computeDiff()             │
│     ├─ NUEVO:     documentId no está en manifest             │
│     ├─ MODIFICADO: documentId existe, hash diferente         │
│     ├─ ELIMINADO:  documentId existe en manifest, no en src  │
│     └─ SIN CAMBIOS: hash igual                               │
│                                                              │
│  6. Si dryRun → retornar stats sin ejecutar                  │
│                                                              │
│  7. Target.uploadDocuments() (nuevos + modificados)          │
│  8. Target.deleteDocuments() (eliminados)                    │
│  9. Target.saveManifest() (manifest actualizado)             │
│ 10. Target.triggerReindex() (si aplica)                      │
│                                                              │
│ 11. Retornar SyncResult con stats completas                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 📊 Comparativa de Providers

| Provider | Para qué caso | Input | Volumen típico | Frecuencia |
|---|---|---|---|---|
| `xml-feed` | E-commerce con XML feed | Archivo XML local o URL | 1k–50k docs | Diario |
| `file-upload` | Docs manuales (Drive, local) | Directorio con archivos | 10–500 docs | Semanal+ |
| `rest-api` | Catálogo vía API REST | URL + paginación | Variable | Bajo demanda |

### Cómo añadir un nuevo provider (ej: Google Drive)

1. Crear `src/infraestructure/services/kb-sync/providers/google-drive-source.provider.ts`
2. Implementar `IKBSourceProvider` con `sourceType = 'google-drive'`
3. Registrar en DI: `container.registerSingleton(DI.GoogleDriveSourceProvider, GoogleDriveSourceProvider)`
4. Inyectar en el constructor del `KBSourceProviderRegistry`
5. **0 cambios** en Use Case, Controller, o Domain

---

## 📄 Manifest (`_sync-manifest.json`)

```json
{
  "version": "1.0.0",
  "knowledgeBaseId": "uuid-del-kb",
  "sourceType": "xml-feed",
  "lastSyncAt": "2026-04-13T10:30:00Z",
  "totalDocuments": 30460,
  "entries": {
    "11065_384601": {
      "documentId": "11065_384601",
      "sourceKey": "11065_384601",
      "targetKey": "products/Lise-Charmel/product-000001.json",
      "contentHash": "a1b2c3d4e5f6...",
      "metadata": { "brand": "Lise Charmel", "type": "Culotte & Slip" },
      "lastSyncedAt": "2026-04-13T10:30:00Z"
    }
  }
}
```

---

## ⚠️ Notas Importantes

1. **Hash determinista**: `ContentHash.fromContent(obj)` ordena keys recursivamente antes de stringify → mismo contenido = mismo hash siempre.

2. **Bedrock re-indexa todo**: `StartIngestionJob` re-procesa todo el data source S3. La eficiencia real está en **reducir operaciones S3** (no re-subir lo que no cambió). Bedrock cobra por documentos procesados, así que menos archivos nuevos/modificados = menos costo.

3. **Target intercambiable**: Un mismo KB puede usar `S3BedrockTarget` en producción y `PostgresTarget` en desarrollo/staging. El Use Case no cambia.

4. **Concurrencia S3**: `p-limit` con concurrency de 10-20 para uploads. S3 soporta miles de requests/segundo pero es mejor ser conservador.

5. **Seguridad RestAPI provider**: Las credenciales de APIs externas se pasan en `sourceConfig.headers` — asegurarse de que el endpoint de sync solo sea accesible por ADMIN y que los logs no impriman headers de auth.

6. **Extensión no planificada pero trivial**: `GoogleDriveSourceProvider`, `NotionSourceProvider`, `ConfluenceSourceProvider` — cada uno solo necesita implementar `fetch()` y `validateConfig()`.

---

## 🧪 Tests

### Unit Tests

| Test File | Qué cubre |
|---|---|
| `test/domain/entities/sync-manifest.entity.test.ts` | `computeDiff()` — created/updated/deleted/unchanged |
| `test/domain/value-objects/content-hash.vo.test.ts` | Hash determinista, consistencia |
| `test/app/use-cases/knowledge-base/sync-knowledge-base.use-case.test.ts` | Orquestación: mock providers + target, dryRun, forceSync |
| `test/infraestructure/services/kb-sync/kb-source-provider-registry.test.ts` | Resolución de providers, error en tipo desconocido |

### Integration Tests

| Test File | Qué cubre |
|---|---|
| `test/infraestructure/services/kb-sync/providers/xml-feed-source.provider.test.ts` | Parsing XML real (fixture pequeño ~10 products) |
| `test/infraestructure/services/kb-sync/providers/file-upload-source.provider.test.ts` | Lectura de directorio con mixed files |
| `test/infraestructure/services/kb-sync/targets/s3-bedrock-target.adapter.test.ts` | Mock AWS SDK, verificar PutObject/Delete/Ingestion |
| `test/infraestructure/services/kb-sync/targets/postgres-target.adapter.test.ts` | Mock repository, verify upsert + cache reload |

### Cobertura objetivo: **90%**

---

## 📝 Commits Sugeridos

| # | Tipo | Mensaje | Archivos |
|---|---|---|---|
| 1 | `feat(domain)` | `feat(domain): add SyncManifest entity, ContentHash VO, and KB sync interfaces` | entity, VO, interfaces (IKBSourceProvider, IKBTargetPort, IKBSourceProviderRegistry) |
| 2 | `feat(app)` | `feat(app): add SyncKnowledgeBaseUseCase with multi-source support` | use case |
| 3 | `feat(infra)` | `feat(infra): add XMLFeedSourceProvider for e-commerce product sync` | xml-feed provider |
| 4 | `feat(infra)` | `feat(infra): add FileUploadSourceProvider for document-based KB sync` | file-upload provider |
| 5 | `feat(infra)` | `feat(infra): add RestAPISourceProvider for API-based KB sync` | rest-api provider |
| 6 | `feat(infra)` | `feat(infra): add S3BedrockTargetAdapter and PostgresTargetAdapter` | targets + provider registry |
| 7 | `feat(api)` | `feat(api): add POST /knowledge-bases/:id/sync endpoint` | schema, controller, route, DI tokens |
| 8 | `feat(cli)` | `feat(cli): add sync-knowledge-base CLI script` | script |
| 9 | `test` | `test: add unit and integration tests for KB sync system` | tests |
| 10 | `docs` | `docs(specs): update api-spec with KB sync endpoints` | api-spec.yml |

---

## 📋 Checklist de Validación

- [ ] **Estructura**: Schema Zod en `infra/http/schemas/knowledge-base/`
- [ ] **Domain puro**: Interfaces y entidades sin dependencias externas
- [ ] **Strategy**: Nuevo provider = 1 clase nueva + registro en DI, 0 cambios en Use Case
- [ ] **Inyección**: Use Case inyecta `IKBSourceProviderRegistry` e `IKBTargetPort` (interfaces)
- [ ] **Errores**: `ErrorFactory` para source-type desconocido, config inválida, upload failures
- [ ] **Naming**: Commits siguen Conventional Commits con scope
- [ ] **Docs**: Actualizar `api-spec.yml` con nuevos endpoints
- [ ] **Seguridad**: Endpoint protegido con auth + ADMIN role
- [ ] **No `any`**: Tipado estricto — `SourceConfig` es `Record<string, unknown>`, validado por cada provider
- [ ] **Target intercambiable**: S3Bedrock y Postgres son intercambiables vía DI

---

## 🔮 Extensiones Futuras (fuera de scope)

1. **Scheduled Job**: PGMQ scheduled task que ejecute sync a intervalos configurados por KB
2. **Google Drive / Notion / Confluence providers**: Implementar `IKBSourceProvider`
3. **Progress tracking**: WebSocket/SSE para mostrar progreso en frontend
4. **Multi-target**: Un KB puede sincronizarse a S3 y Postgres simultáneamente
5. **Rollback**: Guardar N manifests históricos para revertir
6. **Webhook receiver**: Endpoint que reciba push notifications cuando la fuente cambia
7. **Source config en DB**: Guardar la configuración de fuente en el modelo `KnowledgeBase` para auto-sync
