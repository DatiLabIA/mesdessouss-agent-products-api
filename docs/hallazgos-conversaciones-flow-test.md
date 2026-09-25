# Hallazgos y mejoras — conversaciones del flow de test

**Última actualización:** 25/09/2026
**Flow:** `mesdessous ia claude — test` (`e4304671-0815-4d08-9d95-c060da9235b9`), Claude Sonnet 4.6, temperatura 0,1
**Complementa a:** [hallazgos-y-mejoras-tool-pedidos.md](hallazgos-y-mejoras-tool-pedidos.md), cuyo §10 dejó pendiente esta revisión.

| Muestra | Periodo (UTC) | Conversaciones |
|---|---|---|
| 1 | 22/09 19:16 → 23/09 09:21 | 29 |
| 2 | 24/09 06:40 → 25/09 00:56 | 33 |
| **Total** | | **62** |

Entre las dos muestras **no cambió nada**: el prompt sigue con la edición del 22/09 18:49, y el repositorio no tiene commits nuevos. Las diferencias de comportamiento no vienen de un cambio de configuración.

Los datos personales (nombres, emails, teléfonos, IBAN) se omiten. Cada caso se identifica por la referencia del pedido y los primeros 8 caracteres del id de la conversación.

---

## 1. Resultado global

| Valoración del equipo | Muestra 1 | Muestra 2 | Total |
|---|---|---|---|
| `good` | 10 | 11 | **21** |
| `bad` | 18 | 10 | **28** |
| Sin valorar | 1 | 12 | **13** |

En la muestra 2, cuatro de las conversaciones sin valorar son **pruebas fuera de tema** (preguntas absurdas, coqueteo, intentos de sacar información interna). Se comentan en el §11.

### Por qué se marcaron `bad` — las 28

| Motivo | M1 | M2 | Total | Capa |
|---|---|---|---|---|
| Retraso o disponibilidad: falta la fecha, el stock limitado o el texto de retraso | 7 | 5 | **12** | Tool + plantillas |
| Devoluciones: responde algo que no corresponde | 3 | 2 | **5** | Tool + plantillas |
| Ignora el historial con el servicio de clientes | 4 | 0 | **4** | Tool |
| Envío parcial: deriva a humano en vez de explicar | 0 | 2 | **2** | Reglas |
| Da información interna al cliente | 0 | 1 | **1** (+3 sin marcar) | Tool |
| Deriva en estados que tienen respuesta (reembolsado, terminado) | 2 | 0 | **2** | Reglas |
| Error técnico de la consulta | 1 | 0 | **1** | Infra |
| Motivo por aclarar | 1 | 0 | **1** | — |

**La conclusión de la muestra 1 se mantiene y se refuerza.** Casi todos los fallos vienen de lo que entrega la consulta de pedidos, no del prompt. Lia hace lo que se le pide —*"responder solo desde `facts_to_convey`"*— y `facts_to_convey` le llega vacío.

**Lo nuevo de la muestra 2:** el equipo empezó a escribir en las notas de revisión **el texto exacto que esperaba**. Son, en la práctica, los cuerpos de las plantillas que faltan (Mejora 1 del documento anterior). Están recopilados en el **Anexo A**.

**Y un riesgo que la muestra 1 solo anticipaba ya ocurrió:** Lia leyó notas internas del equipo a clientes (§4).

---

## 2. Cómo se diagnosticó

Para cada conversación se leyeron los mensajes completos y la valoración del equipo. El registro guarda qué tool llamó Lia y con qué datos, pero **no lo que la tool le devolvió**. Para ver esa respuesta se reprodujo la consulta con `get_order_status`:

| Muestra | Reproducidos | Pedidos |
|---|---|---|
| 1 | 4 | RYOTSAWVN, EFUBKXELE, JBIZNYEPA, EZOYGITYS |
| 2 | 9 | LQTQJXTUR, ZCQJGLQSK, NQWWBQUNW, LUMYVMYVN, MUJJABSBJ, ERGPEYMXN, QVRFQFOQB, ZKHRPZKYY, LYVYRWCVB |

