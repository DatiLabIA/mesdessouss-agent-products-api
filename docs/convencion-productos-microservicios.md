# Convención de productos para microservicios

Cómo debe devolver productos un microservicio para que DatiHub los pinte, en
WhatsApp o en el widget, sin escribir código para ese catálogo.

---

## Por qué existe

Hoy cada catálogo devuelve lo que quiere y DatiHub adivina. Adivina tan bien
como puede —prueba `imageUrl`, luego `image_url`, luego `images`— pero adivinar
falla en silencio.

Pasó de verdad: la plantilla de maxiautos pedía `priceLabel`, el catálogo
devolvía `price`, y **el precio dejó de aparecer en WhatsApp**. Nadie se enteró
hasta que alguien fue a mirar. Con una convención, ese desencuentro no ocurre.

---

## La forma

```json
{
  "products": [
    {
      "id": "1610",
      "title": "Chevrolet Sail LS 1.4 2013",
      "subtitle": "Chevrolet",
      "image": "https://…/sail.jpg",
      "url": "https://maxiautos.co/automoviles/1610-chevrolet-sail.html",
      "price": 29900000,
      "currency": "COP",
      "attributes": [
        { "label": "Kilometraje", "value": "145.000 km" },
        { "label": "Transmisión", "value": "Manual" },
        { "label": "Combustible", "value": "Gasolina" },
        { "label": "Modelo",      "value": "2013" }
      ],
      "details": {
        "traction": "4x2",
        "doors": 4,
        "displacement": "1.4",
        "peakAndPlate": "Par",
        "singleOwner": true,
        "description": "…"
      }
    }
  ]
}
```

### Los tres cajones

Hay **dos consumidores del mismo producto y necesitan cosas opuestas**: la ficha
quiere pocos campos y cortos; el modelo quiere todos, para poder responder
"¿tiene bluetooth?" o comparar dos opciones. Por eso el producto va en tres
partes:

| Cajón | Se pinta | Para qué |
|---|---|---|
| Núcleo | siempre | Identidad, foto, precio, enlace |
| `attributes` | sí, ordenado y recortado | Lo que ayuda a decidir de un vistazo |
| `details` | **nunca** | Lo que el modelo necesita para conversar |

**La prueba para decidir dónde va un campo:**

> ¿Ayuda a decidir de un vistazo? → `attributes`
> ¿Sirve para responder una pregunta? → `details`

El caso más claro está en mesdessous: su descripción trae
`"DENTELLE: 89% Polyamide 11% Elasthanne"`. En una ficha son 300 caracteres de
ruido. Pero si el cliente pregunta "¿es de encaje?", es exactamente lo que el
modelo necesita. Mismo dato, dos destinos: sin separarlos, o ensucias la ficha o
dejas mudo al bot.

### Campos del núcleo

| Campo | Obligatorio | Qué es |
|---|---|---|
| `id` | sí | Identificador estable del producto |
| `title` | sí | Lo que se lee en grande |
| `image` | sí | URL de **una** imagen, no un array |
| `url` | sí | Ficha del producto |
| `price` | sí | **Número**, sin símbolos ni separadores |
| `currency` | sí | Código ISO: `COP`, `EUR`, `USD` |
| `subtitle` | no | Marca o línea. Va bajo el título |
| `oldPrice` | no | Precio anterior. Si viene y es mayor, se pinta el descuento |
| `available` | no | `false` oculta el producto. Si no viene, se asume disponible |
| `details` | no | Objeto libre que **no se pinta**: contexto para el modelo |

---

## Las dos reglas

### 1. Los `attributes` los decide el microservicio

Es una lista **ordenada por importancia**, con la etiqueta y el valor ya
escritos. DatiHub los pinta tal cual y recorta por el final si no caben.

Quien construye el catálogo sabe que el kilometraje importa y que
`peakAndPlate` no le interesa a nadie en una ficha. DatiHub no tiene forma de
saberlo: el catálogo de maxiautos devuelve 23 campos y el de mesdessous 17.

