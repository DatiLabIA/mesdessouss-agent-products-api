# Especificación de reglas — Asistente de pedidos y retornos
## MesDessous.fr (SARL ESPRIT GRENADINE)

**Versión:** 2.0 (matriz cerrada)
**Fuentes:** `sce_nario_IA.pages` (N1–N13) + `scenario_lia.numbers` (Feuil1 matriz / Feuil2 plantillas)
**Estado:** reglas cerradas y sin huecos. Pendiente únicamente la verificación técnica del PrestaShop.

---

## 1. Datos de entrada

El motor necesita estos datos para cada consulta. Si falta alguno, la regla correspondiente no se evalúa y se escala a humano.

### 1.1 Identificación
| Dato | Origen | Notas |
|---|---|---|
| `reference` | Pedido | 9 caracteres alfanuméricos |
| `id_order` | Pedido | Número precedido de `#` |
| `email_cliente` | Pedido | Obligatorio para validar identidad |

### 1.2 Pedido
| Dato | Uso |
|---|---|
| `date_commande` | Base de todos los cálculos de plazo |
| `statut` | Determina el bloque de reglas aplicable |
| `lineas[]` → `nombre_producto`, `marca`, `cantidad`, `stock_disponible` | Stock y marcas afectadas |
| `numero_seguimiento` | Mails 3 y 6 |
| `historial` | Mails 6 y 7 |

### 1.3 Retorno
| Dato | Uso |
|---|---|
| `estado_retorno` | Determina el mail |
| `fecha_recepcion` | Mail 10 |
| `fecha_tratamiento` | Mail 12 |
| `etiqueta_generada` (sí/no) | Mail 14 |

---

## 2. Definiciones

### 2.1 Grupos de estado del pedido

**Grupo A — pedido no expedido**
- Chèque reçu
- Commande en cours de traitement
- Commande enregistrée
- Paiement validé
- Préparation en cours

**Grupo B — pedido expedido**
- Livraison en cours
- En cours de livraison
- Commande Terminé

**Grupo C — expedición parcial**
- Livraison partielle

**Grupo D — todo lo demás** (Annulé, Remboursé, Paiement erroné, En attente de paiement, etc.)
→ No cubierto por ninguna regla. Escalar a humano siempre.

### 2.2 Estado de stock

| Valor | Definición |
|---|---|
| `EN_STOCK` | Todas las líneas del pedido tienen stock suficiente |
| `SIN_STOCK` | Al menos una línea no tiene stock suficiente (cubre "non" y "pas totalement") |

### 2.3 Marcas afectadas

`marcas_afectadas` = conjunto de marcas distintas **únicamente de las líneas sin stock**.
Las líneas que sí tienen stock no cuentan, aunque sean de otra marca.

| Condición | Clasificación |
|---|---|
| `count(marcas_afectadas) == 1` | Monomarca |
| `count(marcas_afectadas) >= 2` | Multimarca |

**Ejemplo:** pedido con un Adidas en stock y un Aubade sin stock → `marcas_afectadas = {Aubade}` → **monomarca** (mail 5), aunque el pedido tenga dos marcas.

### 2.4 Tabla de plazos de expedición (días hábiles)

Los seis valores que estaban en `0` se reemplazan por `10`, según decisión del cliente. Se marcan con ✱.

| Marca | Días | | Marca | Días |
|---|---|---|---|---|
| Adidas | 9 | | Louisa Bracq | 5 |
| Anita | 7 | | Maison Broussaud | 10 ✱ |
| Antigel | 5 | | Maison Lejaby | 7 |
| Arthur | 7 | | Marie Jo | 5 |
| Athena | 9 | | Marjolaine | 7 |
| Aubade | 5 | | Massana | 7 |
| Calida | 7 | | Moretta | 12 |
| Chantelle | 5 | | Oscalito | 12 |
| EdenPark | 8 | | Passionata | 9 |
| Eminence | 9 | | Prima Donna | 5 |
| Emporio Armani | 10 ✱ | | Rosa Faia | 7 |
| Empreinte | 6 | | Sans Complexe Lingerie | 10 ✱ |
| Hanro | 9 | | Sarda | 10 ✱ |
| HOM | 8 | | Saxx | 10 ✱ |
| Impetus | 8 | | Simone Pérèle | 5 |
| Janira | 7 | | Sloggi | 9 |
| Komilfo | 10 ✱ | | Sloggi For Men | 9 |
| Le Chat | 7 | | Triumph | 9 |
| Le Slip Français | 10 | | Wacoal | 8 |
| Lise Charmel | 5 | | WOH | 8 |
| Loïc Henry | 10 | | | |

**Marca no encontrada en la tabla:** escalar a humano. No inventar plazo ni usar un valor por defecto.

### 2.5 Cálculo de fechas

Todos los plazos se cuentan en **días hábiles**: se excluyen sábados, domingos y festivos de Francia metropolitana.

```
SI estado_stock = EN_STOCK:
    plazo = 2 días hábiles          (el "délai de 48 heures ouvrées")
SI estado_stock = SIN_STOCK:
    plazo = MAX(plazo_marca) para cada marca en marcas_afectadas

fecha_limite = date_commande + plazo (días hábiles)
retard       = días hábiles transcurridos desde fecha_limite hasta hoy
               (0 si hoy <= fecha_limite)
```

---

## 3. Árbol de decisión

### 3.1 Bloque PEDIDO

```
┌─ statut ∈ Grupo D ─────────────────────────→ ESCALAR A HUMANO
│
├─ statut ∈ Grupo B (expedido)
│     ├─ hay numero_seguimiento ─────────────→ MAIL 3
│     └─ no hay numero_seguimiento ──────────→ ESCALAR A HUMANO
│
├─ statut ∈ Grupo C (Livraison partielle)
│     ├─ el historial indica productos
│     │  pendientes y/o plazo ───────────────→ MAIL 6
│     └─ el historial no tiene información ──→ MAIL 7
│
└─ statut ∈ Grupo A (no expedido)
      │
      ├─ EN_STOCK
      │     ├─ retard = 0 ────────────────────→ MAIL 1
      │     ├─ retard entre 1 y 3 días ───────→ MAIL 2
      │     └─ retard > 3 días ───────────────→ MAIL 15
      │
      └─ SIN_STOCK
            ├─ retard = 0
            │     ├─ multimarca ──────────────→ MAIL 4
            │     └─ monomarca ───────────────→ MAIL 5
            └─ retard > 0 ────────────────────→ MAIL 15
```

**Notas de aplicación**
- En el Grupo B el estado de stock es irrelevante: una vez expedido el pedido, siempre es mail 3.
- El mail 15 es la regla de cierre de todos los retrasos, con y sin stock. No queda ninguna combinación sin salida.
- La comprobación de tracking en el Grupo B es una salvaguarda añadida: evita enviar un mail con un enlace de seguimiento vacío.

### 3.2 Bloque RETORNO

```
┌─ estado_retorno = "En attente du colis" ───→ MAIL 8
├─ estado_retorno = "Colis reçu" ────────────→ MAIL 10
├─ estado_retorno = "Retour terminé" ────────→ MAIL 12
├─ estado_retorno = "Retour refusé" ─────────→ MAIL 13
├─ no hay etiqueta de retorno generada ──────→ MAIL 14
└─ cualquier otro caso ──────────────────────→ ESCALAR A HUMANO
```

**Fuera del alcance de la fase 1:** mails 9 y 11. Ambos exigen leer el seguimiento del transportista (La Poste / Chronopost), lo que requiere una integración externa adicional, y ninguno de los dos tiene texto redactado en Feuil2.

---

## 4. Matriz de decisión cerrada

Tabla de verdad completa del bloque PEDIDO. Sirve como batería de casos de prueba.

| # | Estado | Stock | Marcas afectadas | Retraso | Salida |
|---|---|---|---|---|---|
| 1 | Grupo A | EN_STOCK | — | 0 | Mail 1 |
| 2 | Grupo A | EN_STOCK | — | 1–3 d | Mail 2 |
| 3 | Grupo A | EN_STOCK | — | > 3 d | Mail 15 |
| 4 | Grupo A | SIN_STOCK | 1 | 0 | Mail 5 |
| 5 | Grupo A | SIN_STOCK | ≥ 2 | 0 | Mail 4 |
| 6 | Grupo A | SIN_STOCK | 1 | > 0 | Mail 15 |
| 7 | Grupo A | SIN_STOCK | ≥ 2 | > 0 | Mail 15 |
| 8 | Grupo B | cualquiera | — | — | Mail 3 (si hay tracking) |
| 9 | Grupo B | cualquiera | — | — | Escalar (sin tracking) |
| 10 | Grupo C | parcial | — | — | Mail 6 (historial con info) |
| 11 | Grupo C | parcial | — | — | Mail 7 (historial sin info) |
| 12 | Grupo D | cualquiera | — | — | Escalar |
| 13 | cualquiera | SIN_STOCK | marca desconocida | — | Escalar |

---

## 5. Variables por plantilla

