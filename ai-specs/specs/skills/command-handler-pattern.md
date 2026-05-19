---
name: command-handler-pattern
description: >
  Patrón Command/Query Handler con CommandBus para desacoplar controllers de UseCases.
  Trigger: Cuando creas nuevos commands, queries o migras controllers.
author: developer
version: "1.0"
---

# Command Handler Pattern (DatiHub)

Patrón CQRS ligero que introduce un Bus de mensajes entre controllers y lógica de aplicación.

> Implementado en fase piloto sobre el módulo `user`.

---

## Problema que resuelve

**ANTES** — cada controller inyectaba múltiples UseCases:

```typescript
// AuthController inyectaba 4 clases distintas
constructor(
  @inject(DI.RegisterUserUseCase) private createUserUseCase: RegisterUserUseCase,
  @inject(DI.LogginUserUseCase)   private logginUserUseCase: LogginUserUseCase,
  @inject(DI.LogOutUserUseCase)   private logoutUserUseCase: LogOutUserUseCase,
  @inject(DI.RefreshTokenUseCase) private refreshTokenUseCase: RefreshTokenUseCase,
) {}
```

**AHORA** — controller solo conoce el bus:

```typescript
constructor(
  @inject(DI.CommandBus) private commandBus: ICommandBus,
) {}
```

---

## Arquitectura (Commands vs Queries)

| Tipo | ¿Qué hace? | Bus | Handler |
|---|---|---|---|
| **Command** | Mutación (login, register) | `ICommandBus` | `ICommandHandler` |
| **Query** | Solo lectura (getProfile) | `IQueryBus` | `IQueryHandler` |

---

## Flujo de un Command

```
HTTP Request
     │
     ▼
┌─────────────────────┐
│  AuthController     │  ← solo inyecta ICommandBus
└────────┬────────────┘
         │ dispatch(new LoginCommand(email, password))
         ▼
┌──────────────────────────────────────────────────────┐
│  CommandBus                                        │
│  token = "LoginCommand" + "Handler" = "LoginCommandHandler"
│  handler = container.resolve("LoginCommandHandler")
│  return handler.handle(command)                        │
└──────────────────────┬───────────────────────────────┘
                       ▼
┌──────────────────────────────────┐
│  LoginCommandHandler             │
│  handle(command)                │
│    → valida credenciales         │
│    → crea sesión                 │
│    → retorna LoginResponse       │
└──────────────────────────────────┘
          ▼
   LoginResponse (tipado en compile-time)
          ▼
┌─────────────────┐
│  ResponseBuilder │  → HTTP 200
└─────────────────┘
```

---

## Estructura de archivos

```
src/
├── domain/
│   └── interfaces/ports/
│       ├── command-bus.port.ts    ← ICommand, ICommandHandler, ICommandBus
│       └── query-bus.port.ts      ← IQuery, IQueryHandler, IQueryBus
│
├── infraestructure/
│   └── bus/
│       ├── command-bus.ts       ← implementación CommandBus
│       ├── query-bus.ts         ← implementación QueryBus
│       └── index.ts
│
└── app/
    ├── commands/
    │   └── user/
    │       ├── login.command.ts       ← datos de entrada
    │       ├── login.handler.ts    ← lógica (= antiguo UseCase)
    │       └── index.ts
    └── queries/
        └── user/
            ├── get-profile.query.ts
            └── get-profile.handler.ts
```

---

## Convención de nomenclatura

El bus resuelve el handler automáticamente usando el nombre de la clase:

```
LoginCommand        → token: "LoginCommandHandler"
RegisterUserCommand → token: "RegisterUserCommandHandler"
GetProfileQuery    → token: "GetProfileQueryHandler"
```

Registro en DI container (sin Symbols):

```typescript
container.register("LoginCommandHandler", LoginCommandHandler);
container.register("GetProfileQueryHandler", GetProfileQueryHandler);
```

---

## Type Safety (Phantom Types)

Los commands usan `_resultType` para inferencia en compile-time:

```typescript
export class LoginCommand implements ICommand<LoginResponse> {
  declare readonly _resultType: LoginResponse;  // ← solo en type system

  constructor(
    public readonly email: string,
    public readonly password: string,
  ) {}
}

// TypeScript infiere: LoginResponse
const result = await this.commandBus.dispatch(new LoginCommand(email, pass));
```

---

## Comparativa antes vs después

### DI container

```typescript
// ANTES — un Symbol por UseCase
RegisterUserUseCase: Symbol.for("RegisterUserUseCase"),
LoginUseCase: Symbol.for("LoginUseCase"),

// DESPUÉS — solo un Symbol por módulo
CommandBus: Symbol.for("CommandBus"),
QueryBus:   Symbol.for("QueryBus"),
```

### Controller

```typescript
// ANTES
constructor(
  @inject(DI.RegisterUserUseCase) private registerUseCase,
  @inject(DI.LoginUseCase) private loginUseCase,
) {}

// DESPUÉS
constructor(
  @inject(DI.CommandBus) private commandBus: ICommandBus,
) {}
```

---

## Extensibilidad

El mismo handler funciona sin cambios desde cualquier canal:

```typescript
// HTTP controller
await this.commandBus.dispatch(new LoginCommand(email, pass));

// Discord bot (futuro)
await this.commandBus.dispatch(new LoginCommand(email, pass));

// CLI (futuro)
await commandBus.dispatch(new LoginCommand(email, pass));
```

---

## Cómo agregar un nuevo Command

1. **Crear el command** en `src/app/commands/<módulo>/`:

```typescript
export class CreateFlowCommand implements ICommand<FlowResponse> {
  declare readonly _resultType: FlowResponse;

  constructor(
    public readonly name: string,
    public readonly steps: StepDto[],
  ) {}
}
```

2. **Crear el handler**:

```typescript
@injectable()
export class CreateFlowCommandHandler
  implements ICommandHandler<CreateFlowCommand, FlowResponse>
{
  constructor(
    @inject(DI.FlowRepository) private flowRepository: FlowRepository,
  ) {}

  async handle(command: CreateFlowCommand): Promise<FlowResponse> {
    // lógica aquí
  }
}
```

3. **Registrar en container.ts**:

```typescript
container.register("CreateFlowCommandHandler", CreateFlowCommandHandler);
```

4. **Usar en controller**:

```typescript
const result = await this.commandBus.dispatch(
  new CreateFlowCommand(name, steps),
);
```

---

## Estado de migración

| Módulo | Commands | Handlers | Controller |
|---|---|---|---|
| `user` (auth) | ✅ | ✅ | ✅ |
| `user` (profile) | ✅ | ✅ | ✅ |
| `flow` | ⏳ pendiente | ⏳ pendiente | ⏳ pendiente |

> Use cases legacy siguen registrados para compatibilidad.

---

## 🔗 Relacionado

- [CQRS Pattern](https://martinfowler.com/bliki/CQRS.html)
- [MediatR (inspiración)](https://github.com/jbogard/MediatR)