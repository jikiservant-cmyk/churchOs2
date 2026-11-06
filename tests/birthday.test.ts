import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BIRTHDAY_PLACEHOLDER_YEAR,
  BIRTHDAY_TEMPLATE_MAX,
  composeBirthdayValue,
  daysInBirthdayMonth,
  formatBirthdayLabel,
  isBirthdayOn,
  normalizeBirthdayInput,
  parseBirthdayParts,
  renderBirthdayMessage,
  validateBirthdayTemplate,
  BIRTHDAY_DEFAULT_TEMPLATE,
} from '../lib/birthday.ts';

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('birthday capture — month and day only, never the year', () => {
  test('the picker value composes under the placeholder year', () => {
    assert.equal(composeBirthdayValue(6, 5), `${BIRTHDAY_PLACEHOLDER_YEAR}-06-05`);
    assert.equal(composeBirthdayValue(1, 31), `${BIRTHDAY_PLACEHOLDER_YEAR}-01-31`);
    assert.equal(composeBirthdayValue(2, 29), `${BIRTHDAY_PLACEHOLDER_YEAR}-02-29`, 'Feb 29 must be recordable');
    assert.equal(composeBirthdayValue(2, 30), '', 'Feb 30 is not a date');
    assert.equal(composeBirthdayValue(13, 1), '', 'no month 13');
    assert.equal(composeBirthdayValue(4, 31), '', 'April has 30 days');
    assert.equal(composeBirthdayValue(0, 5), '', 'nothing selected composes to empty');
    assert.equal(composeBirthdayValue(6, 0), '', 'nothing selected composes to empty');
    assert.equal(composeBirthdayValue(6.5, 5), '', 'fractional months are not months');
  });

  test('the picker offers the right number of days per month', () => {
    assert.equal(daysInBirthdayMonth(2), 29, 'the placeholder year is a leap year');
    assert.equal(daysInBirthdayMonth(1), 31);
    assert.equal(daysInBirthdayMonth(4), 30);
    assert.equal(daysInBirthdayMonth(0), 0);
    assert.equal(daysInBirthdayMonth(13), 0);
  });

  test('normalizeBirthdayInput strips the year at the doorway — every write passes through it', () => {
    assert.equal(normalizeBirthdayInput('1987-06-05'), '2000-06-05', 'a real birth year must not survive');
    assert.equal(normalizeBirthdayInput(' 2000-06-05 '), '2000-06-05', 'already-normalized stays');
    assert.equal(normalizeBirthdayInput('2001-02-29'), null, 'Feb 29 of a non-leap year is not a date');
    assert.equal(normalizeBirthdayInput('2000-02-30'), null);
    assert.equal(normalizeBirthdayInput(''), '', 'blank means no birthday');
    assert.equal(normalizeBirthdayInput('   '), '');
    assert.equal(normalizeBirthdayInput(null), '');
    assert.equal(normalizeBirthdayInput(undefined), '');
    assert.equal(normalizeBirthdayInput('5 June'), null, 'free text is not a date');
    assert.equal(normalizeBirthdayInput('1987-6-5'), null, 'only padded ISO dates are accepted');
    assert.equal(normalizeBirthdayInput(42), null, 'numbers are garbage, not dates');
  });

  test('a human is only ever shown "day month" — never a year', () => {
    assert.equal(formatBirthdayLabel('2000-06-05'), '5 June');
    assert.equal(formatBirthdayLabel('1987-12-25'), '25 December', 'even if a stray year exists, it is not shown');
    assert.equal(formatBirthdayLabel(''), '');
    assert.equal(formatBirthdayLabel(null), '');
    assert.equal(formatBirthdayLabel('not-a-date'), '');
  });

  test('parsing validates real calendar dates', () => {
    assert.deepEqual(parseBirthdayParts('2000-02-29'), { year: 2000, month: 2, day: 29 });
    assert.equal(parseBirthdayParts('1999-02-29'), null, '1999 is not a leap year');
    assert.equal(parseBirthdayParts('2000-00-10'), null);
    assert.equal(parseBirthdayParts('2000-13-01'), null);
  });
});

describe('birthday matching — the SQL rule in migrations/025, pinned here', () => {
  test('a birthday matches its own month and day', () => {
    assert.equal(isBirthdayOn('2000-06-05', '2026-06-05'), true);
    assert.equal(isBirthdayOn('2000-06-05', '2026-06-04'), false);
    assert.equal(isBirthdayOn('2000-06-05', '2026-07-05'), false, 'same day, wrong month');
  });

  test('a Feb-29 baby is celebrated on Feb 28 of a non-leap year — never twice, never never', () => {
    assert.equal(isBirthdayOn('2000-02-29', '2026-02-28'), true, '2026 is not a leap year: celebrate on the 28th');
    assert.equal(isBirthdayOn('2000-02-29', '2026-02-29'), false, 'Feb 29 does not exist in 2026');
    assert.equal(isBirthdayOn('2000-02-29', '2028-02-29'), true, '2028 is a leap year: celebrate on the day itself');
    assert.equal(isBirthdayOn('2000-02-29', '2028-02-28'), false, 'in a leap year the 28th is NOT the party');
    assert.equal(isBirthdayOn('2000-02-29', '2100-02-28'), true, '2100 is a century non-leap year — the SQL modulo rule');
    assert.equal(isBirthdayOn('2000-02-29', '2000-03-01'), false);
  });

  test('garbage in, no match out', () => {
    assert.equal(isBirthdayOn(null, '2026-06-05'), false);
    assert.equal(isBirthdayOn('2000-06-05', 'junk'), false);
    assert.equal(isBirthdayOn('', ''), false);
  });
});

