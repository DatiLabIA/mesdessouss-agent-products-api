-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "client_id" VARCHAR(50) NOT NULL,
    "product_id" VARCHAR(50) NOT NULL,
    "name" TEXT NOT NULL,
    "brand" VARCHAR(100),
    "type" VARCHAR(100),
    "sub_type" VARCHAR(200),
    "gender" VARCHAR(20) DEFAULT 'female',
    "price" DECIMAL(10,2),
    "old_price" DECIMAL(10,2),
    "has_discount" BOOLEAN NOT NULL DEFAULT false,
    "discount_pct" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT,
    "sizes" TEXT,
    "materials" TEXT,
    "styles" TEXT,
    "collection" VARCHAR(200),
    "product_url" TEXT,
    "image_url" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_policies" (
    "id" SERIAL NOT NULL,
    "client_id" VARCHAR(50) NOT NULL,
    "topic" VARCHAR(50) NOT NULL,
    "content" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_client_id_product_id_key" ON "products"("client_id", "product_id");
CREATE INDEX "products_client_id_type_idx" ON "products"("client_id", "type");
CREATE INDEX "products_client_id_brand_idx" ON "products"("client_id", "brand");
CREATE INDEX "products_client_id_gender_idx" ON "products"("client_id", "gender");
CREATE INDEX "products_client_id_price_idx" ON "products"("client_id", "price");
CREATE INDEX "products_client_id_active_idx" ON "products"("client_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "store_policies_client_id_topic_key" ON "store_policies"("client_id", "topic");
