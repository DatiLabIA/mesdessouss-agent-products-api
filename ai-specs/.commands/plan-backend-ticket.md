# Rol

Eres un arquitecto de software experto con amplia experiencia en proyectos Node/Express aplicando Diseño Dirigido por Clean Arquitecture y Dominio (DDD).

# ID del Ticket

$ARGUMENTOS

## Resolución de contexto del ticket

Antes de comenzar, resuelve la fuente de información en este orden:

1. **Jira MCP disponible** y el argumento tiene formato de ID Jira (ej: `SCRUM-42`): usar el MCP para obtener los detalles completos del ticket.
2. **MCP no disponible o no responde**: buscar archivo local `ai-specs/changes/[ID]_ticket.md` o `ai-specs/changes/[ID]_input.md`. Si existe, leerlo y usarlo como descripción.
3. **Ninguna fuente disponible**: indicar al usuario qué información se necesita y pedirle que la pegue directamente en el chat. Continuar cuando sea recibida.

> ⚠️ No continuar con el proceso sin haber resuelto el contexto del ticket.

# Objetivo

Obtener un plan paso a paso para un ticket de Jira listo para implementar.

# Proceso y reglas

1. Adoptar el rol `ai-specs/.agents/backend-developer.md`
1. Analizar el ticket de Jira mencionado en #ticket usando el MCP. Si la mención es un archivo local, evitar usar MCP.
2. Proponer un plan paso a paso para la parte backend, considerando todo lo mencionado en el ticket y aplicando las mejores prácticas y reglas del proyecto que se encuentran en `ai-specs/specs`.

3. Aplicar las mejores prácticas de tu rol para garantizar que el desarrollador pueda ser completamente autónomo e implementar el ticket de principio a fin usando únicamente tu plan.

4. No escribir código todavía; proporcionar únicamente el plan en el formato de salida definido a continuación. 5. Si se le solicita que comience la implementación en algún momento, asegúrese de que lo primero que haga sea ir a una rama con el nombre del ID del ticket (si aún no está allí) y seguir el proceso descrito en el comando /develop-us.md

# Formato de salida

Documento Markdown en la ruta `ai-specs/changes/[jira_id]_backend.md` que contiene los detalles completos de la implementación.

Sigue esta plantilla:

## Estructura de la plantilla de ticket del plan de implementación de backend

### 1. **Encabezado**
- Título: `# Plan de implementación de backend: [TICKET-ID] [Nombre de la función]`

### 2. **Estado de implementación** *(se actualiza al implementar)*
```
- Estado: ⏳ pendiente | ✅ implementado | ❌ bloqueado
- PR: —
- Rama: —
- Implementado por: —
- Fecha: —
```

### 3. **Descripción general**
- Breve descripción de la función y los principios de arquitectura (Clean Arquitecture, DDD)

### 3. **Contexto de la arquitectura**
- Capas involucradas (Dominio, App, Infraestructure)
- Componentes/archivos referenciados

### 4. **Pasos de implementación**
Pasos detallados, típicamente:

#### **Paso 0: Crear rama de función**
- **Acción**: Crear y cambiar a una nueva rama de función siguiendo el flujo de trabajo de desarrollo. Comprueba si existe y, si no, créala.
- **Nombre de rama**: Sigue la convención de nombres de rama del proyecto (`feature/[ticket-id]-backend`, establece que sea obligatorio usar este nombre y no permitas que se mantenga la tarea general [ticket-id] si existe para separar asuntos).
- **Pasos de implementación**:
1. Asegúrate de estar en la rama `main` o `develop` más reciente (o la rama base correspondiente).
2. Extrae los últimos cambios: `git pull origin [base-branch]`.
3. Crea una nueva rama: `git checkout -b [branch-name]`.
4. Verifica la creación de la rama: `git branch`.
- **Notas**: Este debe ser el PRIMER paso antes de realizar cualquier cambio en el código. Consulta la sección "Flujo de trabajo de desarrollo" de `ai-specs/specs/backend-standards.mdc` para conocer las convenciones de nombres de rama y las reglas de flujo de trabajo específicas.

#### **Paso N: [Nombre de la acción]**
- **Archivo**: Ruta del archivo de destino
- **Acción**: Qué implementar
- **Firma de la función**: Firma del código
- **Pasos de implementación**: Lista numerada
- **Dependencias**: Importaciones requeridas
- **Notas de implementación**: Detalles técnicos

Pasos comunes:
- **Paso 1**: Crear la función de validación
- **Paso 2**: Crear el método de servicio
- **Paso 3**: Crear el método del controlador
- **Paso 4**: Añadir la ruta
- **Paso 5**: Escribir pruebas unitarias (con subcategorías: Casos exitosos, Errores de validación, No encontrado, Validación de referencia, Errores del servidor, Casos extremos)

Ejemplo de una buena estructura:
**Pasos de implementación**:

1. **Validar la existencia de la posición**:
- Usar `Position.findOne(positionId)` para recuperar la posición existente
- Si no se encuentra la posición, Lanzar `new Error('Posición no encontrada')`
- Almacenar la posición existente para la fusión

#### **Paso N+1: Actualizar la documentación técnica**
- **Acción**: Revisar y actualizar la documentación técnica según los cambios realizados
- **Pasos de implementación**:
1. **Revisar cambios**: Analizar todos los cambios de código realizados durante la implementación
2. **Identificar archivos de documentación**: Determinar qué archivos de documentación necesitan actualizaciones según:
- Cambios en el modelo de datos → Actualizar `ai-specs/specs/data-model.md`
- Cambios en los endpoints de la API → Actualizar `ai-specs/specs/api-spec.yml`
- Cambios en estándares/bibliotecas/configuración → Actualizar los archivos `*-standards.mdc` relevantes
- Cambios en la arquitectura → Actualizar la documentación de arquitectura relevante
3. **Actualizar la documentación**: Para cada archivo afectado:
- Actualizar el contenido en inglés (según `documentation-standards.mdc`)
- Mantener la coherencia con la estructura de la documentación existente
- Asegurar la correcta Formato
4. **Verificar la documentación**:
- Confirmar que todos los cambios se reflejen correctamente
- Verificar que la documentación siga la estructura establecida
5. **Informar actualizaciones**: Documentar qué archivos se actualizaron y qué cambios se realizaron
- **Referencias**:
- Seguir el proceso descrito en `ai-specs/specs/documentation-standards.mdc`
- Toda la documentación debe estar escrita en inglés
- **Notas**: Este paso es OBLIGATORIO antes de considerar completada la implementación. No omitir las actualizaciones de la documentación.

### 5. **Orden de implementación**
- Lista numerada de pasos en secuencia (debe comenzar con el Paso 0: Crear rama de funciones y terminar con el paso de actualización de la documentación)

### 6. **Lista de verificación de pruebas**
- Lista de verificación posterior a la implementación

### 7. **Formato de respuesta de error**
- Estructura JSON
- Asignación de código de estado HTTP

### 8. **Compatibilidad con actualizaciones parciales** (si corresponde)
- Comportamiento de las actualizaciones parciales

### 9. **Dependencias**
- Bibliotecas y herramientas externas requeridas

### 10. **Notas**
- Recordatorios y restricciones importantes
- Reglas de negocio
- Requisitos del lenguaje

### 11. **Próximos pasos después de la implementación**
- Tareas posteriores a la implementación (la documentación ya se aborda en el paso N+1, pero puede incluir integración, implementación, etc.)

### 12. **Verificación de la implementación**
- Lista de verificación final:
- Calidad del código
- Funcionalidad
- Pruebas
- Integración
- Actualizaciones de la documentación completadas
