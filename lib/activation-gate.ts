/**
 * Single source of truth for "has this church paid its activation fee yet?".
 *
 * Why this file exists: the same question used to be answered three different
 * ways, and they disagreed.
 *
 *   - `lib/db.ts` (`getChurchBySlug`) reported a missing status as `'active'`.
 *   - the admin layout gated only on the exact string `'pending_payment'`.
 *   - `lib/activation` reported a missing status as `'pending_payment'`.
 *
 * `activation_status` is not declared in `supabase-schema.sql`, and no
 * migration in this repository creates it — so a church row written by a path
 * that omits the column (or by an older deploy) has `NULL`, which
 * `getChurchBySlug` turned into `'active'`. That unpaid church then sailed
 * through the layout gate, and the activation page redirected it *away*
 * (`status === 'active'`), which is why the payment screen looked like it came
 * and went at random. The rules below are the only place this is decided.
 *
 * Decisions:
 *   'allow'     — the church is in good standing; normal routing continues.
 *   'pay'       — activation is required; every entry point must land on the
 *                 activation screen, not the login screen and not the dashboard.
 *   'suspended' — deliberately blocked; the admin layout shows its own notice
 *                 (paying does not un-suspend a church — see migrations/008).
 */

/** Statuses that mean "settled". Spelling-tolerant, but never invented. */
const SETTLED_STATUSES = new Set(['active', 'activated', 'paid']);
const SUSPENDED_STATUS = 'suspended';

export type ActivationGateDecision = 'allow' | 'pay' | 'suspended';

/** The only church columns this decision needs. */
export interface ActivationGateRow {
  activation_status?: string | null;
  activation_paid_at?: string | null;
}

export interface ActivationGateVerdict {
  decision: ActivationGateDecision;
  /** Stable machine-readable reason, safe to log. Never contains PII. */
  reason: string;
}

export interface ActivationGateOptions {
  /**
   * How to treat a church whose `activation_status` column is NULL or empty.
   * Such rows exist on databases that predate migrations/017, and some of them
   * are congregations that were onboarded before billing existed — so the
   * default grandfathers them rather than locking a paying church out.
   * Set `ACTIVATION_GATE_LEGACY_NULL=pay` once you have reviewed (or backfilled)
   * the rows listed by `scripts/activation-gate-audit.sql`.
   */
  nullPolicy?: 'allow' | 'pay';
}

function normalizeStatus(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Pure decision function. `row` may be null/undefined — an unreadable church
 * row is never treated as paid, because "no data" is exactly what a missing
 * policy or a missing column looks like (see migrations/016).
 */
export function decideActivationGate(
  row: ActivationGateRow | null | undefined,
  options: ActivationGateOptions = {},
): ActivationGateVerdict {
  const nullPolicy = options.nullPolicy === 'pay' ? 'pay' : 'allow';

  if (!row) {
    return { decision: 'pay', reason: 'church-row-unreadable' };
  }

  const status = normalizeStatus(row.activation_status);

  if (!status) {
    if (row.activation_paid_at) {
      return { decision: 'allow', reason: 'legacy-row-carries-paid-timestamp' };
    }
    return nullPolicy === 'pay'
      ? { decision: 'pay', reason: 'status-missing' }
      : { decision: 'allow', reason: 'status-missing-grandfathered' };
  }

  if (SETTLED_STATUSES.has(status)) {
    return { decision: 'allow', reason: `status-${status}` };
  }
  if (status === SUSPENDED_STATUS) {
    return { decision: 'suspended', reason: 'status-suspended' };
  }
  // pending_payment, awaiting_payment, unpaid, or any other explicit value:
  // an explicit non-settled status always gates.
  return { decision: 'pay', reason: `status-${status}` };
}

/** Reads the legacy-NULL policy once per call so it can differ per deploy. */
export function resolveActivationGate(
  row: ActivationGateRow | null | undefined,
): ActivationGateVerdict {
  const raw = process.env.ACTIVATION_GATE_LEGACY_NULL;
  const nullPolicy = typeof raw === 'string' && raw.trim().toLowerCase() === 'pay' ? 'pay' : 'allow';
  return decideActivationGate(row, { nullPolicy });
}

export function activationPathFor(churchSlug: string): string {
  return `/${churchSlug}/admin/activation`;
}

export function churchAdminPathFor(churchSlug: string): string {
  return `/${churchSlug}/admin`;
}
