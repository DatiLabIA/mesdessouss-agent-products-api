-- CreateTable
CREATE TABLE "rule_sets" (
    "id" SERIAL NOT NULL,
    "client_id" VARCHAR(50) NOT NULL,
    "version" INTEGER NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMP(3),

    CONSTRAINT "rule_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_state_groups" (
    "id" SERIAL NOT NULL,
    "rule_set_id" INTEGER NOT NULL,
    "order_state_id" INTEGER NOT NULL,
    "state_name" VARCHAR(120),
    "group_code" VARCHAR(1) NOT NULL,

    CONSTRAINT "rule_state_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_brand_lead_times" (
    "id" SERIAL NOT NULL,
    "rule_set_id" INTEGER NOT NULL,
    "brand" VARCHAR(100) NOT NULL,
    "brand_key" VARCHAR(100) NOT NULL,
    "lead_days" INTEGER NOT NULL,

    CONSTRAINT "rule_brand_lead_times_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_decisions" (
    "id" SERIAL NOT NULL,
    "rule_set_id" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL,
    "state_group" VARCHAR(1),
    "stock_status" VARCHAR(10),
    "brand_count" VARCHAR(4),
    "delay_bucket" VARCHAR(10),
    "has_tracking" BOOLEAN,
    "history_has_info" BOOLEAN,
    "outcome" VARCHAR(20) NOT NULL,
    "note" TEXT,

    CONSTRAINT "rule_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_templates" (
    "id" SERIAL NOT NULL,
    "rule_set_id" INTEGER NOT NULL,
    "outcome" VARCHAR(20) NOT NULL,
    "lang" VARCHAR(5) NOT NULL,
    "body" TEXT NOT NULL,
    "facts_to_convey" JSONB NOT NULL,
    "must_not_claim" JSONB NOT NULL,

    CONSTRAINT "rule_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_settings" (
    "id" SERIAL NOT NULL,
    "rule_set_id" INTEGER NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "value" JSONB NOT NULL,
    "note" TEXT,

    CONSTRAINT "rule_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_holidays" (
    "id" SERIAL NOT NULL,
    "client_id" VARCHAR(50) NOT NULL,
    "day" DATE NOT NULL,
    "label" VARCHAR(120),

    CONSTRAINT "rule_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_sets_client_id_status_idx" ON "rule_sets"("client_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rule_sets_client_id_version_key" ON "rule_sets"("client_id", "version");

-- CreateIndex
CREATE INDEX "rule_state_groups_rule_set_id_group_code_idx" ON "rule_state_groups"("rule_set_id", "group_code");

-- CreateIndex
CREATE UNIQUE INDEX "rule_state_groups_rule_set_id_order_state_id_key" ON "rule_state_groups"("rule_set_id", "order_state_id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_brand_lead_times_rule_set_id_brand_key_key" ON "rule_brand_lead_times"("rule_set_id", "brand_key");

-- CreateIndex
CREATE INDEX "rule_decisions_rule_set_id_state_group_idx" ON "rule_decisions"("rule_set_id", "state_group");

-- CreateIndex
CREATE UNIQUE INDEX "rule_decisions_rule_set_id_priority_key" ON "rule_decisions"("rule_set_id", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "rule_templates_rule_set_id_outcome_lang_key" ON "rule_templates"("rule_set_id", "outcome", "lang");

-- CreateIndex
CREATE UNIQUE INDEX "rule_settings_rule_set_id_key_key" ON "rule_settings"("rule_set_id", "key");

-- CreateIndex
CREATE INDEX "rule_holidays_client_id_day_idx" ON "rule_holidays"("client_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "rule_holidays_client_id_day_key" ON "rule_holidays"("client_id", "day");

-- AddForeignKey
ALTER TABLE "rule_state_groups" ADD CONSTRAINT "rule_state_groups_rule_set_id_fkey" FOREIGN KEY ("rule_set_id") REFERENCES "rule_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_brand_lead_times" ADD CONSTRAINT "rule_brand_lead_times_rule_set_id_fkey" FOREIGN KEY ("rule_set_id") REFERENCES "rule_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_decisions" ADD CONSTRAINT "rule_decisions_rule_set_id_fkey" FOREIGN KEY ("rule_set_id") REFERENCES "rule_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_templates" ADD CONSTRAINT "rule_templates_rule_set_id_fkey" FOREIGN KEY ("rule_set_id") REFERENCES "rule_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_settings" ADD CONSTRAINT "rule_settings_rule_set_id_fkey" FOREIGN KEY ("rule_set_id") REFERENCES "rule_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Como maximo UN conjunto de reglas activo por cliente, garantizado por la base y
-- no por la aplicacion. Prisma no sabe expresar un indice unico parcial, asi que va
-- a mano: si dos publicaciones compiten, la segunda falla en vez de dejar dos
-- conjuntos activos y que la respuesta al cliente dependa de cual se lea primero.
CREATE UNIQUE INDEX "rule_sets_one_active_per_client"
  ON "rule_sets" ("client_id")
  WHERE "status" = 'active';
