'use client';

import { useMemo, useState } from 'react';
import {
  BIRTHDAY_MONTHS,
  composeBirthdayValue,
  daysInBirthdayMonth,
  parseBirthdayParts,
} from '@/lib/birthday';

/**
 * Year-blind birthday capture: a month and a day, nothing else.
 *
 * There is no year input by design — members are sensitive about their year,
 * and the birthday-wishes feature never needs it. The submitted value is the
 * standard `birthday` form field as a `2000-MM-DD` date: 2000 is a fixed
 * placeholder (a leap year, so Feb-29 babies can be recorded), and the server
 * actions normalise any year away again, so a real birth year can never reach
 * the database through this component even in a hand-edited request.
 */
export default function BirthdayPicker({
  defaultValue,
  className = 'w-full rounded-xl border border-[rgba(90,55,20,0.1)] bg-[rgba(255,220,170,0.05)] px-3 py-2.5 text-sm font-medium text-[#1E1208] outline-none transition-colors appearance-none focus:border-[#B5622A]',
}: {
  /** An existing stored birthday, e.g. "2000-06-05" (any year is accepted and ignored). */
  defaultValue?: string | null;
  className?: string;
}) {
  const initial = useMemo(() => parseBirthdayParts(defaultValue ?? ''), [defaultValue]);
  const [month, setMonth] = useState(initial?.month ?? 0);
  const [day, setDay] = useState(initial?.day ?? 0);

  const dayOptions = month >= 1 && month <= 12 ? daysInBirthdayMonth(month) : 31;
  const effectiveDay = day <= dayOptions ? day : 0;
  const value = composeBirthdayValue(month, effectiveDay);

  return (
    <div className="grid grid-cols-2 gap-2" aria-label="Birthday (day and month only — the year is never stored)">
      <input type="hidden" name="birthday" value={value} />
      <select
        aria-label="Birth month"
        value={month}
        onChange={(event) => setMonth(Number(event.target.value))}
        className={className}
      >
        <option value={0}>Month...</option>
        {BIRTHDAY_MONTHS.map((label, index) => (
          <option key={label} value={index + 1}>{label}</option>
        ))}
      </select>
      <select
        aria-label="Birth day"
        value={effectiveDay}
        onChange={(event) => setDay(Number(event.target.value))}
        disabled={month === 0}
        className={`${className} disabled:opacity-40`}
      >
        <option value={0}>Day...</option>
        {Array.from({ length: dayOptions }, (_, index) => index + 1).map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
    </div>
  );
}
