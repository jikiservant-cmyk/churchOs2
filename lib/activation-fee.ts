/**
 * Activation fee resolution — one rule, shared by the ledger, the Na'jiki
 * request, the settlement check and the screen that quotes the price.
 *
 * The fee used to be hardcoded twice: `lib/activation` (what is actually
 * charged and recorded) and `components/activation/ActivationClient.tsx`
 * (what the pastor is told). Those could drift apart silently, and a client
 * bundle cannot read server env vars anyway — so an env-driven fee MUST be
 * passed down from the server component, never re-read in the browser.
 *
 * `ACTIVATION_FEE_UGX` exists for test pricing: set it to `1000` in Vercel to
 * charge UGX 1,000, delete it to return to the standard UGX 17,000. No code
 * change and no forgotten revert. It is deliberately NOT a `NEXT_PUBLIC_`
 * variable: the amount is decided by the server, and `startActivationPayment`
 * ignores any amount the browser sends.
 *
 * An unset, malformed, fractional or out-of-range value never becomes the fee.
 * Falling back to the standard price is always the safe answer — a 0 or NaN fee
 * would create a ledger row that the settlement RPC can never accept
 * (`p_paid_amount > 0`, whole UGX only, and it must equal the recorded amount),
 * leaving a pastor who has paid permanently unable to activate.
 */

/** What a church is charged when no override is configured. */
export const ACTIVATION_STANDARD_FEE_UGX = 17_000;

/**
 * Inclusive bounds for an override.
 * min: `activation_payments_amount_positive_chk` requires amount > 0, and a
 * prompt for a few coins is not a real test of the flow either.
 * max: `church.activation_payments.amount` is numeric(14,2); the cap keeps the
 * value far inside that and inside `Number.isSafeInteger`.
 */
export const ACTIVATION_FEE_MIN_UGX = 100;
export const ACTIVATION_FEE_MAX_UGX = 10_000_000;

export interface ActivationFeeResolution {
  /** Whole UGX. Always a safe integer within [MIN, MAX]. */
  amount: number;
  /** True when an override is in effect, i.e. this is not the standard price. */
  override: boolean;
  /** Machine-readable note when the override was rejected. null when accepted. */
  rejected: string | null;
}

export function resolveActivationFeeUgx(
  raw: unknown,
  standard: number = ACTIVATION_STANDARD_FEE_UGX,
): ActivationFeeResolution {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';

  if (!text) {
    return { amount: standard, override: false, rejected: null };
  }

  // Whole UGX only: no sign, no separators, no exponent, no decimals.
  if (!/^\d+$/.test(text)) {
    return { amount: standard, override: false, rejected: 'not-whole-ugx' };
  }

  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    return { amount: standard, override: false, rejected: 'not-safe-integer' };
  }
  if (parsed < ACTIVATION_FEE_MIN_UGX || parsed > ACTIVATION_FEE_MAX_UGX) {
    return { amount: standard, override: false, rejected: 'outside-allowed-range' };
  }

  return {
    amount: parsed,
    override: parsed !== standard,
    rejected: null,
  };
}