En la muestra 1, el resto de reproducciones quedó bloqueado por la política de permisos de la sesión. Las causas sin reproducir están marcadas como **inferidas**.

⚠️ La reproducción muestra el estado **de hoy**. Varios pedidos se expidieron entre la conversación y la reproducción (LUMYVMYVN, ERGPEYMXN, ZKHRPZKYY), y en esos casos la reproducción ya no sirve para ver qué recibió Lia. Se indica en cada caso.

---

## 3. Hallazgo 1 — retrasos: `MAIL_15` no tiene nada que decir (12 casos)

Es el problema más repetido de las dos muestras, y la muestra 2 permite ver su causa exacta.

### Lo que pide el equipo

**Muestra 1** (7 casos): que Lia diga qué productos están en stock limitado y la fecha máxima de expedición. Notas como *"dire que de produit sont en stock limité - Sloggi délai expédition au plus tard 1 octobre"* o *"Produit disponible — expédition sous 48 heures ouvrées"*.

**Muestra 2** (5 casos): cuatro notas **idénticas** con el texto del correo de retraso:

| Conversación | Pedido |
|---|---|
| `18b3611c` 24/09 06:46 | LUMYVMYVN |
| `9944442e` 24/09 07:49 | QVRFQFOQB |
| `10e1f22e` 24/09 08:06 | LQTQJXTUR |
| `8e8cb91d` 24/09 08:19 | ERGPEYMXN |

> *"Nous sommes malheureusement au regret de vous informer que le délai de préparation initialement annoncé pour votre commande est désormais dépassé. […] nous avons relancé notre service logistique afin d'obtenir une nouvelle estimation […]. Nous reviendrons vers vous dans un délai de 48 heures ouvrées […]"*

Y una quinta (`721c0860`, ZKHRPZKYY) con el texto para un pedido con todo en stock: *"Celle va être expédiée sous 48 heures (hors week-end et jours fériés)"*.

### La causa, reproducida

LQTQJXTUR y QVRFQFOQB (pedidos todavía sin expedir) dan lo mismo que EZOYGITYS en la muestra 1:

```
situation       : MAIL_15
facts_to_convey : []          ← vacío
template_text   : null        ← vacío
must_not_claim  : "must not promise a specific new ship date", …
```

`MAIL_15` es el desenlace de "pedido que ya superó su plazo": no tiene texto ni datos, y además prohíbe dar fecha. Lia solo puede decir "está en curso" y derivar. **El texto que el equipo escribió en las notas encaja exactamente con `MAIL_15`**: reconoce el retraso, no promete fecha y se compromete a volver en 48 horas.

### Cuando el pedido está dentro de plazo, funciona

En la muestra 2 hay cuatro conversaciones valoradas `good` donde Lia dio la fecha: UQYQSVFYI (`46e3e3ef`), TWSUBBFAR (`b905f887`), YQHODNARE (`95548c60`, `9896a858`) y UCNFVFMKI (`486cc08e`). En las cuatro dice *"expédiée au plus tard le 01/10/2026"* o similar. UQYQSVFYI además nombra el artículo pendiente de reposición.

Así que la Mejora A de la muestra 1 ya está resuelta para los pedidos dentro de plazo. El hueco que queda es `MAIL_15`.

> **Mejora A — la de mayor impacto.**
> 1. **Sembrar el `body` de `MAIL_15`** con el texto de retraso del Anexo A (A.1). Está escrito por el equipo, se repitió cuatro veces y encaja con las prohibiciones que ya tiene la regla.
> 2. **Sembrar el texto de "en stock, sale en 48 horas"** (A.2) en el desenlace correspondiente.
> 3. Revisar si los casos de la muestra 1 que pedían "stock limitado + fecha" eran también `MAIL_15` (EZOYGITYS lo era). Si es así, el punto 1 los cubre.
>
> ⚠️ El texto de A.1 promete *"nous reviendrons vers vous dans un délai de 48 heures ouvrées"*. Esa promesa solo es verdad si alguien del equipo recibe el caso. Ver §9.

