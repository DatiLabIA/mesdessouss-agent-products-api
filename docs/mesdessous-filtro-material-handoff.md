# Handoff — Bug del filtro por material (`product_search`) + propuesta de fix

**Proyecto:** MesDessous.fr / Catalog Service
**Componente:** `product_search` (endpoint `https://products-mesdessous.datihub.com/mesdessous/product_search`) + campo `material` en BD
**Prioridad:** Alta (afecta ingresos + confianza; caso real de cliente vulnerable)
**Estado:** ✅ **IMPLEMENTADO y verificado contra la BD de producción (5433).** Ver sección "Solución implementada". El código está en local, pendiente de deploy.

---

## TL;DR

El filtro `material` del `product_search` hace **coincidencia por substring sin umbral ni ranking**. Cuando un cliente busca "algodón", devuelve por igual prendas con **1% de algodón** y con **47%**, sin ordenar, e incluso prendas donde el algodón está **solo en el forro** de una prenda sintética. El asistente (Lia) narra esos productos como "de algodón", el cliente lo detecta, y no hay forma de corregirlo desde el prompt porque la herramienta responde a otra pregunta.

El mismo defecto afecta a **cualquier** búsqueda por material (dentelle, soie, modal, microfibre…), no solo algodón.

**Fix de raíz:** enriquecer la composición a datos estructurados (offline, en el import) y añadir un parámetro `min_material_pct` + ordenar por contenido. El campo `material` crudo NO se toca.

---

## El problema (con evidencia reproducible)

El campo `material` se guarda tal cual viene de Prestashop: texto libre, formato inconsistente. Ejemplos reales:

```
"50% Polyamide/29% Polyester/11% Soie/7% Elasthanne/3% Coton"
"Matières : Polyester 33% Polyamide 28% Soie 23% Elasthanne 9% Coton 7%"
"40% polyamide/25% polyester/15% coton/20% élasthanne"
"dentelle 92% Polyamide 8%/Elasthanne tissu 83% Polyamide 17% Elasthanne doublure fond 100% coton"
```

El filtro `material=coton` aplica algo equivalente a `WHERE material ILIKE '%coton%'`. Consecuencias verificadas:

### Evidencia 1 — `type=soutien-gorge` + `material=coton` (10 resultados)
Rango real de algodón devuelto: **4% a 28%**, mezclados sin orden. Un resultado (Sans Complexe Arum) coincide **solo porque su forro dice "doublure fond 100% coton"** — la prenda es sintética.

### Evidencia 2 — `type=soutien-gorge` + `sub_type=corbeille` + `color=blanc` + `material=coton` (9 resultados)
Rango real: **1% a 47%**. Posiciones concretas en la respuesta:
- Antigel New Apesanteur — **1% Coton** → coincide igual (posición 6)
- Maison Lejaby Memories — **47% Coton** (el único "de algodón" de verdad) → **aparece último** (posición 9)

El frontend recorta a 5 productos **sin reordenar**, así que el único producto genuinamente de algodón puede no mostrarse.

### Problemas confirmados
1. **Sin umbral:** 1% de algodón coincide igual que 47%.
2. **Sin ranking:** el contenido real no ordena resultados (47% queda debajo de 1%).
3. **Coincide con algodón solo-en-forro** (substring sobre "doublure fond 100% coton" de una prenda sintética).
4. **Genérico:** afecta a todos los materiales, no solo algodón.

> Nota aparte (clase distinta, NO parte de este fix): en Evidencia 1 apareció un **string** etiquetado como `type: "Soutien-gorge"`. Hay errores de tipado en el catálogo → limpieza de categorías separada.

---

## Impacto

