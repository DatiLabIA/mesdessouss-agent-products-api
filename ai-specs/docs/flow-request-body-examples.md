# Flow API - Request Body Examples

## user login  
```json
{
  "email": "contacto@mrdesign.com.co",
"password":"@Maracuya2020"
}
```
## 1. Create Flow

```json
{
  "name": "bienvenida-nueva",
  "description": "Flujo de bienvenida para nuevos clientes",
  "triggerType": "manual",
  "triggerConditions": ["hola", "buenas", "inicio"],
  "isActive": true,
  "isAutoResponse": false,
  "flowType": "STANDARD",
  "aiProvider": "OPENAI",
  "aiModel": "claude-sonnet-4-20250514",
  "systemPrompt": "Eres un asistente amigable de ventas. Saluda cordialmente y pregunta como puedes ayudar.",
  "temperature": 0.7,
  "maxTokens": 1024,
  "useRAG": false,
  "ragMaxResults": 5,
  "enabledFunctions": false,
  "allowedFunctions": null,
  "steps": [
    {
      "id": "step_1",
      "stepIndex": 0,
      "type": "text",
      "content": "Hola! Bienvenido a nuestro servicio. En que puedo ayudarte hoy?",
      "messageFormat": "plain",
      "templateName": "inicio_metotrexaco",
      "actionType": "send_email",
      "actionConfigId": "b45143a0-7e2b-4c59-941e-65b5a4c5df59",
      "nextStepDefaultId": "step_3",
      "options": [
        {
          "label": "Informacion",
          "value": "info",
          "nextStepId": "step_2",
          "triggersAction": false
        },
        {
          "label": "Hablar con un asesor",
          "value": "asesor",
          "nextStepId": null,
          "triggersAction": true
        }
      ]
    },
    {
        "id": "step_1",
      "stepIndex": 1,
      "type": "input",
      "content": "Perfecto,cuentame mas sobre lo que necesitas:",
      "messageFormat": "plain",
      "templateName": "usuario_con_barrera",
      "actionType": "send_email",
      "actionConfigId": "b45143a0-7e2b-4c59-941e-65b5a4c5df59",
      "nextStepDefaultId": "step_2",
      "options": []
    },
    {
        "id": "step_2",
      "stepIndex": 2,
      "type": "text",
      "content": "Gracias por tu interes. Un asesor te contactara pronto.",
      "messageFormat": "plain",
      "templateName": "verificacion_identidad",
      "actionType": "send_email",
      "actionConfigId": "b45143a0-7e2b-4c59-941e-65b5a4c5df59",
      "nextStepDefaultId": "step_3",
      "requiresHandover": true,
      "options": []
    }
  ]
}
```

---

## 2. Update Flow

```json
{
  "name": "bienvenida-nueva-edicion",
  "description": "Flujo actualizado de bienvenida",
  "triggerType": "manual",
  "triggerConditions": ["hola", "buenas", "inicio"],
  "isActive": false,
  "isAutoResponse": false,
  "flowType": "STANDARD",
  "aiProvider": "OPENAI",
  "aiModel": "claude-sonnet-4-20250514",
  "systemPrompt": "Eres un asistente amigable de ventas. Saluda cordialmente y pregunta como puedes ayudar.",
  "temperature": 0.7,
  "maxTokens": 1024,
  "useRAG": false,
  "ragMaxResults": 5,
  "enabledFunctions": false,
  "allowedFunctions": null,
  "steps": [
    {
      "id": "step_1",
      "stepIndex": 0,
      "type": "text",
      "content": "Hola! Bienvenido a nuestro servicio. En que puedo ayudarte hoy?",
      "messageFormat": "plain",
      "templateName": "inicio_metotrexaco",
      "actionType": "send_email",
      "actionConfigId": "b45143a0-7e2b-4c59-941e-65b5a4c5df59",
      "nextStepDefaultId": "step_3",
      "options": [
        {
          "label": "Informacion",
          "value": "info",
          "nextStepId": "step_2",
          "triggersAction": false
        },
        {
          "label": "Hablar con un asesor",
          "value": "asesor",
          "nextStepId": null,
          "triggersAction": true
        }
      ]
    },
    {
        "id": "step_1",
      "stepIndex": 1,
      "type": "input",
      "content": "Perfecto,cuentame mas sobre lo que necesitas:",
      "messageFormat": "plain",
      "templateName": "usuario_con_barrera",
      "actionType": "send_email",
      "actionConfigId": "b45143a0-7e2b-4c59-941e-65b5a4c5df59",
      "nextStepDefaultId": "step_2",
      "options": []
    },
    {
        "id": "step_2",
      "stepIndex": 2,
      "type": "text",
      "content": "Gracias por tu interes. Un asesor te contactara pronto.",
      "messageFormat": "plain",
      "templateName": "verificacion_identidad",
      "actionType": "send_email",
      "actionConfigId": "b45143a0-7e2b-4c59-941e-65b5a4c5df59",
      "nextStepDefaultId": "step_3",
      "requiresHandover": true,
      "options": []
    }
  ]
}
```