describe('the birthday message template', () => {
  test('blank means "use the shared default", garbage is refused, length is capped', () => {
    assert.deepEqual(validateBirthdayTemplate(''), { ok: true, value: null });
    assert.deepEqual(validateBirthdayTemplate('   '), { ok: true, value: null });
    assert.deepEqual(validateBirthdayTemplate(null), { ok: true, value: null });
    assert.deepEqual(validateBirthdayTemplate(undefined), { ok: true, value: null });
    assert.deepEqual(validateBirthdayTemplate('  God bless you {name}!  '), { ok: true, value: 'God bless you {name}!' });
    assert.equal(validateBirthdayTemplate('x'.repeat(BIRTHDAY_TEMPLATE_MAX + 1)).ok, false);
    assert.equal(validateBirthdayTemplate(42).ok, false);
  });

  test('placeholders fill in; unknown ones are left alone', () => {
    assert.equal(
      renderBirthdayMessage(BIRTHDAY_DEFAULT_TEMPLATE, 'Sarah Nakato', 'Grace Church'),
      'Happy Birthday Sarah Nakato! Everyone at Grace Church celebrates you today. May God bless you with joy, good health and a blessed year ahead.',
    );
    assert.equal(renderBirthdayMessage('Blessings {name} from {church}!', 'A', 'B'), 'Blessings A from B!');
    assert.equal(renderBirthdayMessage('{name} {Name} {church}', 'X', 'Y'), 'X {Name} Y', 'placeholder match is exact');
    assert.equal(renderBirthdayMessage('no placeholders at all', 'X', 'Y'), 'no placeholders at all');
  });
});

describe('where the birthday guarantees are enforced', () => {
  test('migration 025 creates the opt-in table closed to browsers and an idempotent queue', () => {
    const migration = source('../migrations/025_birthday_automation.sql');
    // Assertions run against executable SQL only — the header's documentation
    // legitimately mentions the manual Vault step, which must stay manual.
    const code = migration.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    assert.match(migration, /enabled boolean NOT NULL DEFAULT false/, 'off by default: nothing sends without a pastor opting in');
    assert.match(migration, /REVOKE ALL ON church\.birthday_automation FROM anon, authenticated/);
    assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
    assert.match(migration, /TO service_role/, 'only the service role touches the table');
    assert.match(migration, /ON CONFLICT \(idempotency_key\) DO NOTHING/, 'a member can never be queued twice for the same birthday');
    assert.match(migration, /'bday:' \|\| t\.member_id::text \|\| ':' \|\| v_year::text/, 'the idempotency key binds member + year');
    assert.match(migration, /'Africa\/Kampala'/, 'the service runs on Kampala time');
    assert.match(migration, /date_part\('day', m\.birthday\) = 29[\s\S]*= 28/, 'Feb-29 → Feb-28 rule lives in the SQL too');
    assert.match(migration, /church-najiki-dispatch/, 'sending goes through the EXISTING dispatch function');
    assert.match(migration, /birthday-sms-daily-0500utc/, 'the daily schedule is part of the migration');
    assert.match(migration, /vault\.decrypted_secrets/, 'the dispatch secret comes from Vault, never from SQL source');
    assert.ok(!/vault\.create_secret/.test(code), 'the migration must not invent a secret value');
  });

  test('the settings screen change goes through the pastor check', () => {
    const actions = source('../lib/church-settings-actions.ts');
    assert.match(actions, /updateBirthdayWishes/);
    assert.match(actions, /assertChurchAdminAuth\(churchSlug, \['pastor'\]\)/, 'only the pastor toggles birthday wishes');
    assert.match(actions, /from\('birthday_automation'\)/);
    assert.match(actions, /validateBirthdayTemplate/, 'the template is validated server-side, not trusted from the browser');
  });

  test('every birthday write is normalized — forms cannot leak a year', () => {
    const members = source('../app/c/[church_slug]/admin/(authenticated)/members/actions.ts');
    const visitors = source('../app/c/[church_slug]/admin/(authenticated)/visitors/actions.ts');
    for (const [name, src] of [['members', members], ['visitors', visitors]] as const) {
      assert.match(src, /normalizeBirthdayInput\(formData\.get\('birthday'\)\)/, `${name}: add path normalizes`);
      assert.equal((src.match(/normalizeBirthdayInput\(/g) ?? []).length >= 3, true, `${name}: edit and conversion paths normalize too`);
      assert.ok(!/formData\.get\('birthday'\)\s+as string/.test(src), `${name}: the raw form value must not be trusted as a date`);
    }
  });

  test('the forms render the year-blind picker, not a date input', () => {
    for (const path of [
      '../app/c/[church_slug]/admin/(authenticated)/members/page.tsx',
      '../app/c/[church_slug]/admin/(authenticated)/members/edit/[id]/page.tsx',
      '../app/c/[church_slug]/admin/(authenticated)/visitors/page.tsx',
      '../app/c/[church_slug]/admin/(authenticated)/visitors/edit/[id]/page.tsx',
    ]) {
      const src = source(path);
      assert.match(src, /<BirthdayPicker/, `${path}: uses BirthdayPicker`);
      assert.ok(!/type="date"/.test(src), `${path}: no year-bearing date input may remain`);
    }
  });
});
