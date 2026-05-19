# Plan de Implementación: User Admin CRUD — Parte 1

**Fecha:** Mayo 2026  
**Scope:** CRUD de usuarios admin (Domain + Application layers)  
**Método HTTP corregido:** `PATCH /users/:id` (no PUT, alineado con el ticket)

> **⚠️ Correcciones vs spec original (`admin-user-management_backend.md`):**
> - Usa `Pagination<T>` + `PaginationOption` (patrón real del proyecto), NO `PaginationResult<T>` que no existe
> - Usa `IQuery<T>` / `ICommand<T>` con `declare readonly _resultType` (patrón phantom types)
> - Usa `QueryMapper.toPaginateDomain()` para mapear pagination
> - Importa `UserRole` desde `@/domain/common` (no `@/domain/value-objects`)
> - Método HTTP es `PATCH` (no `PUT`) para update parcial

---

## Resumen de Endpoints

| Método | Ruta | Handler |
|--------|------|---------|
| `GET` | `/users` | GetAllUsersQueryHandler |
| `GET` | `/users/:id` | GetUserByIdAdminQueryHandler |
| `PATCH` | `/users/:id` | UpdateUserCommandHandler |
| `PATCH` | `/users/:id/password` | ChangePasswordCommandHandler |
| `DELETE` | `/users/:id` | DeleteUserCommandHandler |

---

## PASO 1 — Domain Layer

### 1.1 Agregar métodos a `src/domain/entities/user.entity.ts`

Añadir después del método `changeName()` (línea ~97):

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

> **Commit:** `feat(users): add changeRole and changePassword methods to UserEntity`

### 1.2 Actualizar `src/domain/repositories/user.repository.ts`

Reemplazar contenido completo:

```typescript
import { UserEntity } from "@/domain/entities/user.entity";
import {
  Pagination,
  PaginationOption,
} from "@/shared/value-objects/pagination.vo";

export interface UserRepository {
  create(user: UserEntity): Promise<UserEntity>;
  findByEmail(email: string): Promise<UserEntity | null>;
  findById(id: string): Promise<UserEntity | null>;
  findAll(opt: PaginationOption): Promise<Pagination<UserEntity>>;
  update(user: UserEntity): Promise<UserEntity>;
  delete(id: string): Promise<boolean>;
}
```

> **Commit:** `feat(users): expand UserRepository interface with findAll and update`

---

## PASO 2 — Application Layer: Queries

### 2.1 Crear `src/app/queries/user/get-all-users.query.ts`

```typescript
import { IQuery } from "@/domain/interfaces/ports";
import { PaginationDto } from "@/shared/value-objects/dto/pagination.dto";

export class GetAllUsersQuery implements IQuery<unknown> {
  declare readonly _resultType: unknown;
  constructor(public readonly pagination: PaginationDto) {}
}
```

### 2.2 Crear `src/app/queries/user/get-all-users.handler.ts`

```typescript
import { injectable, inject } from "tsyringe";
import { IQueryHandler } from "@/domain/interfaces/ports";
import { DI } from "@/infraestructure/DI/global-symbol";
import { UserRepository } from "@/domain/repositories";
import { QueryMapper } from "@/infraestructure/database/persistences/mapper/pagination.mapper";
import { UserResponseMapper } from "@/app/commands/user/mapper/user-response.mapper";
import { GetAllUsersQuery } from "./get-all-users.query";

@injectable()
export class GetAllUsersQueryHandler implements IQueryHandler<
  GetAllUsersQuery,
  unknown
> {
  constructor(
    @inject(DI.UserRepository) private userRepository: UserRepository,
  ) {}

  async handle(query: GetAllUsersQuery): Promise<unknown> {
    const opt = QueryMapper.toPaginateDomain(query.pagination);
    const result = await this.userRepository.findAll(opt);
    return {
      ...result,
      data: result.data.map((u) => UserResponseMapper.toAccessResponse(u)),
    };
  }
}
```

### 2.3 Crear `src/app/queries/user/get-user-by-id-admin.query.ts`

