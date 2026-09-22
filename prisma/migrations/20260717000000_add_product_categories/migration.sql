-- CreateTable
CREATE TABLE IF NOT EXISTS "product_categories" (
    "id" SERIAL NOT NULL,
    "client_id" VARCHAR(50) NOT NULL,
    "base_product_id" VARCHAR(50) NOT NULL,
    "category" VARCHAR(255) NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "product_categories_client_id_base_product_id_category_key" ON "product_categories"("client_id", "base_product_id", "category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "product_categories_client_id_category_idx" ON "product_categories"("client_id", "category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "product_categories_client_id_base_product_id_idx" ON "product_categories"("client_id", "base_product_id");