---

## 3. Campos Explicados

| Campo                | Tipo    | Requerido | Descripcion                         |
| -------------------- | ------- | --------- | ----------------------------------- |
| name                 | string  | YES       | Nombre unico del flow               |
| description          | string  | NO        | Descripcion del flow                |
| triggerType          | enum    | YES       | keyword, always, scheduled          |
| triggerConditions    | array   | NO        | Keywords que activan el flow        |
| isActive             | boolean | NO        | Si el flow esta activo              |
| isAutoResponse       | boolean | NO        | Si es respuesta automatica          |
| flowType             | enum    | NO        | standard, ai, agent                 |
| aiProvider           | enum    | NO        | anthropic, aws_bedrock              |
| aiModel              | string  | NO        | Modelo de AI a usar                 |
| systemPrompt         | string  | NO        | Prompt del sistema                  |
| temperature          | number  | NO        | 0-1 (creatividad)                   |
| maxTokens            | number  | NO        | Max tokens en respuesta             |
| useRAG               | boolean | NO        | Usar Retrieval-Augmented Generation |
| knowledgeBaseId      | uuid    | NO        | ID de knowledge base                |
| ragMaxResults        | number  | NO        | Resultados a retrieve               |
| enabledFunctions     | boolean | NO        | Habilitar functions                 |
| allowedFunctions     | array   | NO        | Lista de funciones permitidas       |
| agentId              | string  | NO        | ID de Bedrock Agent                 |
| agentAliasId         | string  | NO        | Alias del Agent                     |
| handoffDestinationId | uuid    | NO        | Destino para transferencia          |
| steps                | array   | YES       | Array de pasos                      |

### Step Fields

| Campo             | Tipo          | Requerido   | Descripcion                     |
| ----------------- | ------------- | ----------- | ------------------------------- |
| id                | string (temp) | Solo update | ID temporal para referencias    |
| stepIndex         | number        | YES         | Indice del paso (0, 1, 2...)    |
| type              | enum          | YES         | text, input, condition, action  |
| content           | string        | YES         | Contenido del mensaje           |
| messageFormat     | enum          | NO          | text, markdown, template        |
| templateName      | string        | NO          | Nombre de plantilla             |
| actionType        | string        | NO          | Tipo de accion                  |
| actionConfigId    | uuid          | NO          | Config de la accion             |
| nextStepDefaultId | string        | NO          | ID del siguiente paso           |
| requiresHandover  | boolean       | NO          | Requiere transferencia a agente |
| options           | array         | NO          | Opciones del usuario            |

### Option Fields

| Campo          | Tipo    | Descripcion            |
| -------------- | ------- | ---------------------- |
| label          | string  | Texto visible          |
| value          | string  | Valor interno          |
| nextStepId     | string  | ID del paso siguiente  |
| triggersAction | boolean | Si dispara una accion  |
| odooField      | string  | Campo Odoo relacionado |
