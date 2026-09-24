# Hallazgos y mejoras — tool de pedidos de Lia

**Fecha:** 23/09/2026
**Alcance:** el tool `order_lookup`, el motor de reglas y lo que hay que ajustar en el flow de DatiHub.
**Estado del documento:** completo salvo la revisión de conversaciones (ver el último apartado).

Todo lo que aparece acá está **verificado contra la API real o contra la base de datos**, no inferido. Donde hay una suposición, está marcada.

---

## 1. Qué está desplegado y qué no

| Pieza | Estado |
|---|---|
| Código en `main` | Al día (`7edcc2b`), 197 tests en verde |
| Base de datos | Migraciones aplicadas, 7 tablas, índice único parcial verificado |
| Reglas | **v2 activo**, v1 archivado |
| Servicio | ⚠️ **Sin redesplegar** — expone la versión anterior del código |
| Tool en el flow de test | Registrada y en uso |
| Prompt | Sin el fragmento de `order_lookup` documentado en la guía |

**Lo primero de la lista es redesplegar.** Hasta que el proceso no reinicie, ni las tools MCP nuevas ni los campos nuevos del payload existen para nadie: el arreglo del punto 2 tampoco.

---

## 2. Un tracking de ida ofrecido como retorno — CORREGIDO

**Conversación `8a39511b`, 22/09 20:02**, flow de test. Marcada `bad` por el equipo con la nota *"Falta información sobre el retorno del pedido"* y la etiqueta **A ENTRAINER**.

La clienta preguntó *"où est mon retour de la commande VJWIRCHVQ"*. Lia pidió el email (la puerta de identidad funcionó), llamó a `order_lookup`, y respondió con el **número de seguimiento del envío que le había llegado a ella**, presentándolo como el seguimiento de su devolución. Dos veces.

### La etiqueta estaba mal puesta

No era un problema de entrenamiento. Esto es lo que la tool le entregó:

```
situación    : MAIL_3 | must_escalate: false
facts_to_convey : order_reference, tracking_url   ← el envío DE IDA
must_not_claim  : tres prohibiciones, todas sobre la entrega, ninguna sobre retornos
```

Lia hizo exactamente lo que le dijimos. Le dimos un número de seguimiento sin etiquetar y cero prohibiciones sobre devoluciones.

Tres causas simultáneas:

1. **La tool no sabe qué le preguntaron.** Responde "cuál es el estado de este pedido"; el motor solo ve el estado (10 → grupo B) y devuelve `MAIL_3`.
2. **`return.dataAvailable: false` estaba en el payload pero no llegaba a `guidance`.** Su `reason` explicaba qué recurso le falta al webservice — escrito para los desarrolladores, no para el agente.
3. **Nada indicaba que el tracking era el de ida.**

### Lo que se cambió (`7edcc2b`)

- `shipping.direction: "OUTBOUND"`, explícito.
- Mientras los retornos no sean visibles, **todos** los desenlaces suman dos prohibiciones: no ofrecer el tracking de ida como el del retorno, y no afirmar el estado de un retorno en curso sino derivar.
- `return.reason` reescrito para el agente: dice qué puede y qué no puede decir.

Las prohibiciones dependen del flag, no están hardcodeadas: desaparecen solas el día que exista el módulo que expone `order_returns`.

### La lección, que aplica más allá de este caso

**El agente no lee campos del payload: lee `facts_to_convey` y `must_not_claim`.** `return.dataAvailable` llevaba semanas ahí, correcto y completo, y no servía de nada. Un dato que no entra en esas dos listas, en la práctica no existe.

---

## 3. El 86% del volumen cae en una plantilla vacía

Medido sobre **5.000 pedidos** de agosto y septiembre:

| Estado | Pedidos | Grupo | Desenlace |
|---|---|---|---|
| 10 Commande Terminée | **4.286** | B | `MAIL_3` |
| 61 Retour Terminé | 348 | R | `MAIL_12` |
| 17 Commande en cours de traitement | 106 | A | según stock y retraso |
| 31 Livraison En Cours | 23 | B | `MAIL_3` |
| 14 Livraison partielle | 18 | C | `MAIL_6` / `MAIL_7` |

**Ocho de las nueve plantillas tienen el `body` vacío**, incluida `MAIL_3`. Los textos viven en `scenario_lia.numbers`, hoja Feuil2, que no está en el repositorio. Solo el mail 4 se pudo sembrar, porque el §6 del documento de reglas lo transcribe completo.

