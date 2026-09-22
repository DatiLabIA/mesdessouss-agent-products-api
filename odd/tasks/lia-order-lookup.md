# lia-order-lookup

## Objetivo

Dar a Lia (vía DatiHub) la capacidad de consultar pedidos con **una sola llamada** al
microservicio. El microservicio hace todas las consultas a PrestaShop, las consolida y
devuelve los hechos que Lia necesita para redactar la respuesta al cliente.

## Problema

Hoy no existe integración con el webservice de PrestaShop. Además, una auditoría sobre
7 pedidos reales demostró que los campos obvios mienten: `current_state` falló en 4 de
5 casos, el flag `private` de los mensajes es inservible, y el stock de una línea no se
lee como uno esperaría porque el pedido ya lo descontó.

## Por qué

Sin esto, cualquier consulta de pedido se deriva a un humano. Con esto, Lia responde
con datos verificados y escala solo cuando corresponde.

## Alcance autorizado (esta tanda)

Solo la **capa de acceso y la validación de identidad**. El motor de reglas y el
payload consolidado esperan a que se resuelva el acceso a `order_return`.

- Cliente HTTP de PrestaShop con reintentos y whitelist de campos.
- Validación de identidad: referencia como filtro de búsqueda, email como puerta.

**Fuera de alcance:** motor de reglas, plantillas de mails, bloque RETORNO, endpoint
HTTP público, handler de Express.

## Decisiones cerradas

| Decisión | Razón |
|---|---|
| Order-first: se busca por `reference`, nunca por email | Filtrar por email convierte el endpoint en un oráculo de "este email es cliente nuestro" |
| Email solo valida, no busca | Es una protección básica de entrega de datos, no un criterio de búsqueda |
| Normalización de email: `trim` + `toLowerCase`, nada más | Quitar puntos de Gmail o plus-addressing ampliaría el match y validaría pedidos ajenos |
| Conjunto válido = email de cuenta ∪ emails de los hilos **de ese pedido** | El cliente que cambió de correo sigue siendo el dueño (verificado: pedido 93686 tiene hilos con dos emails distintos) |
| Respuesta negativa uniforme | Nunca distinguir "referencia inexistente" de "email no coincide": con una referencia filtrada se enumerarían datos personales (RGPD) |
| 200 con cuerpo vacío → reintento, luego `SERVICE_UNAVAILABLE` | Verificado: la API devuelve 200 vacío de forma intermitente. Jamás interpretarlo como "no coincide" ni saltarse la validación |
| Whitelist obligatoria en `customers` | Sin `display=[...]` expone `passwd`, `secure_key`, `reset_password_token` |
| Más de un pedido por referencia → escalar | 0 duplicados en 6.263 pedidos, pero la API devuelve array y PrestaShop puede partir pedidos |

## Modo TDD

**Desactivado al empezar**, porque `package.json` no declaraba ningún runner.
La revisión RDD marcó esa ausencia como CRITICAL y la corrección añadió uno:
el runner nativo de Node (`node:test` vía `tsx --test`), sin dependencias nuevas.
El modo sigue siendo no-TDD (los tests se escribieron después del código, no antes),
pero a partir de aquí las tareas nuevas sí tienen runner disponible.

## Verificación

- `pnpm build` (tsc: typecheck + build)
- `pnpm test` (`tsx --test "src/**/*.test.ts"`)

## Tareas

- [x] **T1** — `src/lib/prestashop-client.ts`: cliente HTTP base (Basic Auth,
  `output_format=JSON`, `display` whitelist, construcción de filtros, reintentos con
  backoff, detección de 200 vacío, errores tipados, timeout).
  Ruta: delegada (writer). Trigger: regla de escritura, 2+ ficheros no triviales.
- [x] **T2** — `src/lib/order-identity.ts`: `lookupOrderByReference` +
  `verifyOrderIdentity`, flujo order-first, normalización de email, conjunto válido
  cuenta ∪ hilos del pedido, respuesta negativa uniforme.
  Ruta: delegada (writer, misma tanda que T1).
- [x] **T3** — `src/types/index.ts`: tipos de entrada/salida de la validación.
  Ruta: delegada (writer, misma tanda).