| Mail | Variables a inyectar | Origen |
|---|---|---|
| 1 | `[Numéro de commande]` | `reference` |
| 2 | `[Numéro de commande]` | `reference` |
| 3 | `[Numéro de commande]`, `[LIEN DE SUIVI]` | `reference`, `numero_seguimiento` |
| 4 | lista de `[Nom produit]` + `[Marque]`, `[Date]` | líneas sin stock, `fecha_limite` |
| 5 | `[Date]` | `fecha_limite` |
| 6 | `[Nom du ou des produits]`, `[LIEN DE SUIVI]`, `[délai]` | historial, tracking |
| 7 | ninguna | — |
| 8 | ninguna | — |
| 10 | `[Date]` | `fecha_recepcion` |
| 12 | `[Date]` | `fecha_tratamiento` |
| 13 | ninguna | — |
| 14 | ninguna | — |
| 15 | ninguna | — |

**Formato de fecha:** todas las fechas al cliente en formato francés `JJ/MM/AAAA`.

---

## 6. Corrección de la plantilla del mail 4

La plantilla actual está en singular y el escenario es multimarca por definición. Reemplazar el segundo párrafo por:

> Bonjour,
> Nous vous remercions pour votre commande [Numéro de commande].
> Celle-ci est actuellement en cours de traitement. Toutefois, les produits suivants nécessitent un délai supplémentaire de préparation :
>
> - [Nom produit] — [Marque]
> - [Nom produit] — [Marque]
>
> ce qui peut légèrement retarder l'expédition de votre commande.
> Nous faisons notre maximum afin de finaliser votre commande dans les meilleurs délais. Votre commande devrait être expédiée au plus tard le [Date].
> Dès son expédition, vous recevrez un e-mail de notre partenaire de livraison (So Colissimo La Poste ou Chronopost) contenant toutes les informations nécessaires au suivi et à l'acheminement de votre colis.
> Nous vous remercions pour votre patience et votre confiance, et vous souhaitons une bonne réception de votre commande.

Se añade también `[Numéro de commande]`, que faltaba en los mails 4 y 5 y sí está en los mails 1, 2 y 3.

---

## 7. Reglas transversales

1. **La IA no redacta.** El motor de reglas resuelve el número de mail y las variables; la plantilla se renderiza tal cual. La IA solo interviene para entender la pregunta del cliente, extraer la referencia y el email, y para interpretar el historial en el caso de los mails 6 y 7.
2. **Si ninguna regla aplica, se escala.** Nunca se improvisa una respuesta sobre el estado de un pedido.
3. **Días hábiles siempre.** Ni un solo plazo del documento se cuenta en días naturales.
4. **Marca desconocida, estado desconocido o dato faltante → escalar.** Sin valores por defecto.

---

## 8. Puntos abiertos

Ninguno bloquea la definición de reglas, pero deben resolverse antes de desarrollar.

### 8.1 A confirmar con el cliente

| # | Punto | Impacto |
|---|---|---|
| 1 | ¿El retraso de "1 a 3 días" del mail 2 se cuenta en días hábiles o naturales? Asumido: **hábiles**, por coherencia con el resto. | Cambia el reparto entre mail 2 y mail 15 |
| 2 | ¿El plazo de 48h cuenta desde la fecha del pedido o desde el cobro? Para pagos por cheque puede haber varios días de diferencia. | Cálculo de retraso erróneo en pedidos por cheque |
| 3 | ¿Los textos se envían como email real o se muestran como respuesta en el chat? Están redactados como emails. | Alcance y tono |
| 4 | Identificación del cliente: la referencia sola no autentica. Propuesta: exigir referencia **más** email del pedido. | Riesgo RGPD |

### 8.2 A verificar en PrestaShop

| # | Punto |
|---|---|
| 5 | Lista de `order_states` con ID, nombre y banderas `paid` / `shipped` / `delivery`, para mapear los grupos A, B y C por ID y no por nombre |
| 6 | Si el módulo "Delivery Merchandise Returns" es el nativo o de terceros |
| 7 | Dónde vive el "délai" del historial que necesita el mail 6 |
| 8 | De dónde se lee el plazo de 48h: campo del producto o constante |

---

## Anexo: cambios aplicados respecto a los documentos originales

| Cambio | Motivo |
|---|---|
| `Paiement OK` → `Commande Terminé` en el grupo B | Renombrado por el cliente |
| `date cde - délais exp` → `date cde + délais exp` | Error de tipeo confirmado |
| Plazo `0` → `10` días en 6 marcas | Decisión del cliente; el 0 disparaba el mail 15 de inmediato |
| Mail 15 extendido a EN_STOCK con retraso > 3 días | Cerraba el único hueco de la matriz |
| Mono/multimarca se cuenta solo sobre productos sin stock | Decisión del cliente |
| Mail 4 pasa a formato de lista | Decisión del cliente |
| Mails 9 y 11 fuera de la fase 1 | Sin texto redactado y requieren integración con transportista |
| Mail 3 condicionado a la existencia de tracking | Salvaguarda añadida |
| Grupo D y marca desconocida → escalar | Casos no contemplados en los documentos originales |