Eso significa que hoy, para el 86% de las consultas, Lia redacta **solo** a partir de `facts_to_convey` y `must_not_claim`, sin el texto aprobado como base.

> **Mejora 1 — la de mayor impacto de todo el documento.** Conseguir el Feuil2 y sembrar los ocho `body`. Cualquier otra mejora de redacción es secundaria frente a esto.

---

## 4. Validación del motor sobre datos reales

Corrido contra **37 pedidos** de 10 estados distintos:

```
15  MAIL_3      7  MAIL_5      7  MAIL_1      1  MAIL_4      7  ESCALATE
```

**81% accionable.** Las 7 escaladas son todas por el mismo motivo documentado: estado en grupo D.

### Estados sin mapear

Sobre los 5.000 pedidos, **solo el 4,4% (218)** cae en estados sin mapear:

```
 77  id=83  Remboursé avec Sogecommerce
 53  id=68  Remboursement partiel
 30  id=7   Remboursé
 13  id=78  Autorisation annulée
  5  id=6   Annulé
  6  ids 20, 8, 1 (pagos pendientes o erróneos)
```

Todos son reembolsos, anulaciones o problemas de pago: **escalar es lo correcto**, no hay nada que ajustar.

El único hueco real ya se cerró: el estado **5 "Livré"** (34 pedidos) no estaba mapeado, así que clientes con el pedido **entregado** recibían una escalada. Está en el conjunto v2, en grupo B. Verificado sobre cuatro pedidos reales: pasan de `ESCALATE` a `MAIL_3`.

---

## 5. El contrato HTTP no se cumple — sin decidir

La §2 de `external-tool-service-guide.md` establece que los errores que el agente debe gestionar con el cliente van en **HTTP 200 con `{ "error": "…" }`**, y que 4xx/5xx se reserva para lo que la plataforma debe loguear. El handler no lo cumple del todo:

| Caso | Devuelve | ¿Cumple? |
|---|---|---|
| Identidad no verificada | 200 | ✅ |
| Éxito | 200 | ✅ |
| Falta referencia o email | **400** | ❌ |
| Demasiados intentos | **429** | ❌ |
| Reglas caídas / PrestaShop caído | **503** | ⚠️ |
| Error inesperado | 500 | ✅ |

El 503 es el que importa, y no es teórico: **la base de datos de reglas se cortó seis veces** durante el trabajo del 22/09 (dos `P1001`, cuatro `SocketTimeout`), todas transitorias. Con 503, Lia recibe un fallo duro sin nada que decir — y el comportamiento documentado del agente ante una consulta fallida es rellenar el hueco.

> **Mejora 2.** Mover 400, 429 y 503 a `HTTP 200` con `{ "error": "…" }`, dejando el 500 para lo genuinamente inesperado. Cambio acotado al handler. **Pendiente de decisión.**

---

## 6. La base de datos de reglas es intermitente

Seis cortes en una jornada de trabajo, todos transitorios y resueltos al reintentar. Las consultas normales tardan 350 ms–1 s, así que no es lentitud: son cortes.

> **Mejora 3.** Que alguien mire por qué se cae ese Postgres en EasyPanel. No bloquea el tool —hay reintentos y el fallo degrada a 503— pero cada corte es una consulta de cliente que no se responde.

---

## 7. Latencia y el timeout de la tool

Medido en producción: el camino feliz tarda **1,7 a 3,8 segundos** (identidad ~0,6–1,8 s + consolidación ~1,2–2,0 s; el motor de reglas es puro y tarda 0 ms).

El `timeoutMs` recomendado en la configuración del flow es **20.000**. No conviene bajarlo: cubre los dos reintentos que el cliente hace ante fallos transitorios de PrestaShop, y **si la consulta se corta por tiempo, el agente rellena el hueco inventando** — exactamente lo que el tool existe para impedir.

---

## 8. Lo que el tool no puede responder

Para que nadie lo prometa en el prompt:

- **Devoluciones en curso.** `order_returns` no existe en el webservice de PrestaShop. De los cinco mails de retorno, solo el 12 ("Retour terminé") es implementable. Mientras una devolución está en curso no deja ninguna traza legible.
- **Si se usó la etiqueta de retorno**, de lo que dependen los 6 € de descuento en el reembolso.
- **El motivo declarado de una devolución.**
- **Marcas sin plazo definido**: quedan **Mariner** y **MesDessous**. Un pedido no expedido que las incluya escala.