---

## 4. Hallazgo 2 — notas internas leídas al cliente (4 conversaciones) — URGENTE

En la muestra 1 se advirtió que el historial que recibe Lia incluye notas internas del equipo. En la muestra 2 **Lia las leyó a clientes**:

| Conversación | Pedido | Lo que dijo Lia | Valoración |
|---|---|---|---|
| `81ac25f9` 24/09 10:56 | LQTQJXTUR | *"C'est une mention laissée par notre équipe : « C13FMK 01N - Délai 07/10/26 déjà indiqué »"* (literal) | `bad` — *"ATTENTION IL DONNE DES INFORMATIONS INTERNE"* |
| `10e1f22e` 24/09 08:06 | LQTQJXTUR | *"Une note interne indique un délai estimé au 7 octobre 2026"* | `bad` (por otro motivo) |
| `2d3ffc5d` 24/09 10:33 | LQTQJXTUR | *"Un message de notre équipe indique […] un délai estimé au 7 octobre 2026"* | sin valorar |
| `e0a88bac` 24/09 08:22 | FTJQSCATF | *"Un message interne de notre équipe mentionne un délai estimé au 09/10/2026"* | `good` ⚠️ |

En `81ac25f9` la clienta preguntó *"où as-tu trouvé ce délai du 7 octobre"*, y Lia respondió citando la nota tal cual.

### Qué llega en el bloque `conversation`

Reproducido en LQTQJXTUR y NQWWBQUNW:

```
author: "SHOP", authorCertain: false, text: "C13FMK 01N - Délai 07/10/26 déjà indiqué"
author: "SHOP", authorCertain: false, text: "07200 - Délai 07/10/26 déjà indiqué"
```

Y en otros pedidos llega también ruido que nunca debería ver el modelo:

- **Registros del medio de pago** marcados como mensaje del cliente: *"Action réalisée avec succès (00) […] Authentification 3DS: SUCCESS […] UUID de transaction: …"* (LUMYVMYVN, MUJJABSBJ).
- **Un teléfono** como mensaje del cliente: *"tel:06…"* (LYVYRWCVB).
- Un **IBAN** completo (JBIZNYEPA, muestra 1).
- Y con esos registros, `awaitingShopReply: true` en pedidos donde nadie está esperando respuesta.

### Lia es inconsistente sobre lo que ve

En `01e0e721` y `b4eaaa2c` el cliente preguntó por sus mensajes con el servicio o por "comentarios privados" en su ficha. Lia contestó *"je n'ai pas accès au contenu des messages échangés"*. **No es cierto**: el historial le llega en cada consulta. La respuesta es segura, pero contradice lo que Lia hace en las cuatro conversaciones de arriba.

### Que lo use bien es posible

El 25/09 (`abf6f731`), para el mismo pedido LQTQJXTUR, Lia respondió *"Comme l'équipe vous l'a déjà indiqué par message le 24 septembre […] un délai de disponibilité prévu pour début octobre 2026"*. Entre medias, el equipo había enviado a la clienta un **mensaje real** (24/09 14:08) con esa información, y Lia lo usó en vez de la nota. Cuando el historial trae un mensaje dirigido al cliente, Lia lo aprovecha bien.

> **Mejora B — urgente, antes de cualquier paso a producción.**
> 1. **Filtrar en la tool** todo lo que no sea un mensaje intercambiado con el cliente: notas internas, registros del pago y datos como teléfonos o IBAN. El documento anterior ya advierte que el flag `private` de PrestaShop no es fiable, así que hay que validar el criterio contra pedidos reales antes de confiar en él.
> 2. **Resumir el historial en hechos** para `facts_to_convey` (fecha ya comunicada al cliente, acción pendiente del cliente), en lugar de pasar los mensajes crudos. Es la Mejora B de la muestra 1, sin cambios.
> 3. **Mientras tanto, una frase en el prompt** junto a las reglas de `order_lookup`: *"NEVER quote, paraphrase or mention internal notes, internal messages or staff comments. Only messages the shop sent TO the customer may be referred to."* Es un parche: la protección real es el punto 1.
>
> **Mejora B′ — criterio de revisión.** `e0a88bac` se valoró `good` diciendo *"un message interne de notre équipe mentionne…"*, y `81ac25f9` se valoró `bad` por lo mismo. Conviene acordar con el equipo que mencionar información interna es siempre `bad`, para que las valoraciones sirvan como señal.

