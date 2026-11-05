/**
 * Usher portal passkeys — the code a church hands to its ushers.
 *
 * Extracted from `lib/attendance-actions.ts` (which is a `'use server'` module)
 * so that trusted server code — the attendance screen and church provisioning —
 * can share the exact same crypto without any of it becoming a browser-callable
 * action. Everything here is pure or takes its client explicitly.
 *
 * Why the extraction was needed at all: a brand-new church gets its `passkey`
 * from a column DEFAULT that `supabase-schema.sql` declares but that the live
 * database only receives from migration 014 (which installs it "if the column
 * has none"). `provision_church_v3` is a database function this repository does
 * not own, and it does not supply a code. So on any project where 014 has not
 * been applied, a newly provisioned church is created with no usher code at all:
 * the admin screen renders an empty field, `CopyPortalLink` copies nothing, and
 * the usher portal answers "No usher passkey is configured". The portal is not
 * broken — the credential simply was never issued, and nothing generated it.
 *
 * `ensureChurchUsherPasskey` closes that gap where the code is first needed, and
 * it never overwrites a code that already exists — a rotation is a deliberate act
 * by a pastor, and silently re-issuing a church's credential would lock every
 * usher out mid-service.
 */
import crypto from 'crypto';

/** Ambiguous glyphs (I/O/0/1) are excluded: this code is read aloud over the phone. */
export const USHER_PASSKEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const USHER_PASSKEY_LENGTH = 8;

/** The shape `validateUsherPasskey` accepts on login. */
const PORTAL_ACCEPTED = /^[A-Za-z0-9_-]{6,32}$/;

/**
 * PostgREST answers 42703 when a SELECT names a column the table does not
 * have, and PGRST204 when an INSERT/UPDATE carries one. Both mean the same
 * thing here: migration 011 has not been applied to this database yet, so
 * `passkey_hash` / `passkey_version` / `passkey_updated_at` are missing while
 * the base `passkey` column — present in every deployment — still works.
 * The usher flow degrades to that column instead of locking the door.
 */
export function isUndefinedColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === '42703' || code === 'PGRST204';
}

/**
 * Compare a typed passkey against the readable `passkey` column, in constant
 * time. Case-insensitive on purpose: the portal input upper-cases everything
 * an usher types, so a code stored with lowercase letters (older custom codes)
 * was impossible to enter correctly — the door rejected its own credential.
 * Codes this app generates are upper-case only, so nothing is weakened there;
 * a mixed-case attacker guess space at most doubles, under per-IP and
 * per-church rate limits that already bound every attempt.
 */