- **Toda búsqueda por material devuelve resultados engañosos.** El cliente pide X y recibe trazas de X presentadas como X.
- **Caso real detonante:** una clienta con necesidad **médica** (piel sensible tras radioterapia) pidió sujetador de algodón, detectó explícitamente que los productos no eran de algodón ("il ne semble pas être composé de coton"), el asistente afirmó re-filtrar y devolvió los mismos productos de traza. Riesgo reputacional alto + borde de duty-of-care.
- **El prompt del asistente NO puede arreglarlo de raíz:** aunque el modelo lea el % en el resultado del tool, no controla qué 5 productos muestra el frontend (los inyecta el backend sin ordenar). Puede mitigar la narración, no el resultado.

---

## Causa raíz

El filtro responde a *"¿la composición contiene la subcadena X en algún lugar?"* cuando la intención del cliente es *"¿la prenda es (predominantemente) de X?"* o, en el caso médico, *"¿lo que toca la piel es de X?"*. La composición es texto libre sin estructura, así que no existe forma de expresar "algodón ≥ N%" ni de distinguir cuerpo vs. forro.

---

## Soluciones posibles

### Principio de diseño
- **No tocar el campo `material` crudo** — es la fuente de verdad desde Prestashop. Todo lo derivado se guarda **al lado**, en columnas nuevas.
- **Parsear una sola vez, offline** (en el import/ETL o job aparte), **no en cada query**. La composición no cambia tras importarse.
- **La unidad de trabajo son los strings distintos, no los productos.** Muchos productos comparten composición → deduplicar y parsear el set único reduce mucho el volumen (probablemente cientos de strings, no miles de productos).

### Campos a derivar (aditivos)

| Campo | Tipo | Uso |
|---|---|---|
| `composition_parsed` | JSONB | `[{fiber:"coton", pct:47, zone:"corps"}, …]` — sirve para cualquier material |
| `primary_material` / `primary_material_pct` | text / int | Fibra dominante (ranking, "predominantemente X") |
| `cotton_pct_body` (o genérico por fibra) | int | % de la fibra en el cuerpo (filtro + orden) |
| `has_cotton_lining` | bool | Fibra presente solo en forro/fond |
| `parse_status` | enum | `ok` / `needs_review` / `failed` |

> El forro NO se descarta: se etiqueta. Para el caso médico, lo que toca la piel (forro) puede ser justo lo relevante. Capturar *dónde* está la fibra, no solo cuánto.

### Opciones de parseo

| Opción | Cómo | Trade-off |
|---|---|---|
| **A. Regex determinista** | Normalizar (minúsculas, quitar "Matières :", unificar separadores, quitar acentos) → capturar pares `(\d+)% (fibra)` en ambos órdenes → mapear sinónimos | Gratis, rápido, debuggeable. Cubre ~90% del texto limpio. Se rompe en multi-zona (`dentelle… / doublure fond…`). |
| **B. LLM batch offline** | Pasar los strings distintos por un modelo con schema JSON estricto + temp baja | Resuelve lo sucio y distingue cuerpo/forro. Coste bajísimo (cientos de strings, una vez). No determinista → mitigar con validación de suma. |
| **C. Híbrido (recomendado)** | Regex para el limpio; LLM solo para lo que el regex no parsea con confianza o detecta multi-zona | Mejor ROI: barato/determinista donde se puede, robusto donde hace falta. |

### Requisitos de robustez (para que sea "aburrido y confiable")
- El resultado del parseo vive en una **tabla de lookup cacheada por string crudo** (`raw_string` PK → parsed). El import solo hace **join**, nunca parsea en caliente.
- **Degradación elegante:** si aparece un string desconocido → `parse_status='needs_review'`, `pct=null`, y se **cae al comportamiento substring actual** (no peor que hoy). El import nunca se bloquea aunque el LLM/API esté caído → el enriquecimiento es **caché, no dependencia dura**.
- **Validación determinista:** si los % de una zona no suman ~100 (±2) → `needs_review`. Nunca confiar ciegamente en el parser.
- **Monitoreo de drift:** alerta cuando entren strings `needs_review` (Prestashop meterá formatos nuevos). Se vigila la deriva, no se descubre por una queja.

