Implementa el ticket: $ARGUMENTS.

## Resolución de contexto del ticket

Antes de comenzar, resuelve la fuente de información en este orden:

1. **Jira MCP disponible** y el argumento tiene formato de ID Jira (ej: `SCRUM-42`): usar el MCP para obtener los detalles completos del ticket.
2. **MCP no disponible o no responde**:
   - Buscar primero `ai-specs/changes/[ID]_backend.md` — si existe un plan previo, seguirlo exactamente.
   - Si no, buscar `ai-specs/changes/[ID]_ticket.md` o `ai-specs/changes/[ID]_input.md`.
3. **Ninguna fuente disponible**: pedir al usuario que proporcione la descripción o que ejecute primero el comando de planificación.

> ⚠️ Si existe un plan en `ai-specs/changes/[ID]_backend.md`, seguirlo como fuente de verdad.

Siga estos pasos:

1. Comprenda el problema descrito en el ticket.
2. Busque los archivos relevantes en el código base.
3. Cree una nueva rama con el ID del ticket (por ejemplo, SCRUM-1).
4. Implemente los cambios necesarios para resolver el ticket, siguiendo el orden de las diferentes tareas y asegurándose de completarlas todas en orden, como escribir y ejecutar pruebas para verificar la solución, actualizar la documentación, etc.
5. Asegúrese de que el código supere el linting y la verificación de tipos.
6. Prepare solo los archivos afectados por el ticket y no incluya ningún otro archivo modificado en la confirmación. Cree un mensaje de confirmación descriptivo.
7. Publique y cree una solicitud de confirmación (PR) con el ID del ticket (por ejemplo, SCRUM-1) para que se vincule en el ticket de Jira.
8. **Marcar el plan como implementado**: si existe `ai-specs/changes/[ID]_backend.md`, actualizar su sección `## Estado de implementación` con:
   - `Estado: ✅ implementado`
   - `PR:` número/URL del PR creado
   - `Rama:` nombre de la rama
   - `Implementado por:` nombre del agente o desarrollador
   - `Fecha:` fecha actual
9. **Guardar guías permanentes**: si durante la implementación se generó documentación arquitectónica reutilizable (patrones, decisiones de diseño, guías de uso), guardarla en `docs/guides/[nombre-descriptivo].md` — **no** en `ai-specs/changes/`.

Recuerde usar la CLI de GitHub (`gh`) para todas las tareas relacionadas con GitHub.

## Convención de archivos en `ai-specs/changes/`

| Patrón | Propósito | Ciclo de vida |
|---|---|---|
| `[ID]_backend.md` | Plan de implementación de ticket | Temporal — se archiva al completar PR |
| `[ID]_frontend.md` | Plan de implementación frontend | Temporal — se archiva al completar PR |
| `[ID]_input.md` / `[ID]_ticket.md` | Descripción cruda del ticket | Temporal — insumo para el plan |

> Las guías de arquitectura y decisiones de diseño permanentes van en `docs/guides/`.
