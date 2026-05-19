# Plan: File Storage Docker System (MinIO + Streaming)

> **Feature**: `file-storage-docker-system`  
> **Fecha**: 2026-03-31  
> **Autor**: backend-developer agent

---

## Contexto y Diagnóstico

El proyecto ya tiene un esqueleto de storage (`StorageManager`, `LocalStorageDriver`, `S3StorageDriver`) pero:

1. **Todos los drivers son stubs** — cada método lanza `throw new Error("Method not implemented.")`.
2. **Sin soporte de streams** — `StorageProvider` solo acepta `Buffer | string`.
3. **Sin Docker de almacenamiento** — solo hay compose para Redis, PG y MySQL.
4. **Sin middleware HTTP para multipart** — `multer`/`busboy` no están instalados.
5. **Sin entidad de use-case** para orquestar la carga desde la capa de aplicación.

El plan cubre todo el stack vertical:  
`Docker MinIO → S3Driver (impl.) → LocalDriver (impl.) → StoreageProvider (stream) → Middleware multipart → UseCase → Controller → Route`.

---

## Estrategia de Drivers

| Driver | Cuándo | Configuración |
|---|---|---|
| `local` | Dev sin Docker, CI | `STORAGE_LOCAL_ROOT=storage/app/public` |
| `s3` (→ MinIO local) | Dev con Docker | `AWS_ENDPOINT=http://localhost:9000` + `AWS_BUCKET=datihub` |
| `s3` (→ AWS real) | Producción | Variables AWS estándar sin `AWS_ENDPOINT` |

> **Decisión clave**: No se añade un driver `minio` separado. MinIO es 100% compatible con la API S3.  
> El `S3StorageDriver` existente, una vez implementado con `@aws-sdk/client-s3`, sirve para ambos entornos simplemente cambiando `AWS_ENDPOINT`.

---

## Packages a Instalar

```bash
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage multer
npm install --save-dev @types/multer
```

| Paquete | Uso |
|---|---|
| `@aws-sdk/client-s3` | Cliente S3 (funciona con MinIO vía `endpoint`) |
| `@aws-sdk/lib-storage` | `Upload` class para stream multipart a S3/MinIO |
| `multer` | Middleware Express para recibir `multipart/form-data` vía HTTP |
| `@types/multer` | Tipos TypeScript para multer |

> `busboy` **no es necesario** — `multer` con `memoryStorage()` es suficiente para archivos hasta ~50 MB y usa streams internamente. Para archivos muy grandes, se puede usar el `s3-storage-engine` de `multer-s3` en un paso posterior.

---

## Arquitectura Final

```
docker/docker-compose.minio.yml                  ← MinIO service + console UI

domain/interfaces/providers/storage.provider.ts  ← Amplía: putStream, getStream, PutStreamOptions, StorageUploadResult

infraestructure/config/
  drivers.ts                                      ← StorageDriver.MINIO (alias de s3 para docs)
  storage.config.ts                               ← MINIO_* env vars + STORAGE_TOKEN.MinIO (opcional)

infraestructure/storage/
  StorageManager.ts                               ← Actualiza tokenMap
  drivers/
    local-storage-driver.ts                       ← Implementación real con fs/promises
    s3-storage-driver.ts                          ← Implementación real con @aws-sdk/client-s3

infraestructure/http/
  middlewares/upload.middleware.ts                ← multer memoryStorage, límites y filtros MIME
  controllers/storage.controller.ts              ← Nuevo: recibe multipart, llama UseCase
  routes/storage.route.ts                         ← Nuevo: POST /storage/upload, GET /storage/*

app/use-cases/storage/
  upload-file.use-case.ts                         ← Orquesta validación + StorageManager
  upload-file.dto.ts                              ← Zod schemas

infraestructure/DI/container.ts                   ← Registra drivers

test/
  infraestructure/storage/local-storage-driver.test.ts
  infraestructure/storage/s3-storage-driver.test.ts
  app/use-cases/storage/upload-file.use-case.test.ts
```

---

## Fase 1 — Docker: MinIO

### `docker/docker-compose.minio.yml`