---

## 5. Hallazgo 3 — envío parcial: siempre deriva (2 casos + 1 de la muestra 1)

| Conversación | Pedido | Nota del equipo |
|---|---|---|
| `5539f563` 24/09 07:11 | NQWWBQUNW | texto de envío parcial sin fecha (Anexo A.3) |
| `c0944aa4` 24/09 07:02 | ZCQJGLQSK | texto de envío parcial con fecha de reposición (Anexo A.4) |
| `e4862e65` (muestra 1) | EFUBKXELE | *"livraison partielle — Voir l'historique"* |

En los tres, Lia respondió *"sa situation nécessite l'intervention d'un conseiller humain"*. ZCQJGLQSK se consultó otras dos veces (`81ac25f9`, `eb9e9228`) con la misma respuesta.

**Reproducido en los tres:** estado 14 "Livraison partielle" → grupo C → `ESCALATE` por el **fail-safe de última prioridad** ("cualquier combinación no capturada arriba"). Ninguna regla del grupo C se aplica a estos pedidos.

El documento anterior (§3) espera `MAIL_6` / `MAIL_7` para el grupo C. Con tres de tres pedidos cayendo en el fail-safe, lo más probable es que las filas del grupo C no casen nunca con datos reales. Los tres pedidos tienen líneas con stock 0 y un número de seguimiento, pero `shippedAt: null`: es posible que la regla dependa de alguno de esos datos.

> **Mejora C.**
> 1. Correr `simulate_rules` sobre EFUBKXELE, ZCQJGLQSK y NQWWBQUNW para ver por qué ninguna fila del grupo C gana.
> 2. Sembrar los textos A.3 (sin fecha) y A.4 (con fecha de reposición) como cuerpos de `MAIL_6` / `MAIL_7`.
> 3. El texto A.4 necesita **qué productos** faltan y **su fecha de disponibilidad**. Las líneas con stock 0 ya están en la respuesta de la tool; la fecha solo aparece hoy en notas internas (§4). Hay que sacarla de un dato fiable, no de la nota.

---

## 6. Hallazgo 4 — devoluciones (5 casos)

### 6.1 Retorno en curso: el equipo quiere el mail 8 (2 casos)

| Conversación | Pedido | Muestra |
|---|---|---|
| `7c5a7464` | GGCVEQPUK | 1 |
| `7df749b3` 24/09 08:32 | LYVYRWCVB | 2 |

En los dos, el cliente pregunta por su devolución y Lia dice que no la ve. El equipo pegó en ambas notas **el mismo texto, el mail 8** (Anexo A.5): plazo de 4 días hábiles desde la recepción, confirmación automática por email y contacto si se supera.

Reproducido LYVYRWCVB: estado 10 "Commande Terminée" → `MAIL_3`. La tool responde al estado del pedido, no a la pregunta: **no sabe que le preguntaron por un retorno**.

En la muestra 2, Lia **ya no ofrece el seguimiento del envío de ida** como si fuera el de la devolución (`7df749b3`, `1ead8c25`, `26be3780`). El arreglo de `7edcc2b` funciona.

### 6.2 Retorno recibido, reembolso pendiente (1 caso nuevo)

`26be3780`, MUJJABSBJ. Lia derivó a humano. El equipo quería el texto A.6: *"votre colis de retour a bien été reçu le [Date]. Votre remboursement ou votre code avoir […] est actuellement en cours de traitement"*.

