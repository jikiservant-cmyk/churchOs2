/**
 * Drift-tolerant wallet read.
 *
 * `public.wallets` is created by `CREATE TABLE IF NOT EXISTS` in
 * `supabase-schema.sql`, and no `ALTER … ADD COLUMN` ever follows for
 * `sms_rate` / `app_type`. A database whose `wallets` table predates those
 * columns therefore answers
 *
 *   select('balance, sms_rate, tenant_id')
 *
 * with `42704/42703: column … does not exist`. Every caller used to treat that
 * as "no balance", so a church with money in the wallet saw `0 SMS` while the
 * rows were plainly there in the dashboard. Same failure shape as
 * `getChurchBySlug`'s 42703 fallback in `lib/db.ts` — the projection is
 * degraded instead of the feature.
 */

/** Postgres: column does not exist (42703) / field selection does not exist (42704). */
const MISSING_COLUMN_CODES = new Set(['42703', '42704']);

export const DEFAULT_SMS_RATE = 70;

export type WalletRecord = {
  balance?: number | string | null;
  sms_rate?: number | null;
  tenant_id?: string | null;
};

export type WalletReadError = { code?: string; message?: string } | null;

export type WalletReadResult = {
  /** The wallet row, or `null` when there is no readable row for the tenant. */
  wallet: WalletRecord | null;
  /** Set only when both projections failed — the tenant may still have a wallet. */
  error: WalletReadError;
  /** Columns the deployed table lacks; the caller decides how to label the gap. */
  missingColumns: string[];
  /** True when the balance came from the reduced projection. */
  degraded: boolean;
};

/** Supabase's query builder is thenable rather than a real Promise. */
export type WalletQueryRunner = (
  columns: string,
) => PromiseLike<{ data: WalletRecord | null; error: WalletReadError }>;

/**
 * @param run issues `wallets.select(columns).eq('tenant_id', …).maybeSingle()`
 *   and awaits it. Kept as a callback so the caller decides which client —
 *   service-role or RLS-scoped — is being used.
 */
export async function readWalletWithColumnFallback(
  run: WalletQueryRunner,
): Promise<WalletReadResult> {
  const full = await run('balance, sms_rate, tenant_id');
  if (!full.error) {
    return { wallet: full.data ?? null, error: null, missingColumns: [], degraded: false };
  }
  if (!MISSING_COLUMN_CODES.has(full.error.code ?? '')) {
    return { wallet: null, error: full.error, missingColumns: [], degraded: false };
  }

  const reduced = await run('balance, tenant_id');
  if (reduced.error) {
    // `balance` itself is missing, or the table is unreadable — never report 0.
    return { wallet: null, error: reduced.error, missingColumns: ['sms_rate'], degraded: false };
  }
  return {
    wallet: reduced.data ? { ...reduced.data, sms_rate: null } : null,
    error: null,
    missingColumns: ['sms_rate'],
    degraded: true,
  };
}

/** `balance` is a bigint, so PostgREST may hand back a string; a null rate is the default rate. */
export function walletDerivedBalanceUgx(wallet: WalletRecord | null | undefined): number {
  const raw = wallet?.balance;
  const parsed = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(parsed) ? Number(parsed) : 0;
}

export function walletSmsRate(wallet: WalletRecord | null | undefined): number {
  const rate = Number(wallet?.sms_rate);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_SMS_RATE;
}