- [x] **T4** — `.env.example`: `PRESTASHOP_API_URL`, `PRESTASHOP_API_KEY`.
  Ruta: inline (una línea mecánica).

## Hallazgo durante la verificación

El writer entregó `pnpm build` en verde, pero la revisión del padre encontró un fallo
que el typecheck no podía ver y que habría roto la funcionalidad entera en silencio:

**`display=[...]` cambia la forma de la respuesta de un recurso individual.**

| Petición | Respuesta |
|---|---|
| `customers/27794` | `{"customer": {…}}` → objeto, clave singular |
| `customers/27794?display=[id,email]` | `{"customers": [{…}]}` → **array**, clave plural |

`getOne` usaba un extractor que descartaba arrays explícitamente, devolvía `null` y
lanzaba `PrestashopNotFoundError`. En `verifyOrderIdentity` ese error caía en la rama
de "no encontrado" y retornaba `IDENTITY_NOT_VERIFIED`: **todo cliente legítimo habría
sido rechazado**, sin excepción y sin error visible, porque el llamador lo leía como un
resultado de negocio normal. Y lo disparaba justamente la whitelist, que es obligatoria.

Corregido con `extractSingle`, que acepta las dos formas. Verificado contra la API real.

## Verificación ejecutada

- `pnpm build` → exit 0, sin errores.
- Prueba funcional contra la API real, 6 casos:

| Caso | Resultado |
|---|---|
| Email de cuenta correcto | `VERIFIED` |
| Mismo email en mayúsculas | `VERIFIED` |
| Referencia en minúsculas | `VERIFIED` |
| Email ajeno | `IDENTITY_NOT_VERIFIED` |
| Referencia inexistente | `IDENTITY_NOT_VERIFIED` |
| Referencia mal formada | `IDENTITY_NOT_VERIFIED` |

Los tres negativos devuelven un objeto con **una sola clave** (`outcome`): referencia
inexistente y email ajeno son indistinguibles desde fuera, que es el criterio 4.

## Criterios de aceptación

1. `pnpm build` pasa sin errores de tipos.
2. Ninguna ruta del código llama a `customers` sin `display=[...]`.
3. Un 200 con cuerpo vacío nunca produce `IDENTITY_NOT_VERIFIED`.
4. El resultado negativo no contiene la referencia, el email ni dato alguno del pedido.
5. La clave del webservice se lee de entorno, nunca literal en el código.

## Corrección exigida por la revisión RDD

La revisión (lineage `review-6f6de8fdd46f7678`, lente `review-reliability`, riesgo
medio) devolvió dos hallazgos CRITICAL, ambos aceptados y corregidos:

**`R3-module-load-throw`** — `src/lib/prestashop-client.ts`. El guard de la API key
lanzaba al evaluar el módulo, así que cualquier import de `order-identity` reventaba
el proceso antes de ejecutar nada, y el alcance del fallo dependía del orden de los
imports en vez de si el cliente llegaba a usarse. Corregido con un accesor diferido y
memoizado (`getAuthHeader`), que comprueba en la primera petición. Sigue siendo
fail-closed y ahora el error es atribuible al punto de uso. Nuevo `PrestashopConfigError`,
no transitorio, que `performRequest` propaga sin reintentar.

**`R3-no-automated-tests`** — `src/lib/order-identity.ts`. La ruta que decide si a un
cliente se le entrega o se le niega su pedido no tenía ni un test. Los criterios 3 y 4
estaban probados solo por un transcript manual que no se puede volver a correr.
Añadidos 9 tests con el runner nativo de Node y `fetch` stubeado, sin dependencias nuevas.

Los tests fijan además la regresión de `display=[...]`: el stub de `customers` devuelve
la forma de array real, así que si alguien revierte `extractSingle` el test falla.

### Segunda ronda de revisión (lineage `review-4d1861ed215a880a`)

Dos hallazgos CRITICAL más, ambos aceptados y corregidos:

**`R3-threads-notfound-denies-legit-customer`** — si solo fallaba la lectura de hilos
con 404, `rejections.every(...)` era trivialmente cierto con un único rechazo y se
devolvía `IDENTITY_NOT_VERIFIED`, descartando el email de cuenta ya resuelto que sí
coincidía. Mismo patrón de fallo silencioso que el bug de `display`: si
`customer_threads` no estuviera expuesto por permisos del webservice, todo cliente
legítimo quedaría rechazado y el llamador lo leería como veredicto de negocio.
Corregido con un triaje asimétrico: la cuenta es decisiva, los hilos solo amplían el
conjunto válido y su 404 degrada en silencio.

