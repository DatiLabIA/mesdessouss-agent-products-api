import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { addBusinessDays, countBusinessDaysBetween, frenchPublicHolidays, isBusinessDay, toDateKey } from "./business-days";

function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function holidayDay(holidays: ReturnType<typeof frenchPublicHolidays>, label: string): string | undefined {
  return holidays.find((h) => h.label === label)?.day;
}

describe("frenchPublicHolidays", () => {
  test("Pascua y los tres festivos móviles de 2024, contra fechas reales conocidas", () => {
    const holidays = frenchPublicHolidays(2024);
    assert.equal(holidayDay(holidays, "Lundi de Pâques"), "2024-04-01");
    assert.equal(holidayDay(holidays, "Ascension"), "2024-05-09");
    assert.equal(holidayDay(holidays, "Lundi de Pentecôte"), "2024-05-20");
  });

  test("Pascua y los tres festivos móviles de 2025, contra fechas reales conocidas", () => {
    const holidays = frenchPublicHolidays(2025);
    assert.equal(holidayDay(holidays, "Lundi de Pâques"), "2025-04-21");
    assert.equal(holidayDay(holidays, "Ascension"), "2025-05-29");
    assert.equal(holidayDay(holidays, "Lundi de Pentecôte"), "2025-06-09");
  });

  test("Pascua y los tres festivos móviles de 2026, contra fechas reales conocidas", () => {
    const holidays = frenchPublicHolidays(2026);
    assert.equal(holidayDay(holidays, "Lundi de Pâques"), "2026-04-06");
    assert.equal(holidayDay(holidays, "Ascension"), "2026-05-14");
    assert.equal(holidayDay(holidays, "Lundi de Pentecôte"), "2026-05-25");
  });

  test("incluye los ocho festivos fijos", () => {
    const holidays = frenchPublicHolidays(2026);
    assert.equal(holidayDay(holidays, "Jour de l'An"), "2026-01-01");
    assert.equal(holidayDay(holidays, "Fête du Travail"), "2026-05-01");
    assert.equal(holidayDay(holidays, "Victoire 1945"), "2026-05-08");
    assert.equal(holidayDay(holidays, "Fête Nationale"), "2026-07-14");
    assert.equal(holidayDay(holidays, "Assomption"), "2026-08-15");
    assert.equal(holidayDay(holidays, "Toussaint"), "2026-11-01");
    assert.equal(holidayDay(holidays, "Armistice"), "2026-11-11");
    assert.equal(holidayDay(holidays, "Noël"), "2026-12-25");
    assert.equal(holidays.length, 11);
  });
});

describe("isBusinessDay", () => {
  test("sábado y domingo no son días hábiles", () => {
    assert.equal(isBusinessDay(utc(2026, 1, 3), new Set()), false); // sábado
    assert.equal(isBusinessDay(utc(2026, 1, 4), new Set()), false); // domingo
  });

  test("un festivo del set tampoco es día hábil, aunque sea entre semana", () => {
    assert.equal(isBusinessDay(utc(2026, 1, 6), new Set(["2026-01-06"])), false);
  });

  test("un martes cualquiera fuera del set es día hábil", () => {
    assert.equal(isBusinessDay(utc(2026, 1, 6), new Set()), true);
  });
});

describe("addBusinessDays", () => {
  test("salta el fin de semana", () => {
    // Viernes 2026-01-02 + 1 día hábil → salta sábado y domingo → lunes 2026-01-05.
    const result = addBusinessDays(utc(2026, 1, 2), 1, new Set());
    assert.equal(toDateKey(result), "2026-01-05");
  });

  test("salta un festivo entre semana", () => {
    // Lunes 2026-01-05 + 1 día hábil, con el martes 2026-01-06 como festivo → miércoles 2026-01-07.
    const result = addBusinessDays(utc(2026, 1, 5), 1, new Set(["2026-01-06"]));
    assert.equal(toDateKey(result), "2026-01-07");
  });

  test("con 0 días devuelve la fecha civil de origen sin tocar", () => {
    const result = addBusinessDays(utc(2026, 1, 5), 0, new Set());
    assert.equal(toDateKey(result), "2026-01-05");
  });
});

describe("countBusinessDaysBetween", () => {
  test("devuelve 0 si `to` es igual a `from`", () => {
    assert.equal(countBusinessDaysBetween(utc(2026, 1, 5), utc(2026, 1, 5), new Set()), 0);
  });

  test("devuelve 0 si `to` es anterior a `from`", () => {
    assert.equal(countBusinessDaysBetween(utc(2026, 1, 5), utc(2026, 1, 1), new Set()), 0);
  });

  test("cuenta los días hábiles entre dos lunes consecutivos, saltando el fin de semana", () => {
    // 2026-01-05 (lunes) → 2026-01-12 (lunes siguiente): martes a viernes + el propio lunes = 5.
    assert.equal(countBusinessDaysBetween(utc(2026, 1, 5), utc(2026, 1, 12), new Set()), 5);
  });

  test("un festivo dentro del rango resta un día del conteo", () => {
    const holidays = new Set(["2026-01-06"]);
    assert.equal(countBusinessDaysBetween(utc(2026, 1, 5), utc(2026, 1, 12), holidays), 4);
  });
});
