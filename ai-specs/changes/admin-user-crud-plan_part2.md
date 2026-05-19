# Plan de Implementación: User Admin CRUD — Parte 2

**Scope:** Infrastructure layer (Repository, Schema, Controller, Routes, DI) + Postman testing

---

## PASO 4 — Infrastructure: Repository

### 4.1 Actualizar `src/infraestructure/database/persistences/repositories/user.prisma.repository.ts`

Reemplazar contenido completo:

```typescript
import { injectable } from "tsyringe";
import { UserRepository } from "@/domain/repositories";
import { UserEntity } from "@/domain/entities/user.entity";
import {
  Pagination,
  PaginationOption,
} from "@/shared/value-objects/pagination.vo";
import { PrismaRepositoryBase } from "../../facades/base-repository";
import { UserPersistenceMapper } from "../mapper/user.mapper";

@injectable()
export class PrismaUserRepository
  extends PrismaRepositoryBase
  implements UserRepository
{
  async create(user: UserEntity): Promise<UserEntity> {
    const persistence = UserPersistenceMapper.toPersistence(user);

    const record = await this.executeSafe(async () => {
      return await this.prisma.user.create({
        data: persistence,
      });
    });

    return UserPersistenceMapper.toDomain(record);
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    const record = await this.executeSafe(async () => {
      return await this.prisma.user.findUnique({ where: { email } });
    });

    return record ? UserPersistenceMapper.toDomain(record) : null;
  }

  async findById(id: string): Promise<UserEntity | null> {
    const record = await this.executeSafe(async () => {
      return await this.prisma.user.findUnique({ where: { id } });
    });

    return record ? UserPersistenceMapper.toDomain(record) : null;
  }

  async findAll(opt: PaginationOption): Promise<Pagination<UserEntity>> {
    const [records, count] = await this.executeSafe(() =>
      this.prisma.$transaction([
        this.prisma.user.findMany({
          skip: opt.offSet(),
          take: opt.pageSize,
          orderBy: { createdAt: "desc" },
        }),
        this.prisma.user.count(),
      ]),
    );

    const list = records.map((r) => UserPersistenceMapper.toDomain(r));
    return Pagination.create<UserEntity>(list, opt, count);
  }

  async update(user: UserEntity): Promise<UserEntity> {
    const persistence = UserPersistenceMapper.toPersistence(user);

    const record = await this.executeSafe(async () => {
      return await this.prisma.user.update({
        where: { id: persistence.id },
        data: {
          name: persistence.name,
          role: persistence.role,
          password: persistence.password,
          updatedAt: persistence.updatedAt,
        },
      });
    });

    return UserPersistenceMapper.toDomain(record);
  }

  async delete(id: string): Promise<boolean> {
    await this.executeSafe(async () => {
      return await this.prisma.user.delete({ where: { id } });
    });
    return true;
  }
}
```

> **Commit:** `feat(users): implement findAll, update and delete in PrismaUserRepository`

---

## PASO 5 — Infrastructure: Zod Schema

### 5.1 Crear `src/infraestructure/http/controllers/schemas/user.schema.ts`

```typescript
import { z } from "zod";
import { UserRole } from "@/domain/value-objects";
import { registry } from "@/shared/swagger/openapi-registry";

export const UpdateUserBodySchema = z
  .object({
    name: z
      .string()
      .min(2, "Nombre debe tener al menos 2 caracteres")
      .max(50, "Nombre demasiado largo")
      .transform((n) => n.trim())
      .optional(),
    role: z.nativeEnum(UserRole).optional(),
  })
  .strict()
  .refine((data) => data.name !== undefined || data.role !== undefined, {
    message: "Se requiere al menos un campo para actualizar (name o role)",
  })
  .openapi("UpdateUserBody");

export const ChangePasswordBodySchema = z
  .object({
    newPassword: z
      .string()
      .min(8, "La contraseña debe tener al menos 8 caracteres")
      .max(100, "Contraseña demasiado larga"),
  })
  .strict()
  .openapi("ChangePasswordBody");

export const UserResponseSchema = z
  .object({
    id: z
      .string()
      .uuid()
      .openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
    email: z.string().email().openapi({ example: "admin@datihub.com" }),
    name: z.string().openapi({ example: "Admin User" }),
    role: z.string().openapi({ example: "ADMIN" }),
    createdAt: z.string().openapi({ example: "2026-05-13T10:00:00.000Z" }),
    updatedAt: z.string().openapi({ example: "2026-05-13T10:00:00.000Z" }),
  })
  .openapi("UserResponse");

registry.register("UpdateUserBody", UpdateUserBodySchema);
registry.register("ChangePasswordBody", ChangePasswordBodySchema);
registry.register("UserResponse", UserResponseSchema);
```