```yaml
services:
  minio:
    image: minio/minio:latest
    container_name: minio-container
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"   # S3 API
      - "9001:9001"   # Web console (http://localhost:9001)
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - dev-network

  # Crear el bucket automáticamente al arrancar
  minio-createbuckets:
    image: minio/mc:latest
    container_name: minio-createbuckets
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 minioadmin minioadmin;
      mc mb --ignore-existing local/datihub;
      mc anonymous set download local/datihub/public;
      exit 0;
      "
    networks:
      - dev-network

volumes:
  minio_data:
    driver: local

networks:
  dev-network:
    driver: bridge
```

**Variables `.env` para dev con MinIO:**
```env
STORAGE_DRIVER=s3
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
AWS_REGION=us-east-1
AWS_BUCKET=datihub
AWS_ENDPOINT=http://localhost:9000
STORAGE_PUBLIC_URL=http://localhost:9000/datihub   # URL base pública
```

---

## Fase 2 — Domain: Extender `StorageProvider`

### `src/domain/interfaces/providers/storage.provider.ts`

```typescript
import type { Readable } from "stream";

export interface StorageResponse {
  url: string;
  key: string;
  size?: number;
  mimeType?: string;
}

/** Opciones para subida vía stream */
export interface PutStreamOptions {
  mimeType?: string;
  size?: number;                          // Content-Length hint para S3 multipart
  metadata?: Record<string, string>;
}

/** Resultado enriquecido de put/putStream */
export interface StorageUploadResult {
  path: string;   // key en el storage (ej. "uploads/image.png")
  url: string;    // URL pública o firmada
  size?: number;
  mimeType?: string;
}

export interface StorageProvider {
  /** Guardar desde Buffer o string */
  put(path: string, content: Buffer | string): Promise<string>;

  /** Guardar desde un stream Node.js (ideal para WebSocket / WhatsApp media) */
  putStream(path: string, stream: Readable, options?: PutStreamOptions): Promise<StorageUploadResult>;

  /** Obtener como Buffer */
  get(path: string): Promise<Buffer>;

  /** Obtener como stream legible (descarga progresiva) */
  getStream(path: string): Promise<Readable>;

  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;

  /** URL pública o signed URL */
  url(path: string): Promise<string>;
}
```

> **Regla**: El dominio importa solo `stream` (módulo nativo de Node). Nunca importa `fs`, `@aws-sdk`, ni ninguna librería de terceros.

---

## Fase 3 — Infrastructure: Implementar Drivers

### 3.1 `src/infraestructure/config/drivers.ts`

Añadir comentario doc al enum (no es un driver separado, es un alias de `s3` para claridad):

```typescript
export enum StorageDriver {
  LOCAL = "local",
  S3    = "s3",     // también usado como driver para MinIO (via AWS_ENDPOINT)
  GCS   = "gcs",
  AZURE = "azure",
}
```

> No se añade `MINIO` como valor separado — evita bifurcación innecesaria. El driver `s3` detecta `AWS_ENDPOINT` para distinguir.

### 3.2 `src/infraestructure/config/storage.config.ts`

Añadir las nuevas variables MinIO/públicas al objeto `STORAGE_ENV`:

```typescript
export const STORAGE_ENV = {
  DRIVER: requiredEnv("STORAGE_DRIVER", STORAGE_DRIVER, "local"),

  // URL base para servir archivos públicos (se usa en url())
  PUBLIC_URL: process.env.STORAGE_PUBLIC_URL || "",

  disks: {
    local: {
      root: STORAGE_LOCAL_ROOT || "storage/app/public",
    },
    s3: {
      key:      AWS_ACCESS_KEY_ID,
      secret:   AWS_SECRET_ACCESS_KEY,
      region:   AWS_REGION || "us-east-1",
      bucket:   AWS_BUCKET,
      endpoint: AWS_ENDPOINT,             // undefined en producción → apunta a AWS real
      publicUrl: process.env.STORAGE_PUBLIC_URL || "",
    },
    // gcs / azure: sin cambios
  },
};

export const STORAGE_TOKEN = {
  Manager: Symbol("StorageManager"),
  Config:  Symbol("StorageConfig"),
  Local:   Symbol("LocalStorageDriver"),
  S3:      Symbol("S3StorageDriver"),
};
```

