# Plan de Implementación: Gestión de Usuarios Admin

**Fecha:** Abril 2026  
**Scope:** CRUD completo de usuarios admin (listar, obtener por ID, actualizar, eliminar, cambiar contraseña)  
**Nota:** `POST /auth/refresh` ya está implementado y funciona. No requiere cambios.

---

## Resumen de lo que FALTA

| Endpoint | Estado |
|---|---|
| `POST /auth/refresh` | ✅ Ya implementado |
| `GET /users` | ❌ Falta |
| `GET /users/:id` | ❌ Falta |
| `PUT /users/:id` | ❌ Falta |
| `PATCH /users/:id/password` | ❌ Falta |
| `DELETE /users/:id` | ❌ Falta |

Todos los endpoints `/users/*` son **ADMIN only** (excepto `PATCH /users/:id/password` que también permite al propio usuario cambiar su contraseña).

---

## Capas afectadas

```
Domain      →  user.entity.ts, user.repository.ts
App         →  queries/user/*, commands/user/*
Infra DB    →  user.prisma.repository.ts
Infra HTTP  →  controllers/user/user-admin.controller.ts
             →  controllers/schemas/user.schema.ts (nuevo)
             →  routes/user/user-admin.routes.ts (nuevo)
DI          →  global-symbol.ts, modules/auth.module.ts
Routes      →  routes/index.ts
```

---

## PASO 1 — Domain Layer

### 1.1 `src/domain/entities/user.entity.ts`

Agregar dos métodos de mutación al final de la clase `UserEntity`:

```typescript
public changeRole(newRole: string): void {
  this.props.role = Role.create(newRole);
  this.updateTimestamp();
}

public changePassword(newHashedPassword: string): void {
  this.props.password = newHashedPassword;
  this.updateTimestamp();
}
```

`changeName()` ya existe. Sin cambios adicionales.

### 1.2 `src/domain/repositories/user.repository.ts`

Reemplazar la interfaz existente por:

```typescript
import { UserEntity } from "@/domain/entities/user.entity";
import { PaginationResult } from "@/domain/interfaces/types/pagination-result.type";

export interface UserRepository {
  create(user: UserEntity): Promise<UserEntity>;
  findByEmail(email: string): Promise<UserEntity | null>;
  findById(id: string): Promise<UserEntity | null>;
  findAll(page: number, pageSize: number): Promise<PaginationResult<UserEntity>>;
  update(user: UserEntity): Promise<UserEntity>;
  delete(id: string): Promise<boolean>;
}
```

> **Nota:** Verificar si `PaginationResult<T>` ya existe en `src/domain/interfaces/types/`. Si no, crearlo:
> ```typescript
> export interface PaginationResult<T> {
>   data: T[];
>   total: number;
>   page: number;
>   pageSize: number;
> }
> ```

---

## PASO 2 — Application Layer (Queries)

### 2.1 `src/app/queries/user/get-all-users.query.ts`

```typescript
export class GetAllUsersQuery {
  constructor(
    public readonly page: number,
    public readonly pageSize: number,
  ) {}
}
```

### 2.2 `src/app/queries/user/get-all-users.handler.ts`

```typescript
import { injectable, inject } from "tsyringe";
import { DI } from "@/infraestructure/DI/global-symbol";
import { IQueryHandler } from "@/domain/interfaces/ports";
import { UserRepository } from "@/domain/repositories";
import { UserResponseMapper } from "@/app/commands/user/mapper/user-response.mapper";
import { GetAllUsersQuery } from "./get-all-users.query";
import { UserResponseDTO } from "@/domain/dtos/user.dto";
import { PaginationResult } from "@/domain/interfaces/types/pagination-result.type";

@injectable()
export class GetAllUsersQueryHandler implements IQueryHandler<
  GetAllUsersQuery,
  PaginationResult<UserResponseDTO>
> {
  constructor(
    @inject(DI.UserRepository) private userRepository: UserRepository,
  ) {}

  async handle(query: GetAllUsersQuery): Promise<PaginationResult<UserResponseDTO>> {
    const result = await this.userRepository.findAll(query.page, query.pageSize);
    return {
      data: result.data.map(u => UserResponseMapper.toAccessResponse(u)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }
}
```

### 2.3 `src/app/queries/user/get-user-by-id-admin.query.ts`

```typescript
export class GetUserByIdAdminQuery {
  constructor(public readonly userId: string) {}
}
```

