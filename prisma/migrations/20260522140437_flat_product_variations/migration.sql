/*
  Warnings:

  - You are about to alter the column `color` on the `products` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(200)`.
  - You are about to alter the column `sizes` on the `products` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(200)`.
  - Added the required column `base_product_id` to the `products` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable (idempotente: IF NOT EXISTS maneja la ejecución parcial anterior)
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "base_product_id" VARCHAR(50) NOT NULL DEFAULT '';
UPDATE "products" SET "base_product_id" = SPLIT_PART("product_id", '_', 1) WHERE "base_product_id" = '';
ALTER TABLE "products" ALTER COLUMN "base_product_id" DROP DEFAULT;
ALTER TABLE "products" ALTER COLUMN "product_id" TYPE VARCHAR(100);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "products_client_id_base_product_id_idx" ON "products"("client_id", "base_product_id");