### 3.3 `src/infraestructure/storage/drivers/local-storage-driver.ts` — **Implementación completa**

```typescript
import { StorageProvider, StorageUploadResult, PutStreamOptions } from "@/domain/interfaces/providers/storage.provider";
import { STORAGE_TOKEN } from "@/infraestructure/config/storage.config";
import { inject, injectable } from "tsyringe";
import { promises as fs } from "fs";
import { createWriteStream, createReadStream } from "fs";
import { pipeline } from "stream/promises";
import { join, dirname } from "path";
import type { Readable } from "stream";

@injectable()
export class LocalStorageDriver implements StorageProvider {
  private readonly root: string;
  private readonly publicUrl: string;

  constructor(@inject(STORAGE_TOKEN.Config) private config: any) {
    this.root      = this.config.disks.local.root;
    this.publicUrl = this.config.PUBLIC_URL || "";
  }

  private fullPath(path: string): string {
    return join(process.cwd(), this.root, path);
  }

  async put(path: string, content: Buffer | string): Promise<string> {
    const dest = this.fullPath(path);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.writeFile(dest, content);
    return path;
  }

  async putStream(
    path: string,
    stream: Readable,
    _options?: PutStreamOptions,
  ): Promise<StorageUploadResult> {
    const dest = this.fullPath(path);
    await fs.mkdir(dirname(dest), { recursive: true });
    await pipeline(stream, createWriteStream(dest));
    const stat = await fs.stat(dest);
    return {
      path,
      url:  await this.url(path),
      size: stat.size,
      mimeType: _options?.mimeType,
    };
  }

  async get(path: string): Promise<Buffer> {
    return fs.readFile(this.fullPath(path));
  }

  async getStream(path: string): Promise<Readable> {
    return createReadStream(this.fullPath(path)) as unknown as Readable;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(this.fullPath(path));
      return true;
    } catch {
      return false;
    }
  }

  async delete(path: string): Promise<void> {
    await fs.unlink(this.fullPath(path));
  }

  async url(path: string): Promise<string> {
    if (this.publicUrl) return `${this.publicUrl}/${path}`;
    return `/${this.root}/${path}`;
  }

  // Stub firmado — local no soporta signed URLs
  async getSignedUrl(path: string): Promise<string> {
    return this.url(path);
  }
}
```

### 3.4 `src/infraestructure/storage/drivers/s3-storage-driver.ts` — **Implementación completa**

```typescript
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  StorageProvider,
  StorageUploadResult,
  PutStreamOptions,
} from "@/domain/interfaces/providers/storage.provider";
import { STORAGE_TOKEN } from "@/infraestructure/config/storage.config";
import { injectable, inject } from "tsyringe";
import type { Readable } from "stream";

@injectable()
export class S3StorageDriver implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(@inject(STORAGE_TOKEN.Config) private config: any) {
    const disk = this.config.disks.s3;

    this.bucket    = disk.bucket;
    this.publicUrl = disk.publicUrl || "";

    this.client = new S3Client({
      region: disk.region,
      credentials: {
        accessKeyId:     disk.key,
        secretAccessKey: disk.secret,
      },
      // Si hay endpoint (MinIO local), lo usa — si no, apunta a AWS
      ...(disk.endpoint ? {
        endpoint:         disk.endpoint,
        forcePathStyle:   true,  // requerido por MinIO
      } : {}),
    });
  }

  async put(path: string, content: Buffer | string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key:    path,
        Body:   typeof content === "string" ? Buffer.from(content) : content,
      }),
    );
    return path;
  }

  async putStream(
    path: string,
    stream: Readable,
    options?: PutStreamOptions,
  ): Promise<StorageUploadResult> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket:      this.bucket,
        Key:         path,
        Body:        stream,
        ContentType: options?.mimeType,
        ContentLength: options?.size,
        Metadata:    options?.metadata,
      },
    });

    await upload.done();

    return {
      path,
      url:      await this.url(path),
      mimeType: options?.mimeType,
      size:     options?.size,
    };
  }

  async get(path: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: path }),
    );
    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async getStream(path: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: path }),
    );
    return response.Body as Readable;
  }

  async delete(path: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: path }),
    );
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: path }),
      );
      return true;
    } catch (err: any) {
      if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  async url(path: string): Promise<string> {
    if (this.publicUrl) return `${this.publicUrl}/${path}`;
    // Fallback: URL firmada válida 1 hora
    return this.getSignedUrl(path, 3600);
  }

  async getSignedUrl(path: string, expiresIn = 3600): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: path }),
      { expiresIn },
    );
  }
}
```

