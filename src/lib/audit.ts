import { prisma } from "./prisma";

interface LogQueryOptions {
  endpoint: string;
  input: Record<string, unknown>;
  resultCount?: number;
  durationMs?: number;
}

/**
 * Registra una llamada al tool en BD y consola.
 * Fire-and-forget: no bloquea la respuesta HTTP.
 */
export function logQuery(opts: LogQueryOptions): void {
  const { endpoint, input, resultCount, durationMs } = opts;

  console.log(
    `[audit] ${endpoint} | results=${resultCount ?? "?"} | ${durationMs ?? "?"}ms | input=${JSON.stringify(input)}`
  );

  prisma.queryLog
    .create({
      data: {
        endpoint,
        input,
        resultCount: resultCount ?? null,
        durationMs: durationMs ?? null,
      },
    })
    .catch((err) => {
      console.error("[audit] Error al guardar log:", err?.message);
    });
}