### 5.2 Actualizar `src/infraestructure/http/controllers/schemas/index.ts`

Agregar al final:
```typescript
export * from "./user.schema";
```

> **Commit:** `feat(users): add Zod schemas for user admin management`

---

## PASO 6 — Infrastructure: Controller

### 6.1 Crear `src/infraestructure/http/controllers/user/user-admin.controller.ts`

```typescript
import { DI } from "@/infraestructure/DI/global-symbol";
import { inject, injectable } from "tsyringe";
import { Response } from "express";
import { ICommandBus, IQueryBus } from "@/domain/interfaces/ports";
import {
  GetAllUsersQuery,
  GetUserByIdAdminQuery,
} from "@/app/queries/user";
import {
  UpdateUserCommand,
  ChangePasswordCommand,
  DeleteUserCommand,
} from "@/app/commands/user";
import {
  AuthenticatedRequest,
  ResponseBuilder,
} from "@/infraestructure/http/middlewares";
import { SuccessFactory } from "@/domain/exceptions";
import {
  PaginationQuerySchema,
  UUIDDQuerySchema,
} from "../schemas/common.schema";
import {
  UpdateUserBodySchema,
  ChangePasswordBodySchema,
} from "../schemas/user.schema";

@injectable()
export class UserAdminController {
  constructor(
    @inject(DI.QueryBus) private queryBus: IQueryBus,
    @inject(DI.CommandBus) private commandBus: ICommandBus,
  ) {}

  listUsers = async (req: AuthenticatedRequest, res: Response) => {
    const { query } = PaginationQuerySchema.parse({ query: req.query });
    const result = await this.queryBus.query(new GetAllUsersQuery(query));
    ResponseBuilder.sendSuccess(
      res,
      SuccessFactory.create("retrieved", result),
    );
  };

  getUserById = async (req: AuthenticatedRequest, res: Response) => {
    const { params } = UUIDDQuerySchema.parse({ params: req.params });
    const user = await this.queryBus.query(
      new GetUserByIdAdminQuery(params.id),
    );
    ResponseBuilder.sendSuccess(
      res,
      SuccessFactory.create("retrieved", user),
    );
  };

  updateUser = async (req: AuthenticatedRequest, res: Response) => {
    const { params } = UUIDDQuerySchema.parse({ params: req.params });
    const body = UpdateUserBodySchema.parse(req.body);
    const result = await this.commandBus.dispatch(
      new UpdateUserCommand(params.id, body.name, body.role),
    );
    ResponseBuilder.sendSuccess(
      res,
      SuccessFactory.create("updated", result),
    );
  };

  changePassword = async (req: AuthenticatedRequest, res: Response) => {
    const { params } = UUIDDQuerySchema.parse({ params: req.params });
    const body = ChangePasswordBodySchema.parse(req.body);
    await this.commandBus.dispatch(
      new ChangePasswordCommand(
        params.id,
        req.user!.userId!,
        req.user!.role!,
        body.newPassword,
      ),
    );
    ResponseBuilder.sendSuccess(
      res,
      SuccessFactory.create("success", "Contraseña actualizada."),
    );
  };

  deleteUser = async (req: AuthenticatedRequest, res: Response) => {
    const { params } = UUIDDQuerySchema.parse({ params: req.params });
    await this.commandBus.dispatch(
      new DeleteUserCommand(params.id, req.user!.userId!),
    );
    ResponseBuilder.sendSuccess(
      res,
      SuccessFactory.create("deleted", `Usuario ${params.id} eliminado.`),
    );
  };
}
```

### 6.2 Actualizar `src/infraestructure/http/controllers/user/index.ts`

```typescript
export * from "./auth.controller";
export * from "./upload-users.controller";
export * from "./user.controller";
export * from "./user-admin.controller";
export * from "../schemas/auth.schema";
```

### 6.3 Actualizar `src/infraestructure/http/controllers/index.ts`

Agregar al final:
```typescript
export * from "./user/user-admin.controller";
export * from "./schemas/user.schema";
```

> **Commit:** `feat(users): add UserAdminController for admin CRUD`

---

## PASO 7 — Infrastructure: Routes

### 7.1 Crear `src/infraestructure/http/routes/user/user-admin.routes.ts`

