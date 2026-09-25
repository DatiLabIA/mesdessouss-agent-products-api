-- Nueva condicion de la matriz de decision (T2): si ya hay (o no hay) reembolso
-- registrado para el pedido. Solo la usan las dos filas del grupo R (bloque
-- RETORNO, §3.2): antes de esto una sola fila mandaba todo estado 61 a MAIL_12,
-- aunque no hubiera abono todavia, y `processed_date` no se podia resolver
-- (§ hallazgo A.6, docs/hallazgos-conversaciones-flow-test.md).
--
-- Idempotente (`ADD COLUMN IF NOT EXISTS`), mismo patron que
-- 20260831000000_add_category_kind y 20260921000000_add_rules_engine: ver
-- prisma/migrations/README.md sobre por que las migraciones nuevas de este
-- repositorio no pueden asumir una base vacia.
--
-- NULL por defecto (sin DEFAULT): es un comodin valido para toda fila que no
-- sea del grupo R, igual que `has_tracking`/`history_has_info`, nunca "false"
-- para no inventar una condicion que la fila no tenia.

ALTER TABLE "rule_decisions"
  ADD COLUMN IF NOT EXISTS "refund_issued" BOOLEAN;