Manda solo lo que quieras que se vea. **Tres o cuatro suelen bastar** — un
caption de WhatsApp es estrecho y una ficha con doce datos no se lee.

### 2. El precio va crudo; todo lo demás, ya escrito

```json
"price": 29900000, "currency": "COP"     ✅
"price": "$29.900.000"                   ❌
```

El precio es la única excepción, y por un motivo concreto: el mismo catálogo de
mesdessous atiende a clientes en francés, inglés y español. `29,90 €` y
`€29.90` son el mismo número escrito para dos personas distintas, y el catálogo
no sabe quién está mirando. DatiHub sí.

Con el resto pasa lo contrario: `"145.000 km"` se lee igual en todas partes, y
que el catálogo lo escriba evita inventarnos un sistema de unidades y formatos
para nada.

---

## Qué NO va en `attributes`

Nada de esto se pinta. Si el modelo lo necesita, va en `details`:

- **Descripciones largas.** Las de mesdessous pasan de 300 caracteres.
- **Taxonomías internas.** `categories`, `composition`, `base_product_id`.
- **Datos técnicos de detalle.** Cilindraje, tracción, puertas, pico y placa.

Y dos cosas que no van a ninguna parte:

- **Arrays de imágenes.** Elegí la principal y mandá esa en `image`.
- **Campos vacíos.** Un atributo sin valor se descarta igual; no lo mandes.

---

## Los dos catálogos de hoy

**maxiautos** (vehículos usados):

```json
{ "id": "1610", "title": "Chevrolet Sail LS 1.4 2013", "subtitle": "Chevrolet",
  "image": "…", "url": "…", "price": 29900000, "currency": "COP",
  "attributes": [
    { "label": "Kilometraje", "value": "145.000 km" },
    { "label": "Transmisión", "value": "Manual" },
    { "label": "Combustible", "value": "Gasolina" }
  ] }
```

**mesdessous** (lencería):

```json
{ "id": "31802_1497251", "title": "Soutien-gorge triangle plunge Rosessence",
  "subtitle": "Aubade", "image": "…", "url": "…",
  "price": 86, "currency": "EUR", "available": true,
  "attributes": [
    { "label": "Taille",   "value": "95 E (eu 80)" },
    { "label": "Couleur",  "value": "Noir" },
    { "label": "Matière",  "value": "Dentelle" }
  ] }
```

Mismo contrato. Lo único que cambia es qué va en `attributes` — y eso es
precisamente lo que evita escribir código por catálogo.

Cómo se reparten hoy los campos de cada uno:

| | `attributes` (se pinta) | `details` (solo el modelo) |
|---|---|---|
| **maxiautos** | kilometraje, transmisión, combustible, modelo | tracción, puertas, cilindraje, pico y placa, único dueño, clase, versión, descripción |
| **mesdessous** | talla, color, material | composición, categorías, descripción, subtipo, stock |

---

## Qué hace DatiHub con esto

| Canal | Render |
|---|---|
| WhatsApp | Foto con caption: título, atributos separados por `·`, precio, enlace |
| Widget | Tarjeta: imagen, título, subtítulo, atributos, precio, botón |

El precio se formatea con la moneda que mandaste y el idioma de quien mira. Si
`oldPrice` es mayor que `price`, se muestra tachado con su porcentaje.

Cuántos productos y cuántos atributos entran por canal se configura en el flujo,
en `toolsConfig.presentation.channels`.

---

## Mientras tanto

Los catálogos que aún no siguen la convención **siguen funcionando**: DatiHub
detecta que no viene en este formato y usa el camino anterior —canonización más
plantilla—. Se migra un microservicio a la vez, sin ventana de corte.

---

## Referencias

- Conectores externos: [`external-connectors.md`](./external-connectors.md)
- Cómo llegan los productos al render (`inject` vs `ai`): `toolsConfig.products.mode`