**`R3-timeout-escapes-outcome-contract`** — `PrestashopTimeoutError` era clase hermana
de `PrestashopUnavailableError`, así que tras agotar los reintentos escapaba como
excepción en vez de resolverse a `SERVICE_UNAVAILABLE`, rompiendo el contrato de
retorno justo donde la invariante de "un transitorio nunca niega la identidad" debía
sostenerse. Ahora es subclase, y todo `instanceof PrestashopUnavailableError` lo cubre.

Cobertura ampliada de 9 a 14 tests, incluidos el 404 en hilos y el timeout real
(simulando el `TimeoutError` que lanza `fetch` al abortar).

## Progreso

T1–T4 completadas y verificadas. Los 5 criterios de aceptación se cumplen.
Corrección de la revisión aplicada. Alcance de esta tanda cerrado.

---

# Fase 2 — Motor de reglas

## Decisiones tomadas

**Alcance del bloque RETORNO.** Se arranca solo con lo que la API ya expone; no se
construye el módulo que expondría `order_return`. Medido sobre el 1–22 de septiembre:
de 467 pedidos con devolución, 380 tienen avoir **sin** movimiento de stock (y 137 de
180 muestreados están en estado 61, o sea devoluciones reales y cerradas), mientras que
13 de los 15 "movimiento sin avoir" son pedidos **anulados**. Conclusión: el motivo 10
"Retour produit" no significa "llegó el paquete del cliente" y cubre un tercio de los
casos. De los 5 mails de retorno, solo el **mail 12** es implementable, vía
`current_state = 61` más la fecha del avoir. El resto escala.

**Las reglas viven en base de datos**, editables por MCP sin desplegar. Lo que NO va a
base de datos y nunca debe ir: el cálculo de los hechos (stock, días hábiles, marcas
afectadas) y el fail-safe "ninguna regla matchea → escalar". Eso es código con tests.

**Por qué es seguro meter la matriz en la base.** El §4 del documento ya es una tabla de
verdad cerrada de 13 filas. Cada condición es un enum cerrado o `NULL` = "cualquiera".
No hay expresiones ni operadores: una fila mala solo puede elegir un mail equivocado,
nunca ejecutar comportamiento arbitrario, y el fail-safe en código degrada a escalar.

**Ciclo de vida de edición.** No existe ninguna tool que edite el conjunto activo:
se clona a borrador, se edita, se simula contra pedidos reales y recién ahí se publica
con `confirm`. Quien va a editar es un modelo, no una persona llenando un formulario.

## Hallazgo: las migraciones no llegaban a producción

`prisma/migrations/` estaba en `.gitignore` (línea 16) con cero ficheros trackeados,
mientras `start:prod` ejecuta `prisma migrate deploy`, que aplica las migraciones **del
repositorio**. No había ninguna: ese comando no aplicaba nada y el esquema de producción
se mantenía por otra vía. Cualquier tabla nueva habría quedado en una carpeta ignorada.

Corregido: se versiona `prisma/migrations/` (las migraciones son código fuente).

**Sin aplicar todavía.** `DATABASE_URL` apunta a un host remoto compartido
(`b51gvf.easypanel.host`) y ya tenía `20260831000000_add_category_kind` pendiente de
antes. La migración se generó con `prisma migrate diff` sin tocar la base. Aplicarla es
decisión del usuario: `pnpm migrate:deploy`.

## Corrección exigida por la revisión (lineage `review-6c5160bccd7e3f1b`)

**`R3-partial-index-drift`** — el índice parcial `rule_sets_one_active_per_client`
existía solo como SQL suelto en la migración, y el esquema no lo describía. Prisma
compara el esquema contra la base migrada, así que lo habría tratado como sobrante y
la siguiente migración habría generado su `DROP`: la única garantía de "un solo
conjunto activo" desaparecía en silencio. Corregido moviéndolo al esquema con el
soporte nativo de índices parciales de Prisma 7 (`where` en `@@unique`), que es
preview feature y requiere `previewFeatures = ["partialIndexes"]`. Ahora el motor de
diff lo conoce y lo emite él mismo.