### Cambio en el filtro (tras enriquecer)

```sql
-- product_search(material="coton", min_material_pct=30)
WHERE cotton_pct_body >= 30 OR has_cotton_lining = true
ORDER BY cotton_pct_body DESC
```

Arregla de una **el umbral (problema 1) y el ranking (problema 2)**.

### Mitigación de prompt (independiente, complementaria, no sustituye el fix de datos)
Guardarraíl en el system prompt de Lia: si el material pedido aparece en <~15% o solo en forro, no afirmar "de algodón"; señalar el/los de alta teneur sin prometer, y nunca decir "re-filtré" si el resultado no cambió. Apaga el fuego reputacional en minutos, pero no corrige ranking ni resultado.

---

## Recomendación

Opción **C (híbrido)** con tabla de lookup cacheada + degradación elegante, en el ETL o job offline. Genérico por fibra (no solo algodón). El tamaño real del trabajo depende del volumen de strings distintos (ver decisiones abajo): si son cientos → **script de enriquecimiento único (horas)**; si son miles con rotación alta → **pipeline incremental (días)**.

En paralelo, aplicar la mitigación de prompt de inmediato (bajo riesgo, reversible).

---

## Solución implementada (verificada contra BD 5433)

Se implementaron **ambas fases a la vez**, con enriquecimiento offline (no regex por query, más preciso). El campo `materials` crudo **no se toca**.

### Datos reales medidos
- `COUNT(DISTINCT materials)` = **4,924** strings (96,018 productos con material). Miles, pero **99% regex-parseable** → *script*, no pipeline de días.
- El regex ingenuo por query **mal-atribuye** el %: en `"Polyester 37% Coton 6%"` asignaba 37% (del poliéster) al algodón. Por eso se hizo un parser **consciente del formato** en vez de regex inline.

### Qué se construyó
1. **Parser determinista** [`src/lib/material-parser.ts`](../src/lib/material-parser.ts) — sin dependencias, testeable.
   - Normaliza (minúsculas, sin acentos, separadores `/ , ; : + -`, quita "Matières :").
   - Parsea en **las dos interpretaciones** (`%fibra` y `fibra%`) y se queda con la que **suma ≈100** (validación determinista). Maneja formato `PA-Polyamide-72` y `Autres`.
   - Separa **cuerpo vs. forro** (doublure/fond) → zona por fibra.
   - Diccionario de ~25 fibras con sinónimos ES/EN/FR (coton/cotton/algodón, elasthanne/elastane/spandex, viscose/rayonne…).
   - **Solo almacena zonas que validan** (suma≈100); lo dudoso se descarta y marca `needs_review` → el producto cae al substring actual (degradación elegante).
   - Cobertura medida sobre los 4,924 strings: **94.4% ok / 5.5% needs_review / 0.1% failed** (el needs_review es casi todo multi-construcción: dentelle bonnet/bas/haut, broderie).
2. **Tabla normalizada `product_materials`** `(client_id, base_product_id, fiber, pct, zone)` — migración [`20260718000000_add_product_materials`](../prisma/migrations/20260718000000_add_product_materials/migration.sql), aplicada a la BD. Poblada: **21,974 filas**, 16 fibras, 195 filas de forro, 3,508 productos con coton.
3. **Sync offline** [`src/lib/sync-materials.ts`](../src/lib/sync-materials.ts) + `pnpm sync:materials` — parsea cada string distinto **una vez** (caché por raw_string), expande a los base_product_id, hace upsert y **purga** lo que ya no aplica. Guardia anti-vacío. Scheduler diario 00:30 (tras el sync de productos), encadenado al sync inicial en arranque.
4. **Búsqueda arreglada** [`src/lib/product-queries.ts`](../src/lib/product-queries.ts):
   - Nuevo parámetro **`min_material_pct`** (0–100). Exige la fibra ≥N% en **cuerpo o forro** (`EXISTS` sobre product_materials).
   - **Ranking:** cuando el `material` pedido mapea a una fibra conocida, se **ordena por su % real DESC** antes que los desempates existentes (stock/descuento/precio).
   - Cada producto devuelve su **`composition`** estructurada `[{fiber, pct, zone}]` → Lia narra el % real y distingue "en el forro".
   - Degradación: material que no mapea a fibra o composición no parseada → substring actual (no peor que hoy).
