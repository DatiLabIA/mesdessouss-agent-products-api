---
name: datihub-prisma-database-skill
description: Estándar de uso de Prisma, diseño de esquema y sincronización de modelos de datos.
author: developer
version: "2.0"
---

# 🗄️ Prisma & Database Skill (DatiHub)

## 🎯 Propósito
Garantizar una persistencia de datos íntegra, performante y, sobre todo, **sincronizada** con la documentación para que el equipo y la IA siempre trabajen sobre el esquema real.

---

## 🏗️ Reglas de Diseño (Schema Design)

### 1. Estándares de Tabla
- **Identificadores**: Uso obligatorio de `uuid()` para IDs (ej: `id String @id @default(uuid())`).
- **Mapeo**: Usar siempre `@@map("nombre_tabla")` para asegurar nombres en *snake_case* en PostgreSQL.
- **Índices**: Añadir `@@index` en columnas utilizadas frecuentemente en filtros (`where`) o registros de auditoría.

### 2. Tipos y Enums
- Utilizar `enum` para valores con dominio acotado (ej: `StepType`, `ScheduleStatus`).
- Evitar el uso de `String` genérico cuando el campo representa un estado lógico.

---

## ⚠️ La Regla de Oro: Sincronización Mandatoria

**El archivo `schema.prisma` y `ai-specs/specs/data-model.md` deben ser espejos.**

Cada commit que modifique la base de datos **DEBE** incluir la actualización del documento de texto en la misma transacción de Git.

#### ¿Cuándo actualizar `data-model.md`?
* **Nuevo Modelo**: Crear sección con campos, tipos y relaciones.
* **Campo modificado**: Reflejar cambios de tipo, nulidad o renombramiento.
* **Relaciones**: Actualizar ambos lados de la FK (lado uno y lado muchos).
* **Infraestructura SQL**: Si activas extensiones como `pgvector` o creas colas en `PGMQ`, documéntalo en la sección "Infrastructure/AI Tables".

---

## 🚀 Prisma Client & Performance

### 1. Capa de Acceso
- **Ubicación**: El acceso a Prisma está restringido a **Repositories** y **Readers** dentro de `src/infrastructure/database/`.
- **Prohibido**: Importar `@prisma/client` en la capa de Dominio o Aplicación.

### 2. Optimización de Consultas
- **Antipatrón N+1**: Prohibido ejecutar queries dentro de bucles `map` o `foreach`.
- **Solución**: Usar `include` para relaciones necesarias o realizar consultas por lotes (`findMany` con `in`).
- **Selección**: Usar `select` en los **Readers** para traer solo los campos necesarios y mejorar el rendimiento.

### 3. Transacciones
- Usar `$transaction` para cualquier operación que involucre múltiples escrituras dependientes (ej: crear un usuario y su primer flujo de bienvenida).

---

## 🛠️ Flujo de Trabajo (Workflow)

1.  **Modificar**: Editar `prisma/schema.prisma`.
2.  **Migrar**: `npx prisma migrate dev --name <descripcion_del_cambio>` — esto genera el archivo SQL versionado en `prisma/migrations/` y aplica el cambio. **Este paso es obligatorio y no puede omitirse.**
3.  **Documentar**: Abrir `ai-specs/specs/data-model.md` y reflejar los cambios exactos.
4.  **Graficar**: Actualizar el diagrama **Mermaid ERD** al final del documento si hay nuevas tablas o vínculos.
5.  **Commit**: `git commit -m "feat(db): add user preferences and sync data-model"`

## 🚫 Antipatrones de Migración (PROHIBIDO)

| Comando | Por qué está prohibido |
| :--- | :--- |
| `prisma migrate reset` | Destruye todo el historial de migraciones y los datos. Solo válido en entornos de desarrollo local limpios. |
| `prisma db push --force-reset` | Omite el sistema de migraciones. Genera drift entre el schema y el historial. |
| `prisma migrate deploy --force` | Fuerza migración en producción sin validación. Riesgo de pérdida de datos. |

> Si aparece un error de **schema drift** (el esquema real difiere del historial), resolverlo con `npx prisma migrate resolve --applied <migration_name>` — nunca con reset ni force.

---

## 📊 Extensiones Especiales (AI Layer)

| Tecnología | Uso en DatiHub | Documentación en MD |
| :--- | :--- | :--- |
| **pgvector** | Almacenamiento de embeddings para RAG. | Indicar dimensiones (ej: 1536 para OpenAI). |
| **PGMQ** | Gestión de colas de mensajes (Background Jobs). | Indicar nombre de la cola y esquema JSON. |

---
## 🔗 Documentos Vinculados
- [Clean Architecture Guide](./clean-architecture.md)
- [Error Handling (executeSafe)](./error-handling.md)