> **Mejora 4.** Confirmar con el cliente el plazo de esas dos marcas, y el de las tres submarcas sembradas por aproximación (Prima Donna Twist, Prima Donna Bain, Aubade Men → hoy con el plazo de su marca madre).

> **Mejora 5.** Decidir si vale la pena el módulo PrestaShop que expone `order_return`. Sin él, cuatro de los cinco mails de retorno son inalcanzables para siempre.

---

## 9. Una desviación consciente del documento de reglas

El §3.1 dice que *"en el Grupo B el estado de stock es irrelevante: una vez expedido el pedido, siempre es mail 3"*, mientras la fila 13 del §4 escala cualquier marca desconocida en cualquier estado. **Las dos no pueden ser ciertas.**

Se implementó el §3.1: las comprobaciones de stock del fail-safe aplican **solo al grupo A**. El plazo de marca existe para calcular una fecha de expedición, y en un pedido ya expedido esa fecha ya ocurrió — aplicar la fila 13 a todos los grupos escalaría la consulta más frecuente que existe por un dato que nadie lee.

> **Mejora 6.** Confirmar esta lectura con el cliente. Revertirla es una línea.

---

## 10. Lo que falta en este documento

**La revisión de las conversaciones del flow de test.** El conector MCP de DatiHub (`claude.ai prompt mesdessous`) se cayó tres veces el 23/09 y está caído al cerrar este documento, así que no se pudieron leer.

Cuando vuelva, el procedimiento es:

1. Listar las conversaciones del flow `e4304671-0815-4d08-9d95-c060da9235b9`, acotando del 21 al 23 de septiembre (el flow se creó el 21).
2. Descartar las sesiones vacías — las que se abrieron sin que Lia llegara a responder.
3. De cada una: el **detalle** (estado, modo, `reviewRating`, etiquetas) **y** los **mensajes**. Hacen falta los dos: el detalle no trae contenido y los mensajes no traen estado.
4. Por cada respuesta mala, **reproducir qué le entregó la tool** con `get_order_status` sobre esa referencia.

El paso 4 es el que convierte una revisión en un arreglo. Es lo que transformó la conversación `8a39511b` de una etiqueta "A ENTRAINER" en el cambio concreto del apartado 2.

Recordatorio de la guía: **un caso aislado puede ser ruido, tres iguales es un patrón.** Y el registro de conversaciones **no guarda las tarjetas de producto** que inyecta el sistema, así que una respuesta "sin productos" en el log no prueba que el cliente no los viera.

---

## Resumen de mejoras, por impacto

| # | Mejora | Capa | Bloqueada por |
|---|---|---|---|
| 0 | **Redesplegar el servicio** | Infra | — |
| 1 | Sembrar los 8 `body` de plantilla | Reglas (BD) | El Feuil2 de `scenario_lia.numbers` |
| 2 | Mover 400/429/503 a 200 con `{error}` | Código | Decisión del equipo |
| 3 | Investigar los cortes del Postgres | Infra | — |
| 4 | Plazos de Mariner, MesDessous y las 3 submarcas | Reglas (BD) | Confirmación del cliente |
| 5 | ¿Módulo que expone `order_return`? | PrestaShop | Decisión de negocio |
| 6 | Confirmar la desviación del §4 fila 13 | Reglas | Confirmación del cliente |
| 7 | Aplicar el fragmento de prompt | DatiHub | Mejora 0 |

El 0 y el 1 desbloquean todo lo demás. El resto puede ir en paralelo.

---

## Anexo — cómo diagnosticar una respuesta mala

El reflejo útil no es mirar el prompt primero, sino **qué le entregó la tool**:

```
get_order_status(reference, email)     → el payload completo que recibió Lia
simulate_rules(reference, email)       → qué fila de la matriz ganó y por qué
pnpm check:pipeline <REF> <EMAIL>      → la cadena entera desde la línea de comandos
```

Si `facts_to_convey` traía un dato que no correspondía, o `must_not_claim` no prohibía lo que el agente afirmó, **el arreglo es en la tool, no en el prompt**. Fue el caso en el único fallo diagnosticado hasta ahora.

Y una advertencia que este proyecto se ganó a pulso: **los campos obvios de PrestaShop mienten.** `current_state`, el flag `private` de los mensajes, `id_employee`, los tipos de los `id`, las formas de respuesta según `display`. Siete veces el mismo patrón, y siempre igual: nada falla, nada se loguea, solo sale un resultado plausible que está mal. Los tests con `fetch` simulado llegaron a estar 120 en verde con medio feature muerto. Lo único que caza esa clase de fallo es correr la cosa contra la API real.
