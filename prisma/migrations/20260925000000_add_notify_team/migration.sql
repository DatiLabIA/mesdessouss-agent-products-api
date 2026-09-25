-- Nueva columna de plantilla (T4): si este desenlace tiene que marcarse para que el equipo lo
-- revise (ej. MAIL_15, cuyo texto promete "nous reviendrons vers vous dans un délai de 48 heures").
-- Esto SOLO pone la bandera que viaja como `guidance.notify_team` en el payload de order_lookup; la
-- notificación real (Zimbra u otra) se habilita en otro lugar, fuera del alcance de esta tarea
-- (decisión del usuario, § hallazgo 7 "je viens de transmettre votre demande" de
-- docs/hallazgos-conversaciones-flow-test.md).
--
-- Idempotente (`ADD COLUMN IF NOT EXISTS`), mismo patron que 20260831000000_add_category_kind,
-- 20260921000000_add_rules_engine y 20260924000000_add_refund_issued: ver
-- prisma/migrations/README.md sobre por que las migraciones nuevas de este repositorio no pueden
-- asumir una base vacia.
--
-- `NOT NULL DEFAULT false`, a diferencia de `refund_issued` (nullable): acá SÍ hay un valor por
-- defecto correcto para toda fila existente — "no marcada" es lo mismo que decir "esta plantilla,
-- sembrada antes de T4, nunca prometió un seguimiento del equipo" — así que no hace falta un
-- comodín NULL. Postgres además backfillea este DEFAULT a las filas ya existentes, así que un
-- conjunto de reglas activo sembrado por la versión anterior de order-rules-seed.ts nunca queda con
-- la columna sin valor: la tarea T4 documenta esto también en el código (parseTemplates admite
-- notifyTeam ausente igual, por si alguna fila llegara sin la columna por otra vía).
--
-- NO se aplica a ninguna base con esta tarea (T4): solo se corre `pnpm generate` para regenerar el
-- cliente de Prisma. `prisma migrate deploy` la aplicará en el próximo despliegue, junto con las
-- pendientes de README.md.

ALTER TABLE "rule_templates"
  ADD COLUMN IF NOT EXISTS "notify_team" BOOLEAN NOT NULL DEFAULT false;
