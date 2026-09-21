# Migraciones

Las migraciones son código fuente y se versionan. `pnpm start:prod` ejecuta
`prisma migrate deploy`, que las aplica **desde el repositorio**: si no están acá,
no llegan a producción.

## Antes de desplegar en un entorno nuevo

Este esquema se mantuvo un tiempo fuera de Prisma, y eso deja una trampa.

Las tres primeras migraciones (`0001_init`, `0002_query_logs`,
`20260522133912_add_product_quantity`) usan DDL **no idempotente**: `CREATE TABLE`
y `ADD COLUMN` sin guardas. En una base vacía funcionan perfecto, que es para lo
que están. El problema es otro escenario:

> Una base que **ya tiene las tablas** pero **no tiene las filas** correspondientes
> en `_prisma_migrations`.

Ahí `prisma migrate deploy` aborta con `relation already exists`, marca la migración
como fallida (P3009) y **bloquea todas las posteriores**, incluidas las del motor de
reglas. No se recupera solo.

Si te encontrás en ese caso, hay que baselinear antes del primer deploy:

```bash
prisma migrate resolve --applied 0001_init
prisma migrate resolve --applied 0002_query_logs
prisma migrate resolve --applied 20260522133912_add_product_quantity
# …y así con cada migración cuyos objetos ya existan en esa base
```

Después ya sí, `prisma migrate deploy`.

**No se editan las migraciones ya aplicadas** para agregarles guardas. Prisma guarda
un checksum de cada una en `_prisma_migrations`; cambiar el contenido de una aplicada
es arriesgar romper el despliegue de una base que hoy funciona, a cambio de cubrir un
escenario que se resuelve con `migrate resolve`.

## Para las migraciones nuevas

Escribilas idempotentes, como las posteriores a `20260522140437`:

- `CREATE TABLE IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS`
- Claves foráneas envueltas, porque Postgres no admite `IF NOT EXISTS` en
  `ADD CONSTRAINT`:

```sql
DO $$ BEGIN
  ALTER TABLE "x" ADD CONSTRAINT "x_y_fkey" FOREIGN KEY ("y") REFERENCES "z"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

## Estado actual

La base de `DATABASE_URL` apunta a un host remoto compartido. A 2026-09-21 tiene
aplicadas las 7 primeras migraciones y quedan dos pendientes:

- `20260831000000_add_category_kind`
- `20260921000000_add_rules_engine`

`pnpm migrate:deploy` aplica **las dos**.