### 2.4 `src/app/queries/user/get-user-by-id-admin.handler.ts`

```typescript
import { injectable, inject } from "tsyringe";
import { DI } from "@/infraestructure/DI/global-symbol";
import { IQueryHandler } from "@/domain/interfaces/ports";
import { UserRepository } from "@/domain/repositories";
import { ErrorFactory } from "@/domain/exceptions/factory/error-factory.exeption";
import { UserResponseMapper } from "@/app/commands/user/mapper/user-response.mapper";
import { GetUserByIdAdminQuery } from "./get-user-by-id-admin.query";
import { UserResponseDTO } from "@/domain/dtos/user.dto";

@injectable()
export class GetUserByIdAdminQueryHandler implements IQueryHandler<
  GetUserByIdAdminQuery,
  UserResponseDTO
> {
  constructor(
    @inject(DI.UserRepository) private userRepository: UserRepository,
  ) {}

  async handle(query: GetUserByIdAdminQuery): Promise<UserResponseDTO> {
    const user = await this.userRepository.findById(query.userId);
    if (!user) {
      ErrorFactory.throwError("not-found", "Usuario no encontrado.");
    }
    return UserResponseMapper.toAccessResponse(user);
  }
}
```

### 2.5 Actualizar `src/app/queries/user/index.ts`

Agregar exports:
```typescript
export * from "./get-all-users.query";
export * from "./get-all-users.handler";
export * from "./get-user-by-id-admin.query";
export * from "./get-user-by-id-admin.handler";
```

---

## PASO 3 — Application Layer (Commands)

### 3.1 `src/app/commands/user/update-user.command.ts`

```typescript
export class UpdateUserCommand {
  constructor(
    public readonly targetUserId: string,
    public readonly name?: string,
    public readonly role?: string,
  ) {}
}
```

### 3.2 `src/app/commands/user/update-user.handler.ts`

```typescript
import { injectable, inject } from "tsyringe";
import { DI } from "@/infraestructure/DI/global-symbol";
import { ICommandHandler } from "@/domain/interfaces/ports";
import { UserRepository } from "@/domain/repositories";
import { ErrorFactory } from "@/domain/exceptions/factory/error-factory.exeption";
import { UserResponseMapper } from "./mapper/user-response.mapper";
import { UpdateUserCommand } from "./update-user.command";
import { UserResponseDTO } from "@/domain/dtos/user.dto";

@injectable()
export class UpdateUserCommandHandler implements ICommandHandler<
  UpdateUserCommand,
  UserResponseDTO
> {
  constructor(
    @inject(DI.UserRepository) private userRepository: UserRepository,
  ) {}

  async handle(command: UpdateUserCommand): Promise<UserResponseDTO> {
    const user = await this.userRepository.findById(command.targetUserId);
    if (!user) {
      ErrorFactory.throwError("not-found", "Usuario no encontrado.");
    }

    if (command.name) user.changeName(command.name);
    if (command.role) user.changeRole(command.role);

    const updated = await this.userRepository.update(user);
    return UserResponseMapper.toAccessResponse(updated);
  }
}
```

### 3.3 `src/app/commands/user/change-password.command.ts`

```typescript
export class ChangePasswordCommand {
  constructor(
    public readonly targetUserId: string,
    public readonly requestingUserId: string,
    public readonly requestingRole: string,
    public readonly newPassword: string,
  ) {}
}
```

### 3.4 `src/app/commands/user/change-password.handler.ts`

```typescript
import { injectable, inject } from "tsyringe";
import { DI } from "@/infraestructure/DI/global-symbol";
import { ICommandHandler } from "@/domain/interfaces/ports";
import { UserRepository } from "@/domain/repositories";
import { PasswordService } from "@/domain/services/password.service";
import { ErrorFactory } from "@/domain/exceptions/factory/error-factory.exeption";
import { UserRole } from "@/domain/value-objects";
import { ChangePasswordCommand } from "./change-password.command";

@injectable()
export class ChangePasswordCommandHandler implements ICommandHandler<
  ChangePasswordCommand,
  void
> {
  constructor(
    @inject(DI.UserRepository) private userRepository: UserRepository,
    @inject(DI.PasswordService) private passwordService: PasswordService,
  ) {}

  async handle(command: ChangePasswordCommand): Promise<void> {
    // Solo ADMIN puede cambiar la contraseña de otro usuario
    const isSelf = command.targetUserId === command.requestingUserId;
    const isAdmin = command.requestingRole === UserRole.ADMIN || command.requestingRole === UserRole.SUPER_ADMIN;

    if (!isSelf && !isAdmin) {
      ErrorFactory.throwError("forbidden", "No tienes permisos para cambiar esta contraseña.");
    }

    const user = await this.userRepository.findById(command.targetUserId);
    if (!user) {
      ErrorFactory.throwError("not-found", "Usuario no encontrado.");
    }

    const hashed = this.passwordService.createPassword(command.newPassword);
    user.changePassword(hashed.value);
    await this.userRepository.update(user);
  }
}
```

