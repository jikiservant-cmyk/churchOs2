/** Shared server/client bounds for purchasing SMS wallet credits. */
export const SMS_TOPUP_MIN_UGX = 1_000;
export const SMS_TOPUP_MAX_UGX = 2_000_000;

/** Parse a monetary amount expressed in whole UGX without accepting prefixes or fractions. */
export function parseWholeUgxAmount(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 0 || maximum < minimum) {
    throw new RangeError('Invalid UGX amount bounds');
  }

  let amount: number;
  if (typeof value === 'number') {
    amount = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    amount = Number(value.trim());
  } else {
    return null;
  }

  if (!Number.isSafeInteger(amount) || amount < minimum || amount > maximum) return null;
  return amount;
}
