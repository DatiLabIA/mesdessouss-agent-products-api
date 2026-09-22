-- CreateTable
CREATE TABLE IF NOT EXISTS "product_materials" (
    "id" SERIAL NOT NULL,
    "client_id" VARCHAR(50) NOT NULL,
    "base_product_id" VARCHAR(50) NOT NULL,
    "fiber" VARCHAR(40) NOT NULL,
    "pct" INTEGER NOT NULL,
    "zone" VARCHAR(20) NOT NULL DEFAULT 'corps',
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_materials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "product_materials_client_id_base_product_id_fiber_zone_key" ON "product_materials"("client_id", "base_product_id", "fiber", "zone");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "product_materials_client_id_fiber_pct_idx" ON "product_materials"("client_id", "fiber", "pct");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "product_materials_client_id_base_product_id_idx" ON "product_materials"("client_id", "base_product_id");