Reproducido: estado 61 "Retour Terminé", pero **todavía sin abono**. `MAIL_12` necesita `processed_date` (la fecha del abono), no la encuentra, y escala: *"Un dato faltante nunca se inventa ni se omite en silencio, se escala (§7.4)"*. El comportamiento de la regla es el correcto; lo que falta es un desenlace para esta situación.

La fecha que pide el texto del equipo está disponible: es la fecha en que el pedido pasó al estado 61 (24/09 09:59 en el historial de estados).

### 6.3 Colis refusé (muestra 1)

`4eecbe00`, RYOTSAWVN. El dato vive en un módulo de PrestaShop que la tool no lee. Sin cambios.

Relacionado: en `1ead8c25` (LEOTDSAHW) Lia explicó correctamente una devolución **rechazada** por el embalaje, con el seguimiento del reenvío. Lo sacó del historial, que en ese caso contenía el mensaje real del equipo al cliente.

> **Mejora D.**
> 1. **Estado 61 sin abono → nuevo desenlace** con el texto A.6, usando como fecha la del paso a estado 61. Hoy escala.
> 2. **Pregunta por un retorno en pedido no devuelto → mail 8** (A.5). Hace falta que la tool sepa que la pregunta es sobre un retorno. Opciones: un parámetro `topic: "return"` en `order_lookup`, o que Lia use el mail 8 cuando la pregunta es de retorno y el estado no es 61. La primera es más robusta.
> 3. Averiguar dónde guarda su dato el módulo "Colis refusé" (sin cambios desde la muestra 1).

---

## 7. Hallazgo 5 — deriva en estados con respuesta (muestra 1, sin cambios)

- `32571766`, JBIZNYEPA: estado 83 "Remboursé avec Sogecommerce" → grupo D → escala, aunque la tool tiene el reembolso completo. Nota: *"remboursé par moyen de paiement"*.
- `1d48a586`, XQXBSHEIW: *"c'est quoi COMMANDE TERMINÉ"*. Sin reproducir.

> **Mejora E.** Mapear los estados 83, 7 y 68 (160 pedidos en agosto-septiembre) con una plantilla de reembolso, en vez de escalar. Contradice el §4 del documento anterior.

---

## 8. Hallazgo 6 — texto fuera del formato de respuesta (16 de 62)

| Tipo | M1 | M2 |
|---|---|---|
| Frase antes del JSON | 5 | 7 |
| JSON envuelto en un bloque de código | 1 | 3 |

Los casos de la muestra 2: `5539f563`, `b905f887`, `95548c60`, `486cc08e`, `10e1f22e`, `2d3ffc5d`, `a09d4997`, `01e0e721`, `9896a858`, `e0a88bac`.

**Corrige lo que decía este documento el 23/09.** Se afirmó que todos los casos eran primeros turnos sin llamada a una tool. La muestra 2 lo desmiente: `e0a88bac` ocurre **después** de consultar el pedido, y `9896a858` y `01e0e721` en turnos intermedios.

Y aparecen dos variantes más graves:

- **`e0a88bac` — razonamiento interno visible.** Antes del JSON, Lia escribió: *"Hmm, le résultat de l'outil ne contient pas de `facts_to_convey` renseignés, et la situation est **MAIL_15**. […] Le stock des deux articles est à 0 (`stockQuantity: 0`, `covered: true`)"*. Expone nombres internos de la configuración y datos del stock.
- **`01e0e721` — autocorrección visible:** *"Wait, I need to respond in JSON format."* en inglés, seguido del JSON.

No se sabe todavía qué ve el cliente en el widget. Si la plataforma muestra el texto previo al JSON, `e0a88bac` es una fuga de información interna igual de seria que las del §4.

> **Mejora F.** Reproducir `e0a88bac` en el widget.
> - **Si el texto previo se ve:** es un fallo de plataforma (la extracción debería descartar todo lo que no sea el JSON) y se escala a desarrollo con este caso como ejemplo. No se arregla desde el prompt, que ya lo prohíbe tres veces.
> - **Si no se ve:** baja a prioridad baja. Aun así conviene medirlo: supone 1 de cada 4 conversaciones.