```typescript
import { IQuery } from "@/domain/interfaces/ports";
import { UserResponseDTO } from "@/domain/dtos/user.dto";

export class GetUserByIdAdminQuery implements IQuery<UserResponseDTO> {
  declare readonly _resultType: UserResponseDTO;
  constructor(public readonly userId: string) {}
}
```

### 2.4 Crear `src/app/queries/user/get-user-by-id-admin.handler.ts`

```typescript
import { injectable, inject } from "tsyringe";
import { IQueryHandler } from "@/domain/interfaces/ports";
import { DI } from "@/infraestructure/DI/global-symbol";
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

```typescript
export * from "./get-profile.query";
export * from "./get-profile.handler";
export * from "./get-all-users.query";
export * from "./get-all-users.handler";
export * from "./get-user-by-id-admin.query";
export * from "./get-user-by-id-admin.handler";
```

> **Commit:** `feat(users): add GetAllUsers and GetUserByIdAdmin queries`

---

## PASO 3 — Application Layer: Commands

### 3.1 Crear `src/app/commands/user/update-user.command.ts`

```typescript
import { ICommand } from "@/domain/interfaces/ports";
import { UserResponseDTO } from "@/domain/dtos/user.dto";

export class UpdateUserCommand implements ICommand<UserResponseDTO> {
  declare readonly _resultType: UserResponseDTO;
  constructor(
    public readonly targetUserId: string,
    public readonly name?: string,
    public readonly role?: string,
  ) {}
}
```

### 3.2 Crear `src/app/commands/user/update-user.handler.ts`

```typescript
import { injectable, inject } from "tsyringe";
import { ICommandHandler } from "@/domain/interfaces/ports";
import { DI } from "@/infraestructure/DI/global-symbol";
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

### 3.3 Crear `src/app/commands/user/change-password.command.ts`

```typescript
import { ICommand } from "@/domain/interfaces/ports";

export class ChangePasswordCommand implements ICommand<void> {
  declare readonly _resultType: void;
  constructor(
    public readonly targetUserId: string,
    public readonly requestingUserId: string,
    public readonly requestingRole: string,
    public readonly newPassword: string,
  ) {}
}
```

### 3.4 Crear `src/app/commands/user/change-password.handler.ts`

```typescript
import { injectable, inject } from "tsyringe";
import { ICommandHandler } from "@/domain/interfaces/ports";
import { DI } from "@/infraestructure/DI/global-symbol";
import { UserRepository } from "@/domain/repositories";
import { PasswordService } from "@/domain/services/password.service";
import { ErrorFactory } from "@/domain/exceptions/factory/error-factory.exeption";
import { UserRole } from "@/domain/common";
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
    const isSelf = command.targetUserId === command.requestingUserId;
    const isAdmin =
      command.requestingRole === UserRole.ADMIN ||
      command.requestingRole === UserRole.SUPER_ADMIN;

    if (!isSelf && !isAdmin) {
      ErrorFactory.throwError(
        "forbidden",
        "No tienes permisos para cambiar esta contraseña.",
      );
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

### 3.5 Crear `src/app/commands/user/delete-user.command.ts`

```typescript
import { ICommand } from "@/domain/interfaces/ports";

export class DeleteUserCommand implements ICommand<void> {
  declare readonly _resultType: void;
  constructor(
    public readonly targetUserId: string,
    public readonly requestingUserId: string,
  ) {}
}
```

### 3.6 Crear `src/app/commands/user/delete-user.handler.ts`

```typescript
import { injectable, inject } from "tsyringe";
import { ICommandHandler } from "@/domain/interfaces/ports";
import { DI } from "@/infraestructure/DI/global-symbol";
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
      ErrorFactory.throwError(
        "bad-request",
        "No puedes eliminar tu propia cuenta.",
      );
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

```typescript
export * from "./login.command";
export * from "./login.handler";
export * from "./register-user.command";
export * from "./register-user.handler";
export * from "./logout-user.command";
export * from "./logout-user.handler";
export * from "./refresh-token.command";
export * from "./refresh-token.handler";
export * from "./update-user.command";
export * from "./update-user.handler";
export * from "./change-password.command";
export * from "./change-password.handler";
export * from "./delete-user.command";
export * from "./delete-user.handler";
```

> **Commit:** `feat(users): add UpdateUser, ChangePassword and DeleteUser commands`