### 3.5 `src/app/commands/user/delete-user.command.ts`

```typescript
export class DeleteUserCommand {
  constructor(
    public readonly targetUserId: string,
    public readonly requestingUserId: string,
  ) {}
}
```

### 3.6 `src/app/commands/user/delete-user.handler.ts`

```typescript
import { injectable, inject } from "tsyringe";
import { DI } from "@/infraestructure/DI/global-symbol";
import { ICommandHandler } from "@/domain/interfaces/ports";
import { UserRepository } from "@/domain/repositories";
import { ErrorFactory } from "@/domain/exceptions/factory/error-factory.exeption";
import { DeleteUserCommand } from "./delete-user.command";

@injectable()
export class DeleteUserCommandHandler implements ICommandHandler<
  DeleteUserCommand,
  void
> {
  constructor(
    @inject(DI.UserRepository) private userRepository: UserRepository,
  ) {}

  async handle(command: DeleteUserCommand): Promise<void> {
    if (command.targetUserId === command.requestingUserId) {
      ErrorFactory.throwError("bad-request", "No puedes eliminar tu propia cuenta.");
    }

    const user = await this.userRepository.findById(command.targetUserId);
    if (!user) {
      ErrorFactory.throwError("not-found", "Usuario no encontrado.");
    }

    await this.userRepository.delete(command.targetUserId);
  }
}
```

### 3.7 Actualizar `src/app/commands/user/index.ts`

Agregar exports:
```typescript
export * from "./update-user.command";
export * from "./update-user.handler";
export * from "./change-password.command";
export * from "./change-password.handler";
export * from "./delete-user.command";
export * from "./delete-user.handler";
```

---

## PASO 4 — Infrastructure: Repository

### 4.1 `src/infraestructure/database/persistences/repositories/user.prisma.repository.ts`

Implementar los tres métodos que actualmente lanzan `"dont aplicated"` y agregar `findAll`:

```typescript
async findAll(page: number, pageSize: number): Promise<PaginationResult<UserEntity>> {
  const skip = (page - 1) * pageSize;

  const [records, total] = await this.executeSafe(async () => {
    return await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.user.count(),
    ]);
  });

  return {
    data: records.map(r => UserPersistenceMapper.toDomain(r)),
    total,
    page,
    pageSize,
  };
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
```

> **⚠️ Importante:** `executeSafe` en el `findAll` recibe una función que retorna `Promise.all(...)`.  
> Verificar que `executeSafe` soporte el tipo `Promise<[User[], number]>`. Si el tipo no se infiere correctamente, puede ser necesario tipar explícitamente:
> ```typescript
> const [records, total] = await this.executeSafe<[User[], number]>(async () => Promise.all([...]))
> ```

---

## PASO 5 — Infrastructure: Schema Zod

### 5.1 Crear `src/infraestructure/http/controllers/schemas/user.schema.ts`

```typescript
import { z } from "zod";
import { UserRole } from "@/domain/value-objects";

export const UpdateUserSchema = z.object({
  body: z.object({
    name: z
      .string()
      .min(2, "Nombre debe tener al menos 2 caracteres")
      .max(50, "Nombre demasiado largo")
      .transform(n => n.trim())
      .optional(),
    role: z
      .nativeEnum(UserRole)
      .optional(),
  }).strict().refine(
    data => data.name !== undefined || data.role !== undefined,
    { message: "Se requiere al menos un campo para actualizar (name o role)" },
  ),
});

export const ChangePasswordSchema = z.object({
  body: z.object({
    newPassword: z
      .string()
      .min(8, "La contraseña debe tener al menos 8 caracteres")
      .max(100, "Contraseña demasiado larga"),
  }).strict(),
});

export const PaginationQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
  }),
});
```

