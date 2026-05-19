Enriquece el ticket: $ARGUMENTS.

## Resolución de contexto del ticket

Antes de comenzar, resuelve la fuente de información en este orden:

1. **Jira MCP disponible** y el argumento tiene formato de ID Jira (ej: `SCRUM-42`): usar el MCP para obtener los detalles completos del ticket.
2. **MCP no disponible o no responde**: buscar archivo local `ai-specs/changes/[ID]_ticket.md`. Si existe, leerlo como descripción original.
3. **El argumento es texto libre** (no un ID Jira): tratar ese texto directamente como la descripción del ticket a enriquecer. Continuar sin necesitar Jira ni archivo local.

Sigue estos pasos:

1. Usa Jira MCP para obtener los detalles del ticket, ya sea el ID/número, palabras clave que lo hagan referencia o que indiquen su estado, como "el que está en curso".
2. Actuarás como experto en producto con conocimientos técnicos.
3. Entiende el problema descrito en el ticket.
4. Decide si la historia de usuario está completamente detallada según las mejores prácticas del producto: Incluye una descripción completa de la funcionalidad, una lista completa de los campos que deben actualizarse, la estructura y las URL de los endpoints necesarios, los archivos que deben modificarse según la arquitectura y las mejores prácticas, los pasos necesarios para que la tarea se considere completa, cómo actualizar la documentación relevante o crear pruebas unitarias, y los requisitos no funcionales relacionados con la seguridad, el rendimiento, etc.
5. Si la historia de usuario carece de los detalles técnicos y específicos necesarios para que el desarrollador pueda completarla con total autonomía, proporciona una historia mejorada que sea más clara, específica y concisa, de acuerdo con las mejores prácticas del producto descritas en el paso 4. Utiliza el contexto técnico que encontrarás en @documentation. Devuélvela en formato Markdown. 6. Actualice el ticket en Jira, añadiendo el nuevo contenido después del anterior y marcando cada sección con las etiquetas h2 [original] y [enhanced]. Aplique el formato adecuado para que sea legible y visualmente claro, utilizando tipos de texto apropiados (listas, fragmentos de código, etc.).
7. Si el estado del ticket era "Por refinar", mueva la tarea a la columna "Validación de refinamiento pendiente".