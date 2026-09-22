-- CreateTable
CREATE TABLE "query_logs" (
    "id"           SERIAL NOT NULL,
    "endpoint"     VARCHAR(50) NOT NULL,
    "input"        JSONB NOT NULL,
    "result_count" INTEGER,
    "duration_ms"  INTEGER,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "query_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "query_logs_endpoint_idx" ON "query_logs"("endpoint");
CREATE INDEX "query_logs_created_at_idx" ON "query_logs"("created_at");
