-- Clasificación y normalización de categorías.
-- `kind`: taxonomia | marca | coleccion | promo — el feed mezcla las cuatro.
-- `canonical`: grafía canónica del concepto, para que "Boxers, shorties" y
-- "Boxers & shorties" se encuentren entre sí.
-- Aditivo: no se borra ningún par, solo se etiqueta. El sync rellena ambas.

ALTER TABLE "product_categories"
  ADD COLUMN IF NOT EXISTS "kind" VARCHAR(20) NOT NULL DEFAULT 'taxonomia';

ALTER TABLE "product_categories"
  ADD COLUMN IF NOT EXISTS "canonical" VARCHAR(255);

-- Hasta el primer sync, la canónica es el propio nombre.
UPDATE "product_categories" SET "canonical" = "category" WHERE "canonical" IS NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "product_categories_client_id_kind_idx"
  ON "product_categories"("client_id", "kind");

CREATE INDEX IF NOT EXISTS "product_categories_client_id_canonical_idx"
  ON "product_categories"("client_id", "canonical");
