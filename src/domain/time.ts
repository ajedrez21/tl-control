const TZ = "America/Argentina/Buenos_Aires";

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function formatInZone(iso: string, timezone = TZ): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: timezone,
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

export function calendarDaysBetween(fromIso: string, toIso: string, timezone = TZ): number {
  const from = zonedYmd(fromIso, timezone);
  const to = zonedYmd(toIso, timezone);
  const utcFrom = Date.UTC(from.y, from.m - 1, from.d);
  const utcTo = Date.UTC(to.y, to.m - 1, to.d);
  return Math.max(0, Math.round((utcTo - utcFrom) / 86_400_000));
}

function zonedYmd(iso: string, timezone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(iso));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
