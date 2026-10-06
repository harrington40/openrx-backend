/**
 * Shared laboratory result helpers.
 *
 * Single source of truth for how a result is flagged and how a "Normal Value"
 * (reference range) is printed, used by BOTH lab screens:
 *   - features/labreports/LabResultFormPage  (Patient Laboratory Result Form)
 *   - features/labs/LabDashboardPage         (Lab Management → results)
 *
 * Keeping this in one place is what makes the Lab Management dashboard and the
 * Result Form agree on every value, unit, normal range and flag.
 */

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

/**
 * Flag a typed result: LOW / HIGH / NORMAL for numeric tests with a range,
 * POSITIVE / NEGATIVE for positive-negative tests, TEXT for non-numeric input.
 */
export function computeFlag(resultType: string, value: string, refMin?: any, refMax?: any): string {
  if (!value) return '';
  if (resultType === 'NUMERIC' && (refMin != null || refMax != null)) {
    const n = Number(value);
    if (isNaN(n)) return 'TEXT';
    if (refMin != null && n < Number(refMin)) return 'LOW';
    if (refMax != null && n > Number(refMax)) return 'HIGH';
    return 'NORMAL';
  }
  if (resultType === 'POSITIVE_NEGATIVE') {
    const v = value.toLowerCase();
    if (['negative', 'non-reactive', 'non reactive'].includes(v)) return 'NEGATIVE';
    if (['positive', 'reactive'].includes(v)) return 'POSITIVE';
  }
  return '';
}

/** Convenience: flag a catalog test row against a typed value. */
export const flagForTest = (test: any, value: string): string =>
  computeFlag(test?.result_type, value, test?.ref_min, test?.ref_max);

/** Bootstrap badge class for a flag. */
export const flagBadge = (f: string): string =>
  f === 'LOW' ? 'bg-warning text-dark'
    : f === 'HIGH' ? 'bg-danger'
      : f === 'NORMAL' ? 'bg-success'
        : f === 'POSITIVE' ? 'bg-danger'
          : f === 'NEGATIVE' ? 'bg-success'
            : 'bg-secondary';

/** Printed "Normal Value" for a catalog test (ref_text wins over min–max). */
export const refText = (t: any): string =>
  t?.ref_text || (t?.ref_min != null && t?.ref_max != null
    ? `${t.ref_min} - ${t.ref_max}`
    : t?.ref_min != null ? `≥ ${t.ref_min}` : t?.ref_max != null ? `≤ ${t.ref_max}` : '—');

/**
 * Fallback flag for a stored result row that has no matching catalog entry:
 * maps the legacy binary `abnormal` flag onto the same LOW/HIGH scale.
 */
export const flagFromStored = (stored: any): string =>
  stored?.abnormal === 'Y' ? 'HIGH' : stored?.abnormal === 'N' ? 'NORMAL' : '';
