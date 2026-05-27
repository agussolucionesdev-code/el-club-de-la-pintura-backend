/**
 * Parses a `YYYY-MM-DD` string as **local midnight** on the server.
 *
 * Why this exists:
 *   `new Date("2026-05-26")` follows ISO 8601 — date-only strings are treated as
 *   UTC midnight. On a UTC-3 server (Argentina) that resolves to 2026-05-25 at
 *   21:00 local, i.e. the **previous** day. A subsequent `setHours(0,0,0,0)` then
 *   anchors to the wrong calendar day, causing range queries to miss records.
 *
 * Fix:
 *   Use `new Date(year, month - 1, day)` which always constructs in local time.
 *
 * @param dateStr - Date string in `YYYY-MM-DD` format.
 * @returns Date object representing midnight (00:00:00.000) in local time.
 */
export const parseLocalDate = (dateStr: string): Date => {
  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
};

/**
 * Returns a `{ from, to }` pair covering the full calendar day in local time.
 *
 * `from` = 00:00:00.000, `to` = 23:59:59.999 — both in the server's local timezone.
 * Use this for any "filter by date" query to avoid UTC-boundary issues.
 *
 * @param dateStr - Date string in `YYYY-MM-DD` format.
 */
export const localDayRange = (
  dateStr: string,
): { from: Date; to: Date } => {
  const from = parseLocalDate(dateStr);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setHours(23, 59, 59, 999);
  return { from, to };
};