export function readableUsherPasskeyMatches(stored: unknown, provided: string): boolean {
  const code = readUsableUsherPasskey(stored);
  if (!code) return false;
  const trimmed = typeof provided === 'string' ? provided.trim() : '';
  if (!trimmed) return false;
  const expected = Buffer.from(code.toUpperCase(), 'utf8');
  const actual = Buffer.from(trimmed.toUpperCase(), 'utf8');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * Whether the usher session cookie may carry the `Secure` flag for this request.
 *
 * The flag was hardcoded `true`, which is right on every HTTPS host (Vercel
 * included — it always sends `x-forwarded-proto: https`) but silently breaks
 * a portal reached over plain HTTP: the browser drops the cookie, the login
 * toast says "Access granted", and the dashboard bounces straight back to the
 * passkey screen — the portal "doesn't open even with the correct passkey".
 * A church running check-in on a local-network tablet hits exactly this.
 *
 * Fail secure: only an explicit `http` from the proxy relaxes the flag; a
 * missing or ambiguous header stays `Secure`.
 */
export function usherCookieIsSecure(xForwardedProto: string | null | undefined): boolean {
  const first = (xForwardedProto ?? '').split(',')[0]?.trim().toLowerCase();
  return first !== 'http';
}

/**
 * Re-bind a session whose database has no `passkey_version` column yet.
 * The token carries `passkey_check` — the HMAC of the code that authenticated
 * it, upper-cased exactly like `readableUsherPasskeyMatches` compares — and the
 * re-bind recomputes that HMAC from the CURRENT readable code, so rotating the
 * code still revokes every outstanding session immediately, even before
 * migration 011 installs the version counter. Both sides normalise case the
 * same way, so a session never dies because the stored code differs from the
 * typed one by letter case alone. A token without the claim (or a church whose
 * code has since changed) fails closed.
 */
export function usherSessionFingerprintValid(claimFingerprint: unknown, storedPasskey: unknown): boolean {
  if (typeof claimFingerprint !== 'string' || claimFingerprint.length === 0) return false;
  const code = readUsableUsherPasskey(storedPasskey);
  if (!code) return false;
  const expected = Buffer.from(hashUsherPasskey(code.toUpperCase()), 'hex');
  const actual = Buffer.from(claimFingerprint, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function usherSecretProblem(): string | null {
  const jwtSecretValue = process.env.USHER_JWT_SECRET;
  if (!jwtSecretValue) {
    return 'USHER_JWT_SECRET is not set. Usher sessions are disabled until it is.';
  }
  if (jwtSecretValue === 'REPLACE_ME_WITH_A_STRONG_RANDOM_SECRET') {
    return 'USHER_JWT_SECRET is still the placeholder value. Set a real 32+ byte secret.';
  }
  if (Buffer.byteLength(jwtSecretValue) < 32) {
    return `USHER_JWT_SECRET is ${Buffer.byteLength(jwtSecretValue)} bytes; at least 32 are required.`;
  }
  return null;
}

export function getUsherJwtSecret(): Uint8Array {
  const problem = usherSecretProblem();
  if (problem) {
    // F-04: no silent fallback to the service-role key. A dedicated secret is
    // what makes rotation and revocation auditable.
    throw new Error(problem);
  }
  // Domain-separate the usher secret to prevent raw key reuse.
  return crypto
    .createHmac('sha256', 'usher_jwt_domain_separation')
    .update(process.env.USHER_JWT_SECRET!)
    .digest();
}

export function hashUsherPasskey(passkey: string): string {
  return crypto
    .createHmac('sha256', getUsherJwtSecret())
    .update(passkey.trim())
    .digest('hex');
}

/** CSPRNG, unambiguous alphabet, exactly the length the portal validator accepts. */
export function generateUsherPasskeyCode(): string {
  const bytes = crypto.randomBytes(USHER_PASSKEY_LENGTH);
  let result = '';
  for (let i = 0; i < USHER_PASSKEY_LENGTH; i += 1) {
    result += USHER_PASSKEY_ALPHABET[bytes[i] % USHER_PASSKEY_ALPHABET.length];
  }
  return result;
}

/** A code the church can actually be told. NULL and '' are both "no code". */
export function readUsableUsherPasskey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function isPortalAcceptedPasskey(value: unknown): boolean {
  const code = readUsableUsherPasskey(value);
  return code !== null && PORTAL_ACCEPTED.test(code);
}

export type EnsurePasskeyResult =
  /** A readable code already exists. Nothing was written. */
  | { status: 'present'; passkey: string }
  /**
   * A code was issued by this call. `hashed` is false when the secret is unusable
   * *or* when the database predates migration 011 (no `passkey_hash` column yet —
   * `degraded` says which). In both cases login still accepts the readable code.
   */
  | { status: 'generated'; passkey: string; hashed: boolean; secretProblem: string | null; degraded?: boolean }
  /** Nothing could be done. The caller decides what to show; no credential was changed. */
  | { status: 'unavailable'; reason: string };

/**
 * Give `churchId` an usher code if it has none. Takes the client so the caller
 * decides which privileges are used, and so this can never be reached from a
 * browser: it is not exported from a `'use server'` module.
 *
 * Idempotent and concurrency-safe: the write is filtered on the value that was
 * just read, so two simultaneous callers cannot each replace the other's code.
 */
/**
 * Only `schema().from()` is required. The query builder is a deeply generic
 * self-referential type (see lib/supabase/church-access.ts); describing it here
 * would be fragile for its own sake and expensive enough to trip TS2589.
 */
type ChurchTableReader = {
  schema: (name: string) => { from: (table: string) => any };
};

export async function ensureChurchUsherPasskey(
  adminClient: ChurchTableReader,
  churchId: string,
): Promise<EnsurePasskeyResult> {
  if (typeof churchId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(churchId)) {
    return { status: 'unavailable', reason: 'invalid-church-id' };
  }

  const table = () => adminClient.schema('church').from('churches') as any;

  // Read with the full column set first. On a database where migration 011 has
  // not run, that SELECT itself fails with 42703 — retry against the base
  // `passkey` column alone rather than refusing to issue a code at all. A
  // church whose admins cannot run SQL still gets a working portal.
  const readFull = await table()
    .select('passkey, passkey_hash, passkey_version')
    .eq('id', churchId)
    .maybeSingle();

  let church: Record<string, unknown> | null = readFull.data ?? null;
  let passkeyColumnsMissing = false;

  if (readFull.error) {
    if (!isUndefinedColumnError(readFull.error)) {
      return { status: 'unavailable', reason: `lookup-failed: ${readFull.error.message ?? 'unknown'}` };
    }
    passkeyColumnsMissing = true;
    console.warn(
      '[ensureChurchUsherPasskey] passkey_hash/passkey_version are missing — run migrations/011_usher_passkey_columns.sql.',
      'Issuing the readable code only until then.',
    );
    const readMinimal = await table()
      .select('passkey')
      .eq('id', churchId)
      .maybeSingle();
    if (readMinimal.error) {
      return { status: 'unavailable', reason: `lookup-failed: ${readMinimal.error.message ?? 'unknown'}` };
    }
    church = (readMinimal.data as Record<string, unknown> | null) ?? null;
  }

  if (!church) {
    return { status: 'unavailable', reason: 'church-not-found' };
  }

  const existing = readUsableUsherPasskey(church.passkey);
  if (existing) {
    return { status: 'present', passkey: existing };
  }

  const code = generateUsherPasskeyCode();
  const secretProblem = usherSecretProblem();

  // The hash is what login compares against; the readable column is what the
  // admin screen shows and what an usher is told. Both are written together so
  // a church created from now on never has one without the other. When the
  // secret is missing, the readable code is still issued — login accepts it and
  // self-heals the hash on first use (see validateUsherPasskey). On a database
  // without the 011 columns, only the readable code can be written at all; the
  // hash self-heals after 011 lands.
  const patch: Record<string, unknown> = { passkey: code };
  if (!passkeyColumnsMissing) {
    patch.passkey_updated_at = new Date().toISOString();
    if (!secretProblem) {
      patch.passkey_hash = hashUsherPasskey(code);
    }
  }

  // Re-state the value we read, so a concurrent writer wins once and this write
  // becomes a no-op instead of clobbering it.
  let guarded = church.passkey === null
    ? table().update(patch).eq('id', churchId).is('passkey', null)
    : table().update(patch).eq('id', churchId).eq('passkey', church.passkey);

  let writeResult = await guarded.select('passkey');
  let writeError: { message?: string } | null = writeResult.error ?? null;

  // A half-migrated database (read succeeded, write carries a column the table
  // does not have — e.g. another admin dropped one mid-flight) falls back to
  // the readable code alone, under the same guard.
  if (writeError && isUndefinedColumnError(writeError)) {
    passkeyColumnsMissing = true;
    console.warn(
      '[ensureChurchUsherPasskey] the write named a column this table does not have —',
      'writing the readable code only. Run migrations/011_usher_passkey_columns.sql.',
    );
    const retry = church.passkey === null
      ? table().update({ passkey: code }).eq('id', churchId).is('passkey', null)
      : table().update({ passkey: code }).eq('id', churchId).eq('passkey', church.passkey);
    writeResult = await retry.select('passkey');
    writeError = writeResult.error ?? null;
  }

  if (writeError) {
    return { status: 'unavailable', reason: `write-failed: ${writeError.message ?? 'unknown'}` };
  }

  const written = writeResult.data;

  const rows = Array.isArray(written) ? written : written ? [written] : [];
  if (rows.length === 0) {
    const { data: reread } = await table().select('passkey').eq('id', churchId).maybeSingle();
    const concurrent = readUsableUsherPasskey((reread as Record<string, unknown> | null)?.passkey);
    return concurrent
      ? { status: 'present', passkey: concurrent }
      : { status: 'unavailable', reason: 'write-lost-race' };
  }

  return {
    status: 'generated',
    passkey: code,
    hashed: !secretProblem && !passkeyColumnsMissing,
    secretProblem,
    ...(passkeyColumnsMissing ? { degraded: true } : {}),
  };
}
