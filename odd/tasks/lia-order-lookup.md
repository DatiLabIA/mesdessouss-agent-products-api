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
- [ ] **T6** — Siembra desde `docs/reglas-lia-pedidos-retornos.md`: 13 filas de matriz,
  41 marcas normalizadas, mapeo de estados por ID, plantillas y ajustes.
- [ ] **T7** — Cálculo de hechos: grupos de estado, stock por línea (`quantity >= 0`),
  marcas afectadas, días hábiles con festivos FR, retraso. Con tests.
- [ ] **T8** — Evaluador de la matriz + fail-safe en código + bloque `guidance`. Con tests.
- [ ] **T9** — Consolidación: todas las consultas a PrestaShop en una sola llamada.
- [ ] **T10** — Tools MCP de reglas (lectura, borrador, simulación, publicación, rollback).
- [ ] **T11** — Handler Express + ruta.

## Siguiente paso

T6 y T7, que no dependen de nada pendiente.