### 5.2 Actualizar `src/infraestructure/http/controllers/schemas/index.ts`

Agregar export:
```typescript
export * from "./user.schema";
```

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
import { AuthenticatedRequest } from "@/infraestructure/http/middlewares";
import {
  UpdateUserSchema,
  ChangePasswordSchema,
  PaginationQuerySchema,
} from "../schemas/user.schema";
import { SuccessFactory } from "@/domain/exceptions";
import { ResponseBuilder } from "@/infraestructure/http/middlewares/response-builder";

@injectable()
export class UserAdminController {
  constructor(
    @inject(DI.QueryBus) private queryBus: IQueryBus,
    @inject(DI.CommandBus) private commandBus: ICommandBus,
  ) {}

  listUsers = async (req: AuthenticatedRequest, res: Response) => {
    const { query } = PaginationQuerySchema.parse({ query: req.query });

    const result = await this.queryBus.query(
      new GetAllUsersQuery(query.page, query.pageSize),
    );

    ResponseBuilder.sendSuccess(res, SuccessFactory.create("processed", result));
  };

  getUserById = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;

    const user = await this.queryBus.query(new GetUserByIdAdminQuery(id));

    ResponseBuilder.sendSuccess(res, SuccessFactory.create("executed", user));
  };

  updateUser = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const { body } = UpdateUserSchema.parse({ body: req.body });

    const result = await this.commandBus.dispatch(
      new UpdateUserCommand(id, body.name, body.role),
    );

    ResponseBuilder.sendSuccess(res, SuccessFactory.create("updated", result));
  };

  changePassword = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const { body } = ChangePasswordSchema.parse({ body: req.body });

    await this.commandBus.dispatch(
      new ChangePasswordCommand(
        id,
        req.user!.userId,
        req.user!.role,
        body.newPassword,
      ),
    );

    ResponseBuilder.sendSuccess(
      res,
      SuccessFactory.create("success", "Contraseña actualizada."),
    );
  };

  deleteUser = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;

    await this.commandBus.dispatch(
      new DeleteUserCommand(id, req.user!.userId),
    );

    ResponseBuilder.sendSuccess(
      res,
      SuccessFactory.create("deleted", `Usuario ${id} eliminado.`),
    );
  };
}
```

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

export class UserAdminRoute {
  private readonly controller: UserAdminController;
  private readonly guard: AuthGuard;

  constructor() {
    this.controller = container.resolve<UserAdminController>(DI.UserAdminController);
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
      summary: "Listar usuarios (admin)",
      hasAuth: true,
    });
    router.get("/", ...adminGuard, this.controller.listUsers);

    documentRoute({
      path: "/users/{id}",
      method: "get",
      tag: "Users",
      summary: "Obtener usuario por ID (admin)",
      hasAuth: true,
    });
    router.get("/:id", ...adminGuard, this.controller.getUserById);

    documentRoute({
      path: "/users/{id}",
      method: "put",
      tag: "Users",
      summary: "Actualizar nombre o rol del usuario (admin)",
      hasAuth: true,
    });
    router.put("/:id", ...adminGuard, this.controller.updateUser);

    documentRoute({
      path: "/users/{id}/password",
      method: "patch",
      tag: "Users",
      summary: "Cambiar contraseña (admin o propio usuario)",
      hasAuth: true,
    });
    // Este endpoint no requiere ser admin — el handler controla el acceso a nivel de negocio
    router.patch("/:id/password", this.guard.validate, this.controller.changePassword);

    documentRoute({
      path: "/users/{id}",
      method: "delete",
      tag: "Users",
      summary: "Eliminar usuario (admin)",
      hasAuth: true,
    });
    router.delete("/:id", ...adminGuard, this.controller.deleteUser);

    return router;
  }
}
```

---

## PASO 8 — DI: global-symbol + auth.module

### 8.1 `src/infraestructure/DI/global-symbol.ts`

En el bloque `// ── Auth ──`, agregar:

```typescript
UserAdminController: Symbol.for("UserAdminController"),
```

