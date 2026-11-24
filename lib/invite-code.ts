import { createHash } from 'node:crypto';

/**
 * A denomination invite code as it appears inside a share link.
 * Codes are minted as 8-8-8-8 hex groups, but the pattern only promises a
 * URL-safe string: anything else is rejected before it reaches the database.
 */
export const CHURCH_JOIN_CODE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Mirror of `private.hash_invite_code` (migrations/027_denomination_layer.sql):
 * strip every non-alphanumeric character, uppercase, SHA-256 as lowercase hex.
 *
 * The database stores only this hash, so a link's code is looked up by hashing
 * it the same way Postgres does. Kept in a plain module (no 'use server') so
 * both server actions and server components can import it.
 */
export function hashChurchInviteCode(code: string): string {
  const normalized = (code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