5. **Expuesto en REST** (`/mesdessous/product_search`) **y MCP** (`search_products`), ambos vía la misma función.

### Verificación end-to-end (caso real, BD 5433)
`type=soutien-gorge, sub_type=corbeille, color=blanc, material=coton`:
- **Sin umbral:** ahora sale ordenado por % — **Maison Lejaby 47% pasa de la posición 9 a la 1**; el resto (1–7%) debajo.
- **`min_material_pct=30`:** devuelve **solo** el Maison Lejaby 47% (el único genuino).
- Genérico confirmado con `soie` (99 productos ≥50%). 53 productos con coton solo-en-forro se incluyen correctamente con umbral.

---

## Decisiones / datos que necesito del dev antes de estimar (RESUELTAS)

- **1.** `COUNT(DISTINCT material)` = **4,924** → *script único* (99% regex). ✅
- **2.** El import/sync **es propio y modificable** → enriquecimiento dentro del sync (`sync-materials`). ✅
- **3.** La composición era **solo string libre** → parseado desde cero. ✅
- **4.** ⚠️ **Pendiente de confirmar con DatiHub:** el frontend debe **respetar el orden del backend** (toma los primeros N). El ranking ya sale correcto del backend; falta confirmar que DatiHub no reordena. Además, si la tool de DatiHub tiene schema fijo, hay que **añadir `min_material_pct`** a sus inputs.

### Original — Decisiones / datos que se necesitaban del dev antes de estimar

1. **`SELECT COUNT(DISTINCT material) FROM productos;`** → decide entre "script único" y "pipeline permanente".
2. **El import Prestashop → Postgres, ¿es propio y modificable, o caja negra?** → define si el enriquecimiento va dentro del ETL o como job posterior.
3. **¿La composición se guarda solo como string libre, o ya existe algún campo estructurado?** → confirma que hay que parsear desde cero.
4. **¿El frontend puede respetar un orden que venga del backend** (`ORDER BY … DESC`), o recorta a 5 en orden de llegada arbitrario? → si no respeta orden, el ranking hay que garantizarlo en el backend antes de enviar.

---

## Criterios de aceptación (v1)

- [x] Búsqueda `material=coton, min_material_pct=30` devuelve solo prendas con ≥30% algodón en cuerpo (o forro de algodón), ordenadas por % descendente. **Verificado:** devuelve solo Maison Lejaby 47%.
- [x] El campo `material` crudo permanece intacto. **Los datos derivados viven en `product_materials`.**
- [x] Strings no parseables quedan en `needs_review` y degradan al comportamiento substring actual sin romper el sync. **5.5% needs_review, no generan filas → fallback substring.**
- [x] El mismo mecanismo funciona para cualquier fibra sin código específico. **Verificado con `soie` (99 productos ≥50%).**
- [~] Alerta/reporte de strings `needs_review` para vigilar drift. **El sync loguea el conteo `ok/needs_review/failed` en cada corrida; falta enganchar una alerta activa (p. ej. si needs_review sube de X%).**

### Pendiente para cerrar
- Deploy del código (está en local).
- Añadir `min_material_pct` al schema de la tool en DatiHub (si es fijo) y confirmar que el frontend respeta el orden del backend.
- Mitigación de prompt de Lia (independiente).
- Opcional: alerta de drift sobre `needs_review`; exponer `fiber` como faceta en `get_catalog_options`.