---

## 9. Hallazgo 7 — "je viens de transmettre votre demande" (1 caso)

En `81ac25f9` el equipo propone como respuesta correcta:

> *"Afin de pouvoir vous confirmer le délai d'expédition, je viens de transmettre votre demande à notre service. Je reviendrai vers vous dans un délai de 24 heures ouvrées"*

Y el texto de retraso (A.1) promete volver en 48 horas.

**Hoy Lia no transmite nada a nadie.** No hay derivación registrada en ninguna de las 62 conversaciones: "derivar" consiste en decirle al cliente que escriba al formulario. Si Lia usa esos textos tal cual, promete algo que nadie va a cumplir.

> **Mejora G — decisión de negocio, bloquea A.1.** Dos opciones:
> 1. **Crear una derivación real** (un ticket en el servicio de clientes o un traspaso a humano en DatiHub) en los desenlaces que prometen seguimiento. Es la que hace verdaderos los textos del equipo.
> 2. **Adaptar los textos** para que no prometan contacto: *"contactez notre service…"* en lugar de *"nous reviendrons vers vous"*.
>
> Se recomienda la 1: es lo que el equipo espera que ocurra, y la 2 degrada la experiencia justo en los clientes con un retraso.

---

## 10. Otros hallazgos

### 10.1 Referencias numéricas — 7 casos (3 + 4)

Nuevos en la muestra 2: `708822` (`721c0860`), `707823` (`d94430f6`), `685949` (`a09d4997`), `694226` (`b4eaaa2c`).

**Confirmado que es el id del pedido:** la reproducción de ZKHRPZKYY devuelve `id: 708822`, el mismo número que escribió la clienta. Y el equipo lo usa en sus correos (*"votre commande n°706653"*).

En `721c0860` Lia llegó a llamar a la consulta **pasando `708822` como email**. La tool no devolvió nada (la puerta de identidad aguantó), pero es una violación directa del prompt.

> **Mejora H.** Que la tool acepte el id numérico con la misma exigencia de email. Y que valide el formato del email antes de consultar.

### 10.2 Idioma y registro

- **Inglés sin señal de idioma:** 3 casos en la muestra 1, ninguno en la 2 (todos los primeros mensajes de la muestra 2 tenían texto en francés).
- **Tuteo:** en `5539f563` Lia tuteó a la clienta (*"ta commande"*, *"Je te invite"*, con falta gramatical incluida). Es el único caso de 62, pero para una tienda francesa el tuteo con un cliente es un error de tono evidente.

> **Mejora I (prompt, dos frases).** En las reglas de idioma: *"If the first message has no language signal (only a reference, an email or a number), use French."* y *"In French, ALWAYS address the customer with 'vous', never 'tu'."*

### 10.3 Fechas probablemente desplazadas dos horas

ZKHRPZKYY tiene `dateAdd: 2026-09-24T08:23:20Z`, pero la clienta preguntó por él a las **06:40:54Z**, casi dos horas antes de que "existiera". La explicación más probable es que PrestaShop guarda la hora de París (UTC+2) y la tool la etiqueta como UTC.

**Inferido**, con un solo caso. Si se confirma, afecta a todas las fechas que calcula el motor (plazos, "al más tardar") en los pedidos hechos cerca de medianoche.

> **Mejora J.** Comprobar la zona horaria de las fechas de PrestaShop contra un pedido cuya hora real se conozca.

### 10.4 Pedidos de Amazon

En `552ed281` el email del pedido era una dirección de Amazon Marketplace (`…@marketplace.amazon.fr`). Lia respondió con normalidad. Hay que confirmar con el equipo si los pedidos de marketplace deben atenderse por este canal.

### 10.5 Consulta innecesaria en el primer turno

9 casos en la muestra 1 (`store_policies` con el tema `company` antes de pedir el email). En la muestra 2 no aparece. Sin acción.

---

## 11. Lo que funciona bien