**`R3-nonidempotent-baseline`** — parcialmente corregido, y a propósito:

- La migración del motor de reglas (aún sin aplicar en ningún lado) pasó a DDL
  idempotente: 7 tablas y 12 índices con `IF NOT EXISTS`, y las 5 claves foráneas
  envueltas en bloques que ignoran el duplicado, ya que Postgres no admite
  `IF NOT EXISTS` en `ADD CONSTRAINT`.
- **No se tocaron las tres migraciones no idempotentes ya aplicadas.** Prisma guarda
  un checksum de cada migración aplicada; editarlas arriesga romper el despliegue de
  una base que hoy funciona, a cambio de un escenario que se resuelve con
  `prisma migrate resolve --applied`. El procedimiento quedó documentado en
  `prisma/migrations/README.md`.
- Verificado con `prisma migrate status`: la base remota ya tiene aplicadas las 7
  primeras, así que ahí el historial está baselineado y el riesgo es latente, no actual.

## Tareas

- [x] **T5** — Esquema Prisma del motor de reglas + migración `20260921000000_add_rules_engine`.
  7 tablas: `rule_sets`, `rule_state_groups`, `rule_brand_lead_times`, `rule_decisions`,
  `rule_templates`, `rule_settings`, `rule_holidays`. Incluye índice único parcial
  `rule_sets_one_active_per_client` (Prisma no sabe expresarlo) para que la base garantice
  como máximo un conjunto activo. Ruta: inline, diseño resuelto en conversación.
- [x] **T6** — Siembra desde `docs/reglas-lia-pedidos-retornos.md`: 13 filas de matriz,
  44 marcas normalizadas (41 del documento + 3 submarcas reales del catálogo),
  mapeo de estados por ID, 9 plantillas y 3 ajustes. Ruta: delegada (writer).
- [x] **T7** — Cálculo de hechos: grupos de estado, stock por línea (`quantity >= 0`),
  marcas afectadas, días hábiles con festivos FR, retraso. Ruta: delegada (writer).

### Dos fallos en la costura entre T6 y T7

Las dos tareas corrieron en paralelo y cada una quedó correcta por separado. Los
problemas vivían justo en el medio, donde ninguno de los dos writers podía verlos:

**`normalizeBrandKey` duplicada.** La siembra se escribió una copia privada para no
acoplarse a una tarea en curso. Eran idénticas byte a byte, pero si alguna vez
divergen, las claves sembradas dejan de casar con las que calcula el runtime y
**todas** las marcas pasan a desconocidas, escalando cada pedido sin stock. Unificada:
la siembra importa de `src/lib/brand-normalize.ts`, una sola fuente.

**`DelayBucket` con dos vocabularios.** Los hechos producen `NONE|SHORT|LONG`; la
matriz siembra dos filas con `POSITIVE`. Con una comparación por igualdad, las filas 6
y 7 del §4 no matchearían nunca y un pedido sin stock **y atrasado** caería al
fail-safe: escalaría en vez de recibir el mail 15. Resuelto con `matchesDelayBucket`
en `order-facts.ts`, que traduce la condición al hecho, más el tipo
`DelayBucketCondition` como superconjunto explícito. El evaluador (T8) debe usar esa
función y nunca `===`.

Ambas quedan fijadas por `src/data/order-rules-seed.test.ts`, que además verifica que
ninguna fila sea inalcanzable, que las prioridades sean únicas, que el cajón de sastre
no lleve condiciones, que todo desenlace tenga plantilla y que los grupos de estado
sean los IDs verificados contra PrestaShop.

### Pendiente de fuente externa

Los `body` de 8 de las 9 plantillas están vacíos. Los textos viven en
`scenario_lia.numbers` (hoja Feuil2), que no está en el repositorio. Solo el del mail 4
se pudo sembrar, porque el §6 del documento lo transcribe completo. No se inventó texto
comercial en francés. `factsToConvey` y `mustNotClaim` sí están sembrados para las nueve,
que es lo que Lia necesita para redactar.
- [x] **T8** — Evaluador de la matriz + fail-safe en código + bloque `guidance`.
  Ruta: delegada (writer). 47 tests nuevos, incluida una batería con un caso por
  cada una de las 13 filas del §4, usando la siembra real y no un fixture aparte.