> **Nota**: `@aws-sdk/s3-request-presigner` debe añadirse a las instalaciones.  
> Comandos completos:
> ```bash
> npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner multer
> npm install --save-dev @types/multer
> ```

### 3.5 `src/infraestructure/storage/StorageManager.ts`

Sin cambios estructurales. Solo verificar que el tokenMap siga cubriendo `StorageDriver.LOCAL` y `StorageDriver.S3`. Ya cubre ambos, no hay modificaciones necesarias.

### 3.6 `src/infraestructure/storage/index.ts`

Sin cambios — ya exporta ambos drivers.

---

## Fase 4 — DI: container.ts

Localizar la sección `// STORAGE` (~línea 567) y añadir el registro del `StorageManager` como singleton:

```typescript
// STORAGE (sección ya existente — solo verificar/añadir lo siguiente)
container.register(STORAGE_TOKEN.Config, { useValue: STORAGE_ENV });
container.registerSingleton<LocalStorageDriver>(STORAGE_TOKEN.Local, LocalStorageDriver);
container.registerSingleton<S3StorageDriver>(STORAGE_TOKEN.S3, S3StorageDriver);
// Añadir StorageManager como singleton explícito (actualmente usa @singleton()
// en la clase, pero registrarlo aquí garantiza visibilidad en el contenedor)
container.registerSingleton(STORAGE_TOKEN.Manager, StorageManager);
```

> **Importante**: Importar `StorageManager` y `STORAGE_TOKEN` en `container.ts` si aún no lo están.

---

## Fase 5 — Middleware HTTP: Upload

### `src/infraestructure/http/middlewares/upload.middleware.ts`

```typescript
import multer from "multer";
import { Request, Response, NextFunction } from "express";
import { ErrorFactory } from "@/domain/exceptions/error-factory";
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZES } from "@/domain/validators/file-validators";

const ALL_ALLOWED_MIMES = [
  ...ALLOWED_MIME_TYPES.images,
  ...ALLOWED_MIME_TYPES.documents,
  // audio / video del chatbot
  "audio/ogg",
  "audio/mpeg",
  "video/mp4",
];

const storage = multer.memoryStorage();

const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  if (ALL_ALLOWED_MIMES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(`MIME type not allowed: ${file.mimetype}`) as any,
      false,
    );
  }
};

/** Multer instance — límite 50 MB por archivo, 1 archivo por request */
export const uploadSingle = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZES.default,   // 16 MB por defecto
    files: 1,
  },
}).single("file");

/**
 * Middleware Express: parsea "file" del multipart,
 * convierte errores de multer en AppError para el error handler global.
 */
export function handleFileUpload(req: Request, res: Response, next: NextFunction): void {
  uploadSingle(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return next(
        ErrorFactory.create("validation", `Upload error: ${err.message}`, { code: err.code }),
      );
    }
    if (err) {
      return next(ErrorFactory.create("validation", err.message));
    }
    next();
  });
}
```

> **Notas de seguridad (OWASP)**:
> - Límite de tamaño explícito → previene DoS por archivos masivos.
> - Whitelist de MIME types → previene RCE por archivos ejecutables.
> - `memoryStorage` → nunca escribe al filesystem sin validar primero.
> - El nombre de archivo del usuario NO se usa como path de almacenamiento — el use case genera un nombre único.

---

## Fase 6 — Application Layer: Use Case

### `src/app/use-cases/storage/upload-file.dto.ts`

