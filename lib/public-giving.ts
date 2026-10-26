/**
 * Public donations are intentionally disabled until ChurchOS has an atomic,
 * idempotent donation-settlement path. Do not enable this switch until the
 * webhook writes confirmed gifts to church.donations and the full contract is
 * covered by integration tests.
 */
export const PUBLIC_GIVING_ENABLED = false;
export const PUBLIC_GIVING_DISABLED_MESSAGE = 'Online giving is not available yet.';

export function getPublicGivingGateError(): { error: string } | null {
  return PUBLIC_GIVING_ENABLED ? null : { error: PUBLIC_GIVING_DISABLED_MESSAGE };
}
