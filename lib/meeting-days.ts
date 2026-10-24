export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * Validates and canonicalizes the church meeting-day setting.
 * ISO weekdays are 1=Monday through 7=Sunday. Empty arrays are rejected
 * because the database constraint requires at least one configured day;
 * NULL in the database remains the legacy meaning of no weekday filter.
 */
export function normalizeMeetingDays(input: unknown): number[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 7) return null;
  if (!input.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) return null;
  return [...new Set(input as number[])].sort((a, b) => a - b);
}