```typescript
import { Router } from "express";
import { DI } from "@/infraestructure/DI/global-symbol";
import { container } from "@/infraestructure/DI/container";
import { UserRole } from "@/domain/value-objects";
import { UserAdminController } from "@/infraestructure/http/controllers/user/user-admin.controller";
import { AuthGuard } from "@/infraestructure/http/middlewares";
import { documentRoute } from "@/shared/swagger/swagger.helper";
import { UUIDParamsSchema } from "../../controllers/schemas/common.schema";
import {
  UpdateUserBodySchema,
  ChangePasswordBodySchema,
  UserResponseSchema,
} from "../../controllers/schemas/user.schema";

export class UserAdminRoute {
  private readonly controller: UserAdminController;
  private readonly guard: AuthGuard;

  constructor() {
    this.controller = container.resolve<UserAdminController>(
      DI.UserAdminController,
    );
    this.guard = container.resolve<AuthGuard>(DI.AuthGuard);
  }

  get routes(): Router {
    const router = Router();
    const adminGuard = [
      this.guard.validate,
      this.guard.authorizeRoles([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    ];

    documentRoute({
      path: "/users",
      method: "get",
      tag: "Users",
      summary: "Listar usuarios paginados (admin)",
      hasAuth: true,
      response: UserResponseSchema.array(),
    });
    router.get("/", ...adminGuard, this.controller.listUsers);

    documentRoute({
      path: "/users/{id}",
      method: "get",
      tag: "Users",
      summary: "Obtener usuario por ID (admin)",
      params: UUIDParamsSchema,
      hasAuth: true,
      response: UserResponseSchema,
      errors: ["not-found"],
    });
    router.get("/:id", ...adminGuard, this.controller.getUserById);

    documentRoute({
      path: "/users/{id}",
      method: "patch",
      tag: "Users",
      summary: "Actualizar nombre o rol del usuario (admin)",
      body: UpdateUserBodySchema,
      params: UUIDParamsSchema,
      hasAuth: true,
      response: UserResponseSchema,
      errors: ["bad-request", "not-found", "validation"],
    });
    router.patch("/:id", ...adminGuard, this.controller.updateUser);

    documentRoute({
      path: "/users/{id}/password",
      method: "patch",
      tag: "Users",
      summary: "Cambiar contraseña (admin o propio usuario)",
      body: ChangePasswordBodySchema,
      params: UUIDParamsSchema,
      hasAuth: true,
      errors: ["bad-request", "not-found", "forbidden"],
    });
    router.patch(
      "/:id/password",
      this.guard.validate,
      this.controller.changePassword,
    );

    documentRoute({
      path: "/users/{id}",
      method: "delete",
      tag: "Users",
      summary: "Eliminar usuario (admin)",
      params: UUIDParamsSchema,
      hasAuth: true,
      errors: ["bad-request", "not-found"],
    });
    router.delete("/:id", ...adminGuard, this.controller.deleteUser);

    return router;
  }
}
```

### 7.2 Actualizar `src/infraestructure/http/routes/index.ts`

Agregar import y ruta (después de la línea de UploadUserRoute):

```typescript
import { UserAdminRoute } from "./user/user-admin.routes";

// Dentro de AppRoute.routes, DESPUÉS de la línea:
// router.use("/users", new UploadUserRoute().routes);
// Agregar:
router.use("/users", new UserAdminRoute().routes);
```

> Express resuelve en orden: `POST /users/upload` → UploadUserRoute, el resto → UserAdminRoute

> **Commit:** `feat(users): add UserAdminRoute and register in routes index`

---

## PASO 8 — DI: Symbols + Module

### 8.1 Actualizar `src/infraestructure/DI/global-symbol.ts`

En el bloque `// ── Auth ──`, agregar:

```typescript
UserAdminController: Symbol.for("UserAdminController"),
```

### 8.2 Actualizar `src/infraestructure/DI/modules/auth.module.ts`

Agregar imports y registros:

```typescript
// Agregar imports
import {
  UpdateUserCommandHandler,
  ChangePasswordCommandHandler,
  DeleteUserCommandHandler,
} from "@/app/commands/user";
import {
  GetAllUsersQueryHandler,
  GetUserByIdAdminQueryHandler,
} from "@/app/queries/user";
import { UserAdminController } from "@/infraestructure/http/controllers/user/user-admin.controller";

// Dentro de registerAuthModule(), agregar:

// Controller
container.register(DI.UserAdminController, UserAdminController);

// Command Handlers
container.register("UpdateUserCommandHandler", UpdateUserCommandHandler);
container.register("ChangePasswordCommandHandler", ChangePasswordCommandHandler);
container.register("DeleteUserCommandHandler", DeleteUserCommandHandler);

// Query Handlers
container.register("GetAllUsersQueryHandler", GetAllUsersQueryHandler);
container.register("GetUserByIdAdminQueryHandler", GetUserByIdAdminQueryHandler);
```

> **Commit:** `feat(users): register user admin handlers and controller in DI container`

---

## Checklist de validación

