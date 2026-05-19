# ─── Stage 1: Instalar dependencias ──────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.16.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ─── Stage 2: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.16.1 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Genera el cliente Prisma (usa fallback en prisma.config.ts si no hay DATABASE_URL)
RUN pnpm generate

# Compila TypeScript → dist/
RUN pnpm build

# ─── Stage 3: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.16.1 --activate

# Solo dependencias de producción
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copiar el cliente Prisma generado (node_modules/@prisma/client/runtime/*)
COPY --from=build /app/node_modules/.pnpm /app/node_modules/.pnpm
COPY --from=build /app/node_modules/@prisma /app/node_modules/@prisma

# Artefactos compilados y schema de Prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts

EXPOSE 3000

# Corre las migraciones pendientes y luego arranca el servidor
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/server.js"]