- **La puerta de identidad aguantó en las 62.** Nunca dio datos sin referencia y email válidos. En `b4eaaa2c` el cliente dio solo el email y pidió "todos mis pedidos": Lia se negó y pidió una referencia. En `721c0860` pasó un número como email y la tool no devolvió nada.
- **No inventa datos del pedido**, ni ante el fallo técnico ni con `facts_to_convey` vacío.
- **Pedidos dentro de plazo: bien resueltos.** Fecha máxima de expedición, artículo en reposición, punto de recogida (§3).
- **Retornos terminados con abono y seguimientos en curso: bien resueltos** (SGWJZMJHU, KWBWZJQXY, YWXEBKYBH, YFXBUMDXI, MFQMNVXYJ).
- **El arreglo del tracking de ida funciona** (§6.1).
- **Pruebas fuera de tema** (`7d2f9295`, `9bd3f2f7`, `b4eaaa2c`, `2e6ea649`): lingerie para sirenas, ropa lavada con ketchup, propuestas de matrimonio, coqueteo insistente. Lia mantuvo el humor sin salir de su papel y devolvió la conversación a la tienda. En `9bd3f2f7` respondió a una pregunta de devolución con la política correcta, consultándola. Un matiz: en `2e6ea649`, ante un coqueteo insistente, terminó con *"vous ne serez pas déçue 😏"*. Es un tono más juguetón de lo que conviene a una marca de lencería; se puede afinar si el equipo lo considera necesario.

---

## Resumen de mejoras, por prioridad

| # | Mejora | Casos | Capa | Bloqueada por |
|---|---|---|---|---|
| **B** | **Filtrar notas internas, registros de pago y datos personales del historial** (+ frase de prompt como parche) | 4 fugas | Tool + prompt | — |
| **A** | Texto de `MAIL_15` (retraso) y de "en stock, 48 h" | 12 | Plantillas | Mejora G para A.1 |
| **G** | Derivación real cuando el texto promete volver al cliente | — | Plataforma / negocio | Decisión del equipo |
| **C** | Grupo C (envío parcial): por qué cae en el fail-safe + textos A.3 / A.4 | 3 | Reglas + plantillas | `simulate_rules` |
| **D** | Retornos: estado 61 sin abono (A.6) y mail 8 para retornos en curso (A.5) | 5 | Reglas + tool | Tema de la pregunta en la tool |
| **F** | Texto fuera del JSON, incluido razonamiento interno: comprobar en el widget | 16 | Plataforma | Reproducción |
| **E** | Estados de reembolso con plantilla en vez de escalar | 2 (160 pedidos) | Reglas | Texto de la plantilla |
| **H** | Aceptar el id numérico; validar el formato del email | 7 | Tool | — |
| **I** | Francés por defecto y "vous" siempre | 4 | Prompt | — |
| **J** | Zona horaria de las fechas | 1 | Tool | Verificación |
| **B′** | Criterio común de revisión sobre información interna | — | Equipo | — |
| — | Aclarar "notification zimbra" (muestra 1) y los pedidos de Amazon | — | Equipo | Respuesta del equipo |

Todo esto va **después** del redespliegue (Mejora 0 del documento anterior).

### Pendiente para cerrar el diagnóstico

- Reproducir **XQXBSHEIW** y **GGCVEQPUK** (muestra 1).
- `simulate_rules` sobre los tres pedidos de envío parcial (§5).
- Reproducir `e0a88bac` en el widget (§8).

---

## Anexo A — textos que el equipo escribió en las notas de revisión

Transcritos literalmente. Los corchetes son marcadores del propio equipo.

### A.1 — Retraso: plazo de preparación superado

Notas de `18b3611c`, `9944442e`, `10e1f22e` y `8e8cb91d` (idénticas). Candidato a cuerpo de `MAIL_15`.

