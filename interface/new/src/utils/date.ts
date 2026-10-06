/** Format a date/datetime value to a clean "YYYY-MM-DD" string for display. */
export function formatDateOnly(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const s = String(value).trim();
  if (!s) return '—';
  // Handles full ISO datetimes, "YYYY-MM-DD", and "YYYY-MM-DD HH:mm:ss" strings.
  return s.slice(0, 10);
}

/**
 * Local-safe `YYYY-MM-DD` for `<input type="date">` and API params.
 *
 * `toISOString().split('T')[0]` converts to UTC first, which shifts the date by
 * a day for anyone behind UTC (that is where the stray "T22:00:00.000Z" values
 * came from). This formats the *local* calendar date instead.
 */
export function toDateInput(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value).slice(0, 10);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Human-readable date, e.g. "Sep 18, 2026". */
export function formatDateHuman(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

/** Human-readable date + time, e.g. "Sep 18, 2026, 04:10 PM". */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value).replace('T', ' ').slice(0, 16);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}