- [ ] `Pagination<T>` + `PaginationOption` (no PaginationResult)
- [ ] Queries usan `IQuery<T>` con `declare readonly _resultType`
- [ ] Commands usan `ICommand<T>` con `declare readonly _resultType`
- [ ] Repository usa `executeSafe` + `$transaction` en `findAll`
- [ ] Handlers inyectan interfaces (`@inject(DI.UserRepository)`)
- [ ] No se usa `new Error()` — solo `ErrorFactory`
- [ ] Controller usa `ResponseBuilder.sendSuccess`, nunca `res.json()`
- [ ] Controller valida params con `UUIDDQuerySchema.parse()`
- [ ] No se puede eliminar el propio usuario (guardia en handler)
- [ ] `PATCH /users/:id/password` valida permisos en handler (self o admin)
- [ ] `req.user.role` ya existe en `AuthPayload` ✅ (verificado)
- [ ] Zod schemas registrados en OpenAPI registry

---

## Commits sugeridos (orden)

```
feat(users): add changeRole and changePassword methods to UserEntity
feat(users): expand UserRepository interface with findAll and update
feat(users): add GetAllUsers and GetUserByIdAdmin queries
feat(users): add UpdateUser, ChangePassword and DeleteUser commands
feat(users): implement findAll, update and delete in PrismaUserRepository
feat(users): add Zod schemas for user admin management
feat(users): add UserAdminController for admin CRUD
feat(users): add UserAdminRoute and register in routes index
feat(users): register user admin handlers and controller in DI container
```

---

## Verificación con Postman

### Prerequisitos

1. Servidor corriendo: `npm run dev`
2. Base URL: `http://localhost:3000/api` (ajustar puerto según `.env`)
3. Tener un usuario ADMIN registrado y logueado

### Paso 0: Login para obtener token

```
POST {{baseUrl}}/auth/login
Content-Type: application/json

{
  "email": "admin@datihub.com",
  "password": "tu_password_admin"
}
```

Copiar el `token` de la respuesta → guardar en variable `{{token}}` de Postman.

### Paso 1: GET /users — Listar usuarios

```
GET {{baseUrl}}/users?page=1&pageSize=10
Authorization: Bearer {{token}}
```

**Respuesta esperada (200):**
```json
{
  "success": true,
  "statusCode": 200,
  "message": "...",
  "data": {
    "data": [
      {
        "id": "uuid",
        "email": "admin@datihub.com",
        "name": "Admin",
        "role": "ADMIN",
        "createdAt": "...",
        "updatedAt": "..."
      }
    ],
    "totalPages": 1,
    "currentPage": 1,
    "prevPage": false,
    "nextPage": false
  }
}
```

### Paso 2: GET /users/:id — Obtener por ID

```
GET {{baseUrl}}/users/{{userId}}
Authorization: Bearer {{token}}
```

**Respuesta esperada (200):** Objeto `UserResponseDTO`.

**Test error (404):** Usar un UUID inexistente.

### Paso 3: PATCH /users/:id — Actualizar usuario

```
PATCH {{baseUrl}}/users/{{userId}}
Authorization: Bearer {{token}}
Content-Type: application/json

{
  "name": "Nuevo Nombre",
  "role": "OPERATOR"
}
```

**Respuesta esperada (200):** Usuario actualizado.

**Test validación:** Enviar body vacío `{}` → debe retornar error de validación.

### Paso 4: PATCH /users/:id/password — Cambiar contraseña

```
PATCH {{baseUrl}}/users/{{userId}}/password
Authorization: Bearer {{token}}
Content-Type: application/json

{
  "newPassword": "NuevaPassword123"
}
```

**Respuesta esperada (200):** `"Contraseña actualizada."`

**Tests adicionales:**
- Password < 8 chars → error validación Zod
- ID de otro usuario siendo OPERATOR → error 403 forbidden

### Paso 5: DELETE /users/:id — Eliminar usuario

> ⚠️ Crear primero un usuario de prueba via `POST /auth/register`

```
DELETE {{baseUrl}}/users/{{testUserId}}
Authorization: Bearer {{token}}
```

**Respuesta esperada (200):** `"Usuario {id} eliminado."`

**Tests adicionales:**
- Intentar eliminar tu propio ID → error 400
- UUID inexistente → error 404
- Sin token → error 401
- Token de OPERATOR → error 403

### Resumen de códigos HTTP esperados

| Endpoint | 200 | 400 | 401 | 403 | 404 |
|----------|-----|-----|-----|-----|-----|
| GET /users | ✅ listado | - | sin token | no admin | - |
| GET /users/:id | ✅ usuario | - | sin token | no admin | id invalido |
| PATCH /users/:id | ✅ actualizado | body vacío | sin token | no admin | id invalido |
| PATCH /users/:id/password | ✅ ok | pass corto | sin token | otro user no admin | id invalido |
| DELETE /users/:id | ✅ eliminado | self-delete | sin token | no admin | id invalido |