> Bonjour,
>
> Nous sommes malheureusement au regret de vous informer que le délai de préparation initialement annoncé pour votre commande est désormais dépassé. Nous vous présentons nos sincères excuses pour ce retard et pour la gêne occasionnée.
> Afin de vous communiquer une information précise, nous avons relancé notre service logistique afin d'obtenir une nouvelle estimation du délai de préparation et d'expédition de votre commande.
> Nous reviendrons vers vous dans un délai de 48 heures ouvrées, hors week-ends et jours fériés, afin de vous communiquer le nouveau délai et de vous tenir informé(e) de l'avancement de votre commande.
> Nous vous remercions sincèrement pour votre patience, votre compréhension et votre confiance.

### A.2 — En preparación, todo en stock

Nota de `721c0860`.

> Bonjour, Nous vous remercions pour votre commande est en cours de traitement. Celle va être expédiée sous 48 heures (hors week-end et jours fériés). À l'expédition de votre commande, un mail de notre partenaire (Socolissimo La Poste ou Chronopost) vous sera transmis pour suivre l'acheminement de votre colis. Nous vous remercions pour votre confiance et vous souhaitons une bonne reception de votre commande.

(El texto tiene erratas en el original: *"pour votre commande est"*, *"Celle va"*. Hay que corregirlas antes de sembrarlo.)

### A.3 — Envío parcial, sin fecha de reposición

Nota de `5539f563`.

> Bonjour,
>
> Votre commande a fait l'objet d'une expédition partielle. Vous trouverez le lien de suivi ci-dessous.
> (Lien de suivi)
> Vous recevrez prochainement un e-mail vous indiquant les produits qui ont été expédiés ainsi que ceux restant à expédier.
>
> Nous vous remercions pour votre patience et votre compréhension.

### A.4 — Envío parcial, con fecha de reposición

Nota de `c0944aa4`.

> Bonjour,
>
> Votre commande a fait l'objet d'une expédition partielle. Vous trouverez le lien de suivi ci-dessous.
> (Lien de suivi)
> En effet, le(s) produit(s) ,,, de votre commande ont fait l'objet d'un report et disposent d'une nouvelle date de disponibilité prévue le [..].
>
> Dès réception du réassort, nous procéderons à l'expédition du reliquat de votre commande en priorité.
>
> Nous vous remercions pour votre patience et votre compréhension.

### A.5 — Retorno aún no tratado (mail 8)

Notas de `7c5a7464` (muestra 1) y `7df749b3` (idénticas).

> Bonjour,
> Après vérification, nous constatons que votre colis retour n'a pas encore été traité par notre service retours.
> Si le suivi de votre colis indique qu'il a bien été livré, soyez rassuré(e) : le délai de traitement des retours est de 4 jours ouvrés, hors week-ends et jours fériés, à compter de sa réception par notre service.
>
> Dès que votre retour aura été traité, vous recevrez automatiquement une confirmation par e-mail.
>
> Si plus de 4 jours ouvrés se sont écoulés depuis la réception de votre colis, nous vous invitons à contacter notre service après-vente afin que nous puissions vous accompagner au mieux :
> serviceclients@mesdessous.fr
> Nous vous remercions pour votre patience et votre compréhension.

### A.6 — Retorno recibido, reembolso en curso

Nota de `26be3780`.

> Bonjour,
>
> Après vérification, nous vous confirmons que votre colis de retour a bien été reçu le [Date].
> Votre remboursement ou votre code avoir, selon l'option que vous avez choisie, est actuellement en cours de traitement.
> Le traitement sera effectué dans un délai maximum de 7 jours après la réception et la vérification de l'état de vos articles.

### A.7 — Transmisión al servicio (requiere la Mejora G)

Nota de `81ac25f9`.

> Bonjour,
>
> J'ai bien retrouvé votre commande, passée le [date].
>
> Statut actuel : [statut]
>
> Votre commande est actuellement en cours de préparation par nos services et doit prochainement être expédiée.
>
> Afin de pouvoir vous confirmer le délai d'expédition, je viens de transmettre votre demande à notre service,
>
> Je reviendrai vers vous dans un délai de 24 heures ouvrées, hors week-ends et jours fériés,
