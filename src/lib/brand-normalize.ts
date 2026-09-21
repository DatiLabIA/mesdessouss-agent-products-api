/**
 * Normalización de nombres de marca para casar contra la tabla de plazos de
 * expedición (§2.4 de docs/reglas-lia-pedidos-retornos.md).
 *
 * La tabla de origen y los pedidos reales escriben la misma marca de formas
 * distintas: con o sin acento, con o sin espacio. Sin normalizar, esas
 * variantes no casan contra `rule_brand_lead_times` y la marca cae en
 * `unknownBrands`, forzando una escalada evitable.
 */

/**
 * Reduce `brand` a una clave comparable: NFD, se quitan las marcas
 * diacríticas, minúsculas, y se elimina todo lo que no sea alfanumérico.
 *
 * Así `"Simone Pérèle"` y `"Simone Perele"` producen la misma clave, y
 * `"Eden Park"` y `"EdenPark"` también.
 */
export function normalizeBrandKey(brand: string): string {
  return brand
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