Y al final del bloque de Query handlers de auth (o donde corresponda, cerca de `GetProfileQueryHandler`):
```typescript
GetAllUsersQueryHandler: Symbol.for("GetAllUsersQueryHandler"),
GetUserByIdAdminQueryHandler: Symbol.for("GetUserByIdAdminQueryHandler"),
UpdateUserCommandHandler: Symbol.for("UpdateUserCommandHandler"),
ChangePasswordCommandHandler: Symbol.for("ChangePasswordCommandHandler"),
DeleteUserCommandHandler: Symbol.for("DeleteUserCommandHandler"),
```

> Los handlers se registran con su nombre en string en el CommandBus/QueryBus, por lo que los Symbols opcionales en DI son solo para consistencia. Observar el patrón de los demás handlers en el módulo.

### 8.2 `src/infraestructure/DI/modules/auth.module.ts`

Agregar imports y registros:

```typescript
// Imports
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

// Dentro de registerAuthModule():
container.register(DI.UserAdminController, UserAdminController);

// Command Handlers
container.register("UpdateUserCommandHandler", UpdateUserCommandHandler);
container.register("ChangePasswordCommandHandler", ChangePasswordCommandHandler);
container.register("DeleteUserCommandHandler", DeleteUserCommandHandler);

// Query Handlers
container.register("GetAllUsersQueryHandler", GetAllUsersQueryHandler);
container.register("GetUserByIdAdminQueryHandler", GetUserByIdAdminQueryHandler);
```

---

## PASO 9 — Registrar ruta en index.ts

### 9.1 `src/infraestructure/http/routes/index.ts`

Agregar el import y el `router.use`:

```typescript
import { UserAdminRoute } from "./user/user-admin.routes";

// En AppRoute.routes, reemplazar la línea de /users (upload) por:
router.use("/users", new UploadUserRoute().routes);   // ya existe — mantener
router.use("/users", new UserAdminRoute().routes);    // nueva línea
```

> Ambas rutas coexisten bajo `/users`. Express resuelve en orden:
> - `POST /users/upload` → UploadUserRoute
> - `GET /users`, `GET /users/:id`, `PUT /users/:id`, `PATCH /users/:id/password`, `DELETE /users/:id` → UserAdminRoute

---

## PASO 10 — Verificar tipo `AuthenticatedRequest`

En el controller se usa `req.user!.role`. Verificar que `AuthenticatedRequest` exponga `role` en `req.user`. Buscar en `src/domain/interfaces/types/auth-payload.type.ts` y en el middleware `auth-guard.middleware.ts`. Si `req.user` no incluye `role`, agregar el campo al payload JWT.

Ejemplo esperado en `AuthenticatedRequest`:
```typescript
user: {
  userId: string;
  sessionId: string;
  email: string;
  role: string;   // ← debe existir
}
```

---

## Commits sugeridos

```
feat(users): add domain methods changeRole and changePassword to UserEntity

feat(users): add GetAllUsers and GetUserByIdAdmin queries

feat(users): add UpdateUser, ChangePassword and DeleteUser commands

feat(users): implement findAll, update and delete in PrismaUserRepository

feat(users): add Zod schemas for user management (UpdateUserSchema, ChangePasswordSchema)

feat(users): add UserAdminController and UserAdminRoute for admin CRUD

feat(users): register user admin handlers and route in DI container
```

---

## Endpoints finales

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| `GET` | `/users?page=1&pageSize=10` | ADMIN, SUPER_ADMIN | Listar usuarios paginados |
| `GET` | `/users/:id` | ADMIN, SUPER_ADMIN | Obtener usuario por ID |
| `PUT` | `/users/:id` | ADMIN, SUPER_ADMIN | Actualizar nombre y/o rol |
| `PATCH` | `/users/:id/password` | Autenticado (propio o admin) | Cambiar contraseña |
| `DELETE` | `/users/:id` | ADMIN, SUPER_ADMIN | Eliminar usuario |

---

## Checklist de validación

- [ ] Esquemas Zod en `infra/http/controllers/schemas/user.schema.ts`
- [ ] Repository usa `executeSafe` en cada operación Prisma
- [ ] Handlers inyectan interfaces (`@inject(DI.UserRepository)`)
- [ ] No se usa `new Error()` — solo `ErrorFactory`
- [ ] Controller usa `ResponseBuilder.sendSuccess`, nunca `res.json()`
- [ ] No se puede eliminar el propio usuario (guardia en handler)
- [ ] `PATCH /users/:id/password` valida que el solicitante sea el mismo usuario o admin
- [ ] `req.user.role` está disponible en `AuthenticatedRequest`
