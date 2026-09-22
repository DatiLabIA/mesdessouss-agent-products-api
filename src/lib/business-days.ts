/**
 * Días hábiles y festivos de Francia metropolitana, para el cálculo de plazos
 * del motor de reglas (§2.4 y §2.5 de docs/reglas-lia-pedidos-retornos.md).
 *
 * Todo el módulo trabaja en fecha civil (UTC, sin hora): se lee y se escribe
 * siempre con los métodos `UTC*` de `Date`, nunca con los locales, para que un
 * cambio de huso horario del proceso que ejecuta el código no mueva un día de
 * cálculo. Los llamadores deben construir sus fechas de entrada del mismo
 * modo (`new Date(Date.UTC(...))` o una fecha ISO `AAAA-MM-DD`, que el motor
 * de JavaScript interpreta como medianoche UTC).
 *
 * Los festivos se reciben siempre como parámetro (`holidays`): en producción
 * vienen de la tabla `rule_holidays`, editable sin desplegar. Este módulo no
 * conoce esa tabla ni ninguna otra fuente de datos.
 */

/** Fecha civil en formato `AAAA-MM-DD`, la misma forma que usa el set de festivos. */
export function toDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Medianoche UTC del mismo año/mes/día que `date`, descartando cualquier hora. */
function civilDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * `true` si `date` es un día hábil: ni sábado, ni domingo, ni una fecha
 * presente en `holidays` (claves `AAAA-MM-DD`).
 */
export function isBusinessDay(date: Date, holidays: Set<string>): boolean {
  const weekday = date.getUTCDay(); // 0 = domingo … 6 = sábado
  if (weekday === 0 || weekday === 6) return false;
  return !holidays.has(toDateKey(date));
}

/**
 * Avanza `days` días hábiles desde `from`. `from` mismo nunca cuenta como uno
 * de los días avanzados, aunque sea hábil: el conteo empieza en el primer día
 * hábil posterior. Con `days = 0` devuelve la fecha civil de `from` sin tocar.
 */
export function addBusinessDays(from: Date, days: number, holidays: Set<string>): Date {
  const result = civilDate(from);
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (isBusinessDay(result, holidays)) {
      remaining -= 1;
    }
  }
  return result;
}

/**
 * Cuenta los días hábiles entre `from` (exclusivo) y `to` (inclusivo).
 * Devuelve 0 si `to <= from`, tratando ambas fechas como fecha civil (sin hora).
 */
export function countBusinessDaysBetween(from: Date, to: Date, holidays: Set<string>): number {
  const fromTime = civilDate(from).getTime();
  const toTime = civilDate(to).getTime();
  if (toTime <= fromTime) return 0;

  const cursor = new Date(fromTime);
  let count = 0;
  while (cursor.getTime() < toTime) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isBusinessDay(cursor, holidays)) {
      count += 1;
    }
  }
  return count;
}

/** Suma `days` días naturales a `date`, en UTC. */
function addCalendarDaysUTC(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Domingo de Pascua para `year`, algoritmo de Meeus/Butcher (anónimo
 * gregoriano). Devuelve mes (1-12) y día porque es un paso intermedio, no una
 * fecha con huso propio.
 */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = marzo, 4 = abril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/**
 * Festivos fijos y móviles de Francia metropolitana para `year`.
 *
 * No lee ninguna tabla ni tiene efectos: existe para sembrar `rule_holidays`,
 * que es de donde los lee producción de verdad (se inyectan como `holidays`
 * en `computeOrderFacts` y en las funciones de este módulo).
 *
 * Fijos: Jour de l'An, Fête du Travail, Victoire 1945, Fête Nationale,
 * Assomption, Toussaint, Armistice, Noël.
 * Móviles, derivados del domingo de Pascua: Lundi de Pâques (+1 día),
 * Ascension (+39 días), Lundi de Pentecôte (+50 días).
 */
export function frenchPublicHolidays(year: number): Array<{ day: string; label: string }> {
  const easter = easterSunday(year);
  const easterDate = new Date(Date.UTC(year, easter.month - 1, easter.day));

  const fixed: Array<{ day: string; label: string }> = [
    { day: `${year}-01-01`, label: "Jour de l'An" },
    { day: `${year}-05-01`, label: "Fête du Travail" },
    { day: `${year}-05-08`, label: "Victoire 1945" },
    { day: `${year}-07-14`, label: "Fête Nationale" },
    { day: `${year}-08-15`, label: "Assomption" },
    { day: `${year}-11-01`, label: "Toussaint" },
    { day: `${year}-11-11`, label: "Armistice" },
    { day: `${year}-12-25`, label: "Noël" },
  ];

  const movable: Array<{ day: string; label: string }> = [
    { day: toDateKey(addCalendarDaysUTC(easterDate, 1)), label: "Lundi de Pâques" },
    { day: toDateKey(addCalendarDaysUTC(easterDate, 39)), label: "Ascension" },
    { day: toDateKey(addCalendarDaysUTC(easterDate, 50)), label: "Lundi de Pentecôte" },
  ];

  return [...fixed, ...movable];
}