```typescript
import { z } from "zod";

export const UploadFileStorageSchema = z.object({
  conversationId: z.string().uuid().optional(),
  folder: z.string().max(100).default("uploads"),
  visibility: z.enum(["public", "private"]).default("private"),
});

export type UploadFileStorageInput = z.infer<typeof UploadFileStorageSchema> & {
  file: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
  };
};

export type UploadFileStorageOutput = {
  success: boolean;
  path: string;
  url: string;
  size: number;
  mimeType: string;
};
```

### `src/app/use-cases/storage/upload-file.use-case.ts`

```typescript
import { injectable } from "tsyringe";
import { StorageManager } from "@/infraestructure/storage/StorageManager";
import { validateFile } from "@/domain/validators/file-validators";
import { ErrorFactory } from "@/domain/exceptions/error-factory";
import {
  UploadFileStorageInput,
  UploadFileStorageOutput,
  UploadFileStorageSchema,
} from "./upload-file.dto";
import { logger } from "@/app/services/logger/winston-logger.service";
import crypto from "crypto";
import path from "path";

@injectable()
export class UploadFileStorageUseCase {
  constructor(private readonly storageManager: StorageManager) {}

  async execute(input: UploadFileStorageInput): Promise<UploadFileStorageOutput> {
    // 1. Validar DTO con Zod
    const dto = UploadFileStorageSchema.parse(input);

    // 2. Validar archivo (tipo, tamaño) usando dominio
    const validation = validateFile({
      buffer:      input.file.buffer,
      fileName:    input.file.originalname,
      contentType: input.file.mimetype,
      size:        input.file.size,
    });

    if (!validation.isValid) {
      throw ErrorFactory.create("validation", validation.error!, {
        mimetype: input.file.mimetype,
        size:     input.file.size,
      });
    }

    // 3. Generar nombre único (UUID + extensión original)
    const ext      = path.extname(input.file.originalname).toLowerCase();
    const safeName = `${crypto.randomUUID()}${ext}`;
    const storagePath = `${dto.folder}/${safeName}`;

    logger.info("Uploading file to storage", {
      feature:   "file-storage",
      path:      storagePath,
      mimeType:  input.file.mimetype,
      size:      input.file.size,
    });

    // 4. Guardar vía StorageManager
    const disk = this.storageManager.disk();
    await disk.put(storagePath, input.file.buffer);
    const publicUrl = await disk.url(storagePath);

    return {
      success:  true,
      path:     storagePath,
      url:      publicUrl,
      size:     input.file.size,
      mimeType: input.file.mimetype,
    };
  }
}
```

> **Nota de inyección**: `StorageManager` no tiene token DI en `global-symbol.ts` todavía.  
> Añadir a `src/infraestructure/DI/global-symbol.ts`:
> ```typescript
> StorageManager: Symbol.for("StorageManager"),
> ```
> Y registrar en container: `container.registerSingleton(DI.StorageManager, StorageManager)`.

---

## Fase 7 — HTTP Layer: Controller + Route

### `src/infraestructure/http/controllers/storage.controller.ts`

```typescript
import { Request, Response, NextFunction } from "express";
import { container } from "@/infraestructure/DI/container";
import { UploadFileStorageUseCase } from "@/app/use-cases/storage/upload-file.use-case";
import { ResponseBuilder } from "@/domain/exceptions/response-builder";
import { SuccessFactory } from "@/domain/exceptions/success-factory";

export class StorageController {
  static async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ message: "No file provided" });
        return;
      }

      const useCase = container.resolve(UploadFileStorageUseCase);
      const result  = await useCase.execute({
        file: {
          buffer:       req.file.buffer,
          originalname: req.file.originalname,
          mimetype:     req.file.mimetype,
          size:         req.file.size,
        },
        folder:     (req.body?.folder as string) || "uploads",
        visibility: (req.body?.visibility as "public" | "private") || "private",
      });

      ResponseBuilder.sendSuccess(
        res,
        SuccessFactory.create("file-uploaded", result),
        201,
      );
    } catch (error) {
      next(error);
    }
  }
}
```

### `src/infraestructure/http/routes/storage.route.ts`