### Contradicción del documento resuelta en T8 — pendiente de confirmar con el cliente

El §3.1 dice, en su nota de aplicación: *"En el Grupo B el estado de stock es
irrelevante: una vez expedido el pedido, siempre es mail 3."* Pero la fila 13 del §4
dice *"estado: cualquiera | SIN_STOCK | marca desconocida → Escalar"*. Las dos no
pueden ser ciertas a la vez.

**Se implementó el §3.1**: las cuatro comprobaciones de stock del fail-safe (marca
desconocida, stock indeterminable, línea sin stock sin marca, y falta de plazo fiable)
aplican **solo al grupo A**. El grupo D escala siempre, sin excepción.

Razón: el plazo de marca existe para calcular una fecha de expedición. En un pedido ya
expedido esa fecha ya ocurrió, así que una marca desconocida no puede cambiar la
respuesta. Aplicar la fila 13 a todos los grupos escalaría pedidos perfectamente
contestables — los que ya tienen número de seguimiento, que son la consulta más
frecuente — por un dato que nadie va a usar. Y no es hipotético: en el pedido SURVHLYRI
una combinación no tenía fila de `stock_available`, y hay dos marcas del catálogo
(Mariner, MesDessous) que siguen sin plazo definido.

El writer detectó la tensión y, correctamente, no la resolvió por su cuenta. Fijado con
6 tests en `rule-evaluator.test.ts`. Revertirlo es una línea si el cliente prefiere la
lectura literal de la fila 13.
- [x] **T9** — Consolidación: todas las consultas a PrestaShop en una sola llamada,
  en tres olas paralelas. Ruta: delegada (writer) + correcciones del padre.

### Cinco fallos que la suite en verde no veía

El writer entregó 120/120 tests y build limpio. Una comprobación end-to-end contra la
API **real** encontró cuatro bugs, todos con la misma causa raíz, y un quinto de
distinto origen. Los tests unitarios stubean `fetch`, así que solo prueban lo que
creemos que devuelve la API, no lo que devuelve.

**Causa raíz, verificada**: PrestaShop serializa el campo `id` como **número** y todos
los demás campos `id_*` como **string**, en la misma respuesta.

```
orders.id            -> int 705570      order_details.product_id  -> str '63242'
products.id          -> int 63242       stock_availables.id_product -> str '63242'
orders.current_state -> str '61'
```

Por eso `producto.id === linea.product_id` compara `63242` contra `"63242"` y da falso
**siempre**. Sin excepción, sin log: solo un resultado vacío que parece legítimo.

1. **Join de marcas muerto** → todas las líneas con `brand: null`, y con eso la tabla de
   44 plazos quedaba sin usarse nunca.
2. **URL de seguimiento en `null`** → el mapa de transportistas se indexaba por `id`
   numérico y se consultaba con `id_carrier` string. El mail 3 depende enteramente de
   ese dato.
3. **`return.completed` siempre false** → `"61" === 61`.
4. **Nombre del estado crudo** → los campos traducibles no son strings sino arrays
   `[{id:"1",value:"Retour Terminé"},…]`. Viajaba el array entero al payload.

Corregido normalizando en la frontera: `toNumericId` en `order-identity.ts` (donde
nacía la mentira de tipos) y en cada cruce de la consolidación, más
`resolveTranslatable` para los campos multiidioma.

**5. `MAIL_12` era inalcanzable.** El estado 61 no estaba en ningún grupo, caía en D y
escalaba; y no había ninguna fila de matriz que produjera ese desenlace. La plantilla
estaba sembrada sin ninguna forma de llegar a ella — justo el único mail de retorno que
habíamos decidido implementar. Resuelto añadiendo el grupo `R` (el §3.2 es un árbol
aparte del §4) con una fila de prioridad 0, que sigue siendo dato editable por MCP.

### `pnpm check:pipeline`

La comprobación end-to-end quedó como herramienta del proyecto:
`pnpm check:pipeline <REFERENCIA> <EMAIL>`. Es lo único que caza esta clase de fallo.
Verificado sobre pedidos reales:

| Pedido | Estado | Veredicto |
|---|---|---|
| LLKVUZDZD | 61 Retour Terminé → grupo R | `MAIL_12` con `processed_date: 16/09/2026` |
| KKWNDFPHA | 10 Commande Terminée → grupo B | `MAIL_3` con referencia y URL de seguimiento resueltas |
- [x] **T10** — Tools MCP de reglas (lectura, borrador, simulación, publicación, rollback).
  Ruta: delegada (writer). `pnpm build` y `pnpm test` en verde (150/150; 120
  preexistentes + 30 nuevos). Sin ejecutar nada contra la base.
- [x] **T11** — Handler Express + ruta `POST /order_lookup`. Ruta: delegada (writer)
  + corrección del padre.

### Un 500 que debía ser 503

Los tests con `fetch` y Prisma dobles daban 163/163. Al ejercitar el handler con sus
**dependencias reales** —el camino de import dinámico que ningún test ejecutaba— el
resultado fue **HTTP 500**, no el 503 que exige el criterio.

Causa: `loadActiveRuleSet` lanza un error de conexión de Prisma, que no es
`RuleSetNotFoundError` ni `RuleSetValidationError`. Enumerar clases de error dejaba
escapar justamente el fallo más probable, y reportaba un problema de infraestructura
como si fuera un bug de nuestra lógica.

Corregido: **cualquier** fallo al obtener las reglas responde 503. Sin reglas no se
puede contestar, y la causa nunca es del cliente que pregunta — base inalcanzable,
migración sin aplicar o pool agotado son el mismo caso operativo. El 500 se reserva
para lo que de verdad es inesperado, con un test propio que lo cubre (un error
funcional de la API en la consolidación) verificando que no filtra detalle interno.

Verificado contra el entorno real, con la base caída:

| Petición | HTTP | Cuerpo |
|---|---|---|
| Sin `email` | 400 | campos obligatorios |
| Email ajeno | 200 | `{found:false, identity_verified:false, outcome:"IDENTITY_NOT_VERIFIED"}` y nada más |
| Completa, sin reglas activas | 503 | reglas no configuradas |

## Estado final de la fase 2

Las 11 tareas cerradas. `pnpm build` en verde, **164 tests** en verde.

### Desplegado

- [x] **Migración aplicada** (22/09/2026): `add_category_kind` y `add_rules_engine`.
  Verificado: las 7 tablas existen y el índice único parcial
  `rule_sets_one_active_per_client` quedó creado con su cláusula `WHERE status='active'`.
- [x] **Reglas sembradas**: RuleSet v1 en `draft` — 10 grupos de estado, 44 marcas,
  14 filas de matriz, 9 plantillas, 3 ajustes, 44 festivos.
- [ ] **Activar**: decisión deliberada, vía `simulate_rules` y `activate_rule_set`.

#### Hueco encontrado al desplegar: la tabla de festivos quedaba vacía

La siembra cargaba todo menos `rule_holidays` — la tarea que la escribió dejó los
festivos fuera porque `business-days.ts` todavía no existía cuando arrancó. Consecuencia
concreta: el cálculo contaba el 14 de julio y el 15 de agosto como días hábiles, así que
las fechas límite salían optimistas y un pedido podía marcarse como retrasado antes de
tiempo, disparando el mail equivocado.

Y había un segundo fallo encima: el bloque de festivos estaba **después** de la guarda de
idempotencia, así que una resiembra nunca los habría creado. Movido antes de la guarda,
porque los festivos no dependen del RuleSet: son hechos de calendario.

Verificado tras el arreglo: un pedido del 13/07/2026 con plazo de 2 días hábiles vence el
**16/07** con los festivos cargados, frente al 15/07 sin ellos.

#### La base es intermitente

Cuatro cortes distintos durante el despliegue (dos `P1001`, dos `SocketTimeout`), todos
transitorios y resueltos al reintentar. Las consultas normales tardan 350ms-1s. Esto
respalda la decisión de T11 de mapear **cualquier** fallo de reglas a 503 y no a 500: no
es un caso teórico, pasa varias veces por sesión.

### Pendiente, y no depende de código
1. **Los 8 `body` de plantilla** siguen vacíos: los textos están en
   `scenario_lia.numbers`, hoja Feuil2, que no está en el repositorio.
