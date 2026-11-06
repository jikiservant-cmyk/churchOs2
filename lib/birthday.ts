/**
 * Birthdays — month and day only, never the year.
 *
 * A birthday SMS feature only needs to know WHEN to celebrate someone, and
 * church members are often sensitive about the year they were born. So the
 * whole feature is year-blind by design:
 *
 *  - Forms capture a month and a day; no year input exists at all.
 *  - The database `birthday` date column keeps a fixed placeholder year
 *    (2000 — chosen because a leap year is the only way a Feb-29 baby can
 *    be stored at all). The year is storage scaffolding, never data.
 *  - `normalizeBirthdayInput` rewrites ANY incoming year to the placeholder,
 *    so an imported `1987-06-05` becomes `2000-06-05`: nothing downstream —
 *    lists, exports, messages — can ever surface a real birth year.
 *  - Display helpers render "5 June", never "05/06/1987".
 *
 * The SQL twin of the matching rule lives in
 * church.enqueue_daily_birthdays (migrations/025_birthday_automation.sql):
 * a Feb-29 birthday is celebrated on Feb 28 of a non-leap year. Keep the two
 * in step — tests/birthday.test.ts pins this side.
 */

export const BIRTHDAY_PLACEHOLDER_YEAR = 2000;

/** Feeds every date composer; 2000 is a leap year, so Feb 29 is representable. */
const PLACEHOLDER_LEAP = BIRTHDAY_PLACEHOLDER_YEAR % 4 === 0
  && (BIRTHDAY_PLACEHOLDER_YEAR % 100 !== 0 || BIRTHDAY_PLACEHOLDER_YEAR % 400 === 0);

export const BIRTHDAY_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Real calendar length of a month in a given year — Feb 29 exists only in leap years. */
function daysInMonthOfYear(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) return 0;
  const perMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) return 29;
  return perMonth[month - 1];
}

/** Days in a month for the picker — February always offers 29 (placeholder year is leap). */
export function daysInBirthdayMonth(month: number): number {
  return daysInMonthOfYear(BIRTHDAY_PLACEHOLDER_YEAR, month);
}

export type BirthdayParts = { year: number; month: number; day: number };

/**
 * `2000-MM-DD` from picker parts, or '' when nothing valid was chosen.
 * month/day outside the calendar (Feb 30, month 13…) compose to ''.
 */
export function composeBirthdayValue(month: number, day: number): string {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return '';
  if (month < 1 || month > 12 || day < 1) return '';
  if (day > daysInBirthdayMonth(month)) return '';
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${BIRTHDAY_PLACEHOLDER_YEAR}-${mm}-${dd}`;
}

/** Month/day from any ISO date string; null when it is not a real calendar date. */
export function parseBirthdayParts(value: unknown): BirthdayParts | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  // Validated against the date's OWN year: 2001-02-29 is not a date, whatever
  // the placeholder year happens to be.
  const realLimit = daysInMonthOfYear(year, month);
  if (day > realLimit) return null;
  return { year, month, day };
}

/**
 * Server-side normalizer for anything a form or an import hands us. Accepts a
 * real ISO date, returns the SAME month/day under the placeholder year — the
 * year a member actually typed is deliberately discarded here, at the one
 * doorway every write passes through. Returns '' for blank input and null for
 * garbage, so callers can distinguish "no birthday" from "bad birthday".
 */
export function normalizeBirthdayInput(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const parts = parseBirthdayParts(trimmed);
  if (!parts) return null;
  return composeBirthdayValue(parts.month, parts.day);
}

/** "5 June" — the ONLY birthday shape a human is ever shown. */
export function formatBirthdayLabel(value: unknown): string {
  const parts = parseBirthdayParts(value);
  if (!parts) return '';
  return `${parts.day} ${BIRTHDAY_MONTHS[parts.month - 1]}`;
}

/**
 * Does this birthday fall on the given day? Mirrors the SQL rule exactly:
 * a Feb-29 birthday is celebrated on Feb 28 when the year is not a leap year.
 * `today` is an ISO date string — the caller owns the timezone (the cron uses
 * Africa/Kampala); this function never calls the clock itself so tests stay
 * deterministic.
 */
export function isBirthdayOn(birthday: unknown, today: string): boolean {
  const bd = parseBirthdayParts(birthday);
  const td = parseBirthdayParts(today);
  if (!bd || !td) return false;
  if (bd.month !== td.month) return false;
  if (bd.day === td.day) return true;
  return (
    bd.month === 2 && bd.day === 29 && td.day === 28 && !isLeapYear(td.year)
  );
}

export const BIRTHDAY_TEMPLATE_MAX = 320;
export const BIRTHDAY_TEMPLATE_PLACEHOLDERS = ['{name}', '{church}'] as const;

/**
 * A church's custom message: optional (falling back to the shared default in
 * the SQL function), length-capped so one birthday never becomes three billable
 * SMS segments, and allowed to reference {name} and {church}.
 */
export function validateBirthdayTemplate(template: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (template === null || template === undefined) return { ok: true, value: null };
  if (typeof template !== 'string') return { ok: false, error: 'The birthday message must be text.' };
  const trimmed = template.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (trimmed.length > BIRTHDAY_TEMPLATE_MAX) {
    return { ok: false, error: `Keep the birthday message under ${BIRTHDAY_TEMPLATE_MAX} characters (currently ${trimmed.length}).` };
  }
  return { ok: true, value: trimmed };
}

/** Fill {name} and {church}; unknown placeholders are left alone, not eaten. */
export function renderBirthdayMessage(template: string, memberName: string, churchName: string): string {
  return template
    .split('{name}').join(memberName)
    .split('{church}').join(churchName);
}

/** The message a member receives when the church has not written its own. */
export const BIRTHDAY_DEFAULT_TEMPLATE =
  'Happy Birthday {name}! Everyone at {church} celebrates you today. May God bless you with joy, good health and a blessed year ahead.';