```typescript
import { Router } from "express";
import { StorageController } from "@/infraestructure/http/controllers/storage.controller";
import { AuthGuard } from "@/infraestructure/http/middlewares/auth.middleware";
import { handleFileUpload } from "@/infraestructure/http/middlewares/upload.middleware";
import { injectable } from "tsyringe";

@injectable()
export class StorageRoute {
  get routes(): Router {
    const router = Router();
    const guard  = new AuthGuard();

    /**
     * POST /api/storage/upload
     * Body: multipart/form-data
     *   - file: archivo (any MIME en whitelist)
     *   - folder?: string (default "uploads")
     *   - visibility?: "public" | "private"
     */
    router.post(
      "/upload",
      guard.validate,
      handleFileUpload,
      StorageController.upload,
    );

    return router;
  }
}
```

### `src/infraestructure/http/routes/index.ts` — Añadir registro

```typescript
// Dentro del método que registra rutas, añadir:
router.use("/storage", new StorageRoute().routes);
```

---

## Fase 8 — Stream desde Chatbot (WhatsApp / WebChat)

Para recibir archivos vía stream (no HTTP multipart) en el chatbot, el flujo es:

```
WhatsApp media URL
  → WhatsAppMediaService.downloadAsStream(mediaId) → Readable
  → StorageManager.disk().putStream(path, stream, { mimeType, size })
  → StorageUploadResult { path, url }
```

**Modificar `ProcessFileUploadUseCase`** (ya existente en `src/app/use-cases/messaging/`):

- Actualmente descarga el media como Buffer.
- Añadir alternativa: si el servicio devuelve un `Readable`, llamar `putStream` en lugar de `put`.
- El cambio es **aditivo** — no rompe el flujo existente.

```typescript
// En ProcessFileUploadUseCase, sección de descarga y guardado:

// ANTES (buffer):
const buffer = await this.whatsappMediaService.download(input.fileId);
await disk.put(storagePath, buffer);

// DESPUÉS (stream, si disponible):
const stream = await this.whatsappMediaService.downloadStream(input.fileId);
const result = await disk.putStream(storagePath, stream, { mimeType: input.mimeType });
```

> **`WhatsAppMediaService`** necesitará un nuevo método `downloadStream()` que devuelva `Readable` — esto se puede añadir en otro ticket o en esta misma implementación.

---

## Fase 9 — Tests

### `test/infraestructure/storage/local-storage-driver.test.ts`

```typescript
describe("LocalStorageDriver", () => {
  it("put: stores file and returns path");
  it("put: creates nested directories recursively");
  it("get: returns Buffer content");
  it("getStream: returns Readable stream");
  it("exists: returns true when file exists");
  it("exists: returns false when file does not exist");
  it("delete: removes file");
  it("putStream: saves stream content to disk");
  it("url: returns correct local URL");
});
```

### `test/infraestructure/storage/s3-storage-driver.test.ts`

```typescript
// Mock de @aws-sdk/client-s3 y @aws-sdk/lib-storage
describe("S3StorageDriver", () => {
  it("put: calls PutObjectCommand with correct bucket and key");
  it("putStream: uses Upload class for streaming");
  it("get: returns Buffer from stream body");
  it("getStream: returns body as Readable");
  it("exists: returns true for HeadObject success");
  it("exists: returns false for 404 NotFound");
  it("delete: calls DeleteObjectCommand");
  it("url: uses publicUrl when configured");
  it("url: falls back to signed URL when no publicUrl");
  it("constructor: sets forcePathStyle=true when endpoint is configured (MinIO mode)");
});
```

### `test/app/use-cases/storage/upload-file.use-case.test.ts`

```typescript
describe("UploadFileStorageUseCase", () => {
  it("execute: uploads valid image and returns url");
  it("execute: throws validation error for disallowed MIME type");
  it("execute: throws validation error for oversized file");
  it("execute: generates unique filename (uuid + ext)");
  it("execute: uses folder from input or defaults to 'uploads'");
});
```

---

## Variables de Entorno `.env.example`

