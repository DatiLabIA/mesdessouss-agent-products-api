---
name: datihub-patterns-skill
description: Guía de implementación de patrones de diseño para el backend de DatiHub.
author: developer
version: "2.1"
---

# 🎨 Design Patterns Skill (DatiHub)

## 🎯 Propósito

Garantizar un código mantenible, testeable y escalable mediante la aplicación estricta de patrones de diseño en las capas correctas.

---

## 🏗️ Patrones en Uso

### 1. Builder Pattern (Creación de Entidades)

**Obligatorio:** Siempre que una Entidad de Dominio tenga **más de 5 atributos**.

**Reglas de Implementación:**

- **Ubicación:** El Builder debe residir en `src/domain/builders/`.
- **Validación:** El método `.build()` DEBE ejecutar las validaciones de negocio antes de retornar la instancia.
- **Fluidez:** Usar métodos `withAttribute()` para facilitar la lectura.
- **Inmutabilidad:** La entidad resultante debe ser preferiblemente inmutable (readonly).

#### 🛠️ Cuándo Refactorizar hacia un Builder:

- Cuando el constructor de una entidad se vuelve difícil de leer (exceso de parámetros).
- Cuando la validación de un campo depende del valor de otro (Validación Semántica).
- Cuando necesitas transformar IDs temporales/externos en IDs reales de dominio antes de la creación.

#### 📝 Estándar de Implementación (Basado en `FlowStepBuilder`):

- **Ubicación:** `src/domain/builders/`.
- **Validación Semántica:** El método `private valiated()` debe centralizar las reglas de negocio.
  - _Ejemplo:_ Si el tipo es `TEMPLATE`, el `templateName` no puede estar vacío.
- **Mapeo de Referencias:** Debe incluir métodos como `updateReferences(idMapper)` para resolver dependencias entre entidades antes del `.build()`.
- **Errores:** Usar estrictamente `ErrorFactory.create("validation-failed", "mensaje")`.

---

### 2. Repository Pattern (Desacoplamiento de Datos)

**Uso:** Aislar el dominio de Prisma o cualquier ORM externo.

- **Contrato:** Interfaces en `src/domain/repositories/`.
- **Implementación:** Clases en `src/infrastructure/database/persistences/repositories/`.
- **Inyección:** Usar `@injectable()` y resolver mediante el contenedor de **TSyringe**.

### Repository Pattern

**Uso:** Contratos para el ciclo de vida de las Entidades (CRUD).

- **Ubicación:** `src/domain/repositories/`.
- **Implementación:** Clases en `src/infrastructure/database/persistences/repositories/`.
- **Inyección:** Usar `@injectable()` y resolver mediante el contenedor de **TSyringe**.
- **Regla:** Solo deben manejar **Entidades de Dominio**. Si devuelves objetos planos (JSON/DTOs), considera usar un `Reader`.

---

### 3. Adapter Pattern (Puertos y Adaptadores)

**Uso:** Integración con proveedores de terceros (WhatsApp, AWS Bedrock, Brevo).

- **Lógica de Conversión:** Todo el mapeo de "Dato Externo" a "Entidad de Dominio" debe ocurrir **dentro** del Adaptador.
- **Interfaces:** Definidas como `ports` en el dominio para garantizar que el negocio no sepa qué API estamos usando.

---

### 4. Observer Pattern (Efectos Secundarios)

**Uso:** Acciones que deben ocurrir tras un proceso principal (Métricas, Webhooks, Logs).

- **Aislamiento:** El fallo de un Observer no debe interrumpir el flujo principal del Caso de Uso.
- **Orquestación:** Coordinado en la capa de **Aplicación**.

---

### 5. Factory Pattern (Respuestas Estándar)

**Uso:** Centralización de `AppError` y `AppSuccess`.

- **Regla:** Ningún Caso de Uso debe lanzar un `new Error()` genérico. Debe usar la Factory para devolver errores tipados que el `ErrorHandler` de la infraestructura pueda entender.

---

### 6. Interface Segregation: Ports vs Readers

Para mantener el dominio limpio, diferenciamos según la salida:

| Carpeta                   | Propósito                                                                  | Ejemplo                                  |
| :------------------------ | :------------------------------------------------------------------------- | :--------------------------------------- |
| **interfaces/ports/**     | Servicios externos con lógica (Input/Output).                              | `IAIService`, `IMessageAdapter`          |
| **interfaces/readers/**   | Consultas de solo lectura (Query Model) cuando la Entidad no es necesaria. | `IFlowDetailsReader`, `IUserStatsReader` |
| **interfaces/providers/** | Proveedores de datos crudos o configuraciones.                             | `IConfigProvider`                        |
| **repositories/**         | CRUD puro y duro de Entidades.                                             | `UserRepository`, `FlowRepository`       |

### 📂 Estándar de Agrupación de Consultas (Anti-Dispersión)

Para evitar la creación de lógica de lectura en controladores o servicios legacy, aplicamos la Regla de Única Fuente de Consulta:

1. Centralización en `interfaces/readers/`
   Cualquier consulta a la base de datos que no retorne una Entidad de Dominio completa debe definirse aquí.

**Prohibido**: Crear funciones de Prisma directas en los Use Cases o Controllers.
**Obligatorio**: Definir la interfaz en domain/interfaces/readers/ e implementar en infrastructure/database/prisma/.

### 📎 Nota sobre Readers (Patrón Temporal)

**Estado:** Deuda Técnica Controlada (En transición).

**Propósito:** Permitir consultas de infraestructura que requieren datos que aún no están totalmente modelados en las **Entidades de Dominio**.

**Reglas de uso:**

- **Solo Lectura:** No deben contener lógica de negocio ni persistir datos.
- **Retorno:** Pueden devolver `Types` o `Interfaces` (DTOs de infraestructura) en lugar de Entidades.
- **Obsolescencia:** Una vez que la Entidad de Dominio en `src/domain/entities/` esté completa, los métodos del Reader deben migrar al **Repository** o a un **Read Model** formal.

---

## 🚀 Guía de Refactorización para el Equipo

Al revisar código antiguo (especialmente en `src/services/` legacy), aplica estos pasos:

1.  **Identificar el "Lodo"**: Si un servicio tiene lógica de persistencia, lógica de negocio y llamadas a APIs externas en un solo archivo, divídelo.
2.  **Extraer la Creación**: Si ves objetos creados manualmente con grandes bloques de código, crea un **Builder**.
3.  **Inyectar, no Instanciar**: Cambia los `new Service()` por inyecciones de TSyringe (`@inject`).
4.  **Validar en el lugar correcto**: Mueve las validaciones de `if (!data) throw...` del Controller hacia el Builder o el Value Object correspondiente.

---

## 📊 Tabla de Decisión Rápida

| Si ves esto...                | Aplica este Patrón...  | Ubicación          |
| :---------------------------- | :--------------------- | :----------------- |
| Entidad con >5 campos         | **Builder**            | `domain/builders/` |
| Consultas directas a Prisma   | **Repository**         | `infra/database/`  |
| `if (type === 'A' && !propB)` | **Builder (valiated)** | `domain/builders/` |
| Llamada a API de WhatsApp     | **Adapter**            | `infra/adapters/`  |
| Envío de emails tras registro | **Observer**           | `app/observers/`   |

---

## 🔗 Documentación Vinculada

- [Clean Architecture Principles](../../docs/guides/architecture-clean-architecture-decision.md)
- [Conventional Commits & Release Guide](../development/coding-standards.md)
