---
name: datihub-clean-architecture-guide
description: Estándar maestro de arquitectura y flujo de dependencias para DatiHub Backend.
author: developer
version: "3.0"
---

# 🏗️ Clean Architecture Master Guide (DatiHub)

## 🎯 Propósito

Garantizar que el sistema sea independiente de frameworks, bases de datos y agentes externos. Buscamos un código donde la **lógica de negocio** sea el ciudadano de primera clase.

---

## 🏆 La Regla de Oro

**Las capas internas NUNCA deben conocer a las capas externas.**
El flujo de dependencia siempre debe ir hacia el **Dominio**.

```text
Infraestructura (Outer) → Aplicación (Mid) → Dominio (Core)
         [Detalles]           [Orquestación]      [Reglas de Oro]
```

### 1. Capa de Dominio (src/domain/)

Es el corazón del negocio. Aquí reside la "verdad" del sistema.

✅ Debe incluir:

- Entidades y Value Objects: El estado y las reglas críticas (ej: StepEntity, UUID).
- Interfaces (Contratos): Repositorios (IRepository), Ports y Readers.
- Builders: Lógica de construcción compleja. Regla Obligatoria: Si la entidad tiene > 5 atributos, se usa un Builder.
- Domain Services: Lógica que coordina múltiples entidades (ej: FlowNavigationService).
- Domain Exceptions: Errores de negocio creados estrictamente vía ErrorFactory.

❌ NO debe incluir:

- import { prisma } ... o cualquier referencia a ORMs.
- Tipos de Express (Request, Response).
- Lógica de servicios externos (WhatsApp API, etc.).

### 2. Capa de Aplicación (src/app/)

Orquesta el flujo. Dice QUÉ debe pasar, pero no sabe CÓMO ocurre técnicamente.

✅ Debe incluir:

- Use Cases / Commands / Queries: Orquestación de la lógica (ej: GenerateAIResponse).
- Mappers: Transformación bidireccional entre Entidades ↔ DTOs.
- Observers: Coordinación de efectos secundarios (Métricas, Notificaciones).
- DTOs: Estructuras de datos que viajan entre Infraestructura y Aplicación.

❌ NO debe incluir:

- Implementaciones de persistencia (SQL/Prisma).
- Lógica pesada de negocio (debe delegarse al Dominio).

### 3. Capa de Infraestructura (src/infrastructure/)

Detalles técnicos y herramientas. Implementa los contratos del dominio.

✅ Debe incluir:

- Controllers & Routes: Entrada del mundo exterior (Express, Webhooks).
- Prisma Repositories & Readers: Implementación real de las consultas SQL/Prisma.
- Adapters: Conexión con AWS Bedrock, WhatsApp, Brevo, etc.
- DI Container: Configuración de TSyringe (container.ts).
- Middleware: Validación de Zod, Auth, Error Handlers globales.

## 🚦 Guía de Consultas: ¿Repository o Reader?

Para evitar el desorden y centralizar las consultas, usamos esta lógica:
| Si la consulta... | Ubicación de la Interface | Implementación |
|-------|-----|--------|
| Retorna una Entidad Completa (CRUD) | `domain/repositories/` | `infra/database/persistences/repositories/` |
| Es una Consulta Rápida/Agregada (DTO/Type) | `domain/interfaces/readers/` | `infra/database/persistences/repositories/` |
| Es una funcionalidad de IA/Mensajería | `domain/interfaces/ports/` | `infra/services/` o `adapters/` |

[!NOTE]
Sobre los Readers: Son herramientas de transición. Se usan cuando la Entidad aún no está completa o cuando la consulta es puramente para infraestructura (ej: getConversationForEmail).

## 🛠️ Reglas de Refactorización para el Equipo

Adiós al Lodo: Si un archivo en `src/services/` (legacy) toca base de datos y manda un WhatsApp, debe dividirse en: UseCase (App), Repository (Infra) y Adapter (Infra).

- Commits Limpios: Cada refactor debe seguir el estándar de Conventional Commits para generar el changelog automático.
- Validación Atómica: Las validaciones de "si falta X campo" van en el Builder de la entidad, no en el UseCase.

## Reference Docs

- [Architecture Diagrams](../../../docs/architecture/diagrams.md)

---

## 📝 Ejemplos Reales (DatiHub)

### 1. Entidad con Builder (>5 atributos)

```typescript
// src/domain/entities/flow.entity.ts
export class FlowEntity {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly description: string,
    public readonly triggerType: TriggerType,
    public readonly isActive: boolean,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
    // ... más atributos
  ) {}

  static create(data: FlowInput): FlowEntity {
    // Validaciones en el Builder
    return FlowBuilder.build(data);
  }
}

// src/domain/builders/flow.builder.ts
export class FlowBuilder {
  static build(input: CreateFlowInput): FlowEntity {
    if (!input.name) throw ErrorFactory.create('validation-failed', 'Name requerido');
    // ... validaciones
    return new FlowEntity(...);
  }
}
```

### 2. Repository (Dominio = Interfaz, Infra = Implementación)

```typescript
// src/domain/repositories/iflow.repository.ts
export interface IFlowRepository {
  create(data: CreateFlowDTO): Promise<FlowEntity>;
  findById(id: string): Promise<FlowEntity | null>;
  update(id: string, data: UpdateFlowDTO): Promise<FlowEntity>;
}

// src/infraestructure/database/persistences/repositories/flow.repository.ts
@injectable()
export class FlowRepository implements IFlowRepository {
  async create(data: CreateFlowDTO): Promise<FlowEntity> {
    return this.executeSafe(async () => {
      const created = await prisma.flow.create({ data });
      return FlowMapper.toDomain(created);
    });
  }
}
```

### 3. UseCase (Aplicación)

```typescript
// src/app/use-cases/create-flow.use-case.ts
@injectable()
export class CreateFlowUseCase {
  constructor(
    @inject(DI.IFlowRepository) private flowRepository: IFlowRepository,
  ) {}

  async execute(input: CreateFlowDTO): Promise<FlowEntity> {
    const entity = FlowEntity.create(input);
    return this.flowRepository.create(input);
  }
}
```

### 4. Controller (Infraestructura)

```typescript
// src/infraestructure/http/controllers/flow.controller.ts
export class FlowController {
  @inject(TYPES.CreateFlowUseCase)
  private createFlowUseCase: CreateFlowUseCase;

  async create(req: Request, res: Response) {
    const input = req.body; // Ya validado por Zod
    const result = await this.createFlowUseCase.execute(input);
    return ResponseBuilder.sendSuccess(res, result, 201);
  }
}
```