```env
# ==============================
# STORAGE
# ==============================
# Driver activo: "local" | "s3"
STORAGE_DRIVER=local

# Local filesystem
STORAGE_LOCAL_ROOT=storage/app/public

# Base URL para servir archivos públicos
STORAGE_PUBLIC_URL=http://localhost:3000/storage

# S3 / MinIO / DigitalOcean / AWS
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
AWS_REGION=us-east-1
AWS_BUCKET=datihub
# Dejar vacío para AWS real | http://localhost:9000 para MinIO local
AWS_ENDPOINT=http://localhost:9000
```

---

## Resumen de Archivos

### Crear

| Archivo | Descripción |
|---|---|
| `docker/docker-compose.minio.yml` | MinIO container + bucket automático |
| `src/infraestructure/http/middlewares/upload.middleware.ts` | Multer + fileFilter |
| `src/infraestructure/http/controllers/storage.controller.ts` | Controller HTTP upload |
| `src/infraestructure/http/routes/storage.route.ts` | Ruta POST /storage/upload |
| `src/app/use-cases/storage/upload-file.use-case.ts` | Use case orquestador |
| `src/app/use-cases/storage/upload-file.dto.ts` | DTOs con Zod |
| `test/infraestructure/storage/local-storage-driver.test.ts` | Tests driver local |
| `test/infraestructure/storage/s3-storage-driver.test.ts` | Tests driver S3/MinIO |
| `test/app/use-cases/storage/upload-file.use-case.test.ts` | Tests use case |

### Modificar

| Archivo | Qué cambiar |
|---|---|
| `src/domain/interfaces/providers/storage.provider.ts` | Añadir `putStream`, `getStream`, `PutStreamOptions`, `StorageUploadResult` |
| `src/infraestructure/storage/drivers/local-storage-driver.ts` | Implementar todos los métodos con `fs/promises` |
| `src/infraestructure/storage/drivers/s3-storage-driver.ts` | Implementar con `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` |
| `src/infraestructure/config/storage.config.ts` | Añadir vars MinIO + campo `PUBLIC_URL` |
| `src/infraestructure/DI/container.ts` | Registrar `StorageManager` como singleton |
| `src/infraestructure/DI/global-symbol.ts` | Añadir `StorageManager` symbol |
| `src/infraestructure/http/routes/index.ts` | Montar `StorageRoute` en `/storage` |
| `src/app/use-cases/messaging/process-file-upload.use-case.ts` | Integrar `putStream` (aditivo) |

---

## Consideraciones de Seguridad (OWASP)

| Riesgo | Mitigación en este plan |
|---|---|
| Unrestricted File Upload (A01) | Whitelist MIME + extensión, límite de tamaño en multer |
| Path Traversal (A01) | El path se construye con UUID, nunca con el nombre original del usuario |
| DoS por archivos gigantes | `limits.fileSize` en multer (configurable, default 16 MB) |
| Exposición de archivos privados | `url()` devuelve signed URL para archivos privados (S3) |
| IDOR en URLs de archivos | Archivos privados solo accesibles vía signed URL (TTL 1 hora) |

---

## Notas Finales para el Implementador

1. **Orden de implementación recomendado**: Fase 3 (drivers) → Fase 2 (interfaz) → Fase 6 (use case) → Fase 5 (middleware) → Fase 7 (routes) → Fase 4 (DI) → Fase 1 (docker) → Fase 9 (tests).

2. **`SuccessFactory.create('file-uploaded', result)`** — verificar que `'file-uploaded'` esté en el catálogo de success codes del dominio. Si no existe, añadirlo.

3. **`ResponseBuilder.sendSuccess(res, ..., 201)`** — verificar que `ResponseBuilder` acepta un tercer parámetro de status code. Si no, usar `res.status(201).json(...)` directamente.

4. **`AuthGuard`** — verificar el nombre exacto de la clase en `src/infraestructure/http/middlewares/`. El plan asume que existe un guard que valida JWT.

5. **`ErrorFactory.create("validation", ...)`** — verificar que `"validation"` es un código válido para el `ErrorFactory` existente.

6. **Streams en WhatsApp**: `WhatsAppMediaService.downloadStream()` no existe — si se quiere este feature en el mismo PR, agregarlo como método adicional en dicho servicio. De lo contrario, diferirlo.