2. **Confirmar con el cliente** la desviación del §4 fila 13 documentada en T8, y los
   plazos reales de las tres submarcas sembradas por aproximación.

### T10 — decisiones y hallazgos

**División en dos ficheros, no uno.** `src/lib/prisma.ts` lanza al importarse
si `DATABASE_URL` no está definida, y este repositorio no tiene `.env`. El
prompt pedía extraer las funciones puras "de forma que se puedan testear sin
Prisma": con todo en un solo `rule-queries.ts`, cualquier test de las
funciones puras habría reventado al importar el módulo. Se separó en
`src/lib/rule-set-validation.ts` (zod, enums cerrados, `parse*`,
`buildLoadedRuleSet`, sin ninguna dependencia de Prisma) y `src/lib/rule-queries.ts`
(todo lo que toca Prisma), que reexporta el módulo puro entero
(`export * from "./rule-set-validation"`) para que quien importe
`rule-queries.ts` no note la división. `rule-queries.test.ts` importa del
módulo puro.

**`pnpm generate` (`prisma generate`) sí se ejecutó.** No toca la base — solo
regenera el cliente TypeScript local a partir de `schema.prisma` — pero era
necesario: el cliente generado antes de esta tarea no conocía los 7 modelos
del motor de reglas (T5 los agregó al esquema pero nadie había regenerado el
cliente), así que `prisma.ruleSet` etc. no tipaban. Sin este paso `pnpm build`
no podía pasar. No se corrió ninguna migración ni se tocó la base remota.

**`checkBrandCoverage`: el conteo de "productos activos" sale de la tabla
`products` local** (la misma que usa `search_products`), no de una consulta
en vivo a PrestaShop: evita una llamada extra por marca y es el dato que ya
está sincronizado. No estaba explícito en el prompt.

**Desajuste Prisma/siembra: `RuleStateGroup.stateName`.** La columna es
`String?` (nullable) pero `OrderStateGroupSeed.stateName` (el tipo de la
siembra) es `string` no-nulo. `setStateGroup` no reusa `OrderStateGroupSeed`
como tipo de entrada por esto: usa un `StateGroupInput` propio con
`stateName: string | null`, fiel a la columna real.

**Desajuste Prisma/siembra: `RuleTemplate.lang`.** El comentario del esquema
dice "fr | en | es", pero `RuleTemplateSeed.lang` (y por lo tanto
`RULE_TEMPLATE_LANGS`, la única fuente para el enum zod) solo acepta `"fr"`.
Se dejó cerrado a `"fr"` a propósito, seguro para hoy porque la siembra actual
no tiene ningún `en`/`es`; ampliarlo es una tarea futura si se agregan
plantillas en otro idioma.

**Desajuste Prisma/siembra: `RuleDecision.note` / `RuleSetting.note`.** Ambas
columnas son `String?` (nullable), pero `RuleDecisionSeed.note` es `string` no
nulo y se validó como obligatorio y no vacío en `rule-set-validation.ts`
(una fila de la matriz sin nota legible no se puede explicar en
`simulate_rules` ni en una escalada). `RuleSettingSeed.note` sigue opcional/
nullable sin forzar contenido, porque no se usa para explicar nada al cliente.

**No cubierto por el prompt, decisiones propias:**
- `listRuleSets`/`getRuleSetDetail` (funciones de soporte para `list_rule_sets`/
  `get_rules`) no estaban nombradas en el prompt pero eran necesarias para esas
  dos tools de lectura.
- `getRuleSetDetail` muestra el contenido crudo de un borrador sin pasarlo por
  la validación fail-closed, a propósito: tiene que poder mostrar un borrador
  roto tal cual está para que el editor vea qué arreglar.
- `createRuleDraft`/`activateRuleSet`/`rollbackRuleSet` traducen también la
  colisión de versión / archivado con un mensaje claro (mismo patrón que pedía
  el prompt solo para la carrera de activación).
- `rollbackRuleSet` no revalida el conjunto completo: un conjunto que llegó a
  `active` alguna vez ya pasó por `activateRuleSet`, así que no se repite el
  costo. Si se prefiere revalidar siempre, es un cambio de una línea.

## Siguiente paso

T11 (handler Express + ruta), la única tarea que queda de la Fase 2.
