export interface OverseerChurchItem {
  church_id: string;
  name: string;
  slug: string;
  pastor_name?: string | null;
  pastor_email?: string | null;
  member_count?: number;
  recent_attendance?: number;
  total_giving?: number;
  joined_at?: string;
  status?: string;
}

export interface OverseerTotals {
  total_churches: number;
  total_members: number;
  total_giving: number;
  active_pastors: number;
  denomination_name?: string;
  denomination_slug?: string;
}

export interface OverseerInvite {
  id?: string;
  label?: string;
  code?: string;
  max_uses?: number | null;
  uses_count?: number;
  expires_at?: string | null;
  created_at?: string;
  revoked?: boolean;
}

export type OverseerDashboardSnapshot = {
  success: true;
  totals: OverseerTotals;
  churches: OverseerChurchItem[];
  invites: OverseerInvite[];
} | { error: string };

interface RpcResult {
  data: unknown;
  error: { message?: string } | null;
}

function readMetric(record: Record<string, unknown>, ...keys: string[]): number | null {
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== null && candidate !== undefined);
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Convert real RPC results without inventing zeros when a query failed or omitted a metric. */
export function buildOverseerDashboardSnapshot(input: {
  totals: RpcResult;
  churches: RpcResult;
  invites: RpcResult;
}): OverseerDashboardSnapshot {
  if (input.totals.error || input.churches.error || input.invites.error) {
    return { error: 'Overseer records are temporarily unavailable. Please refresh and try again.' };
  }

  if (!Array.isArray(input.totals.data) || input.totals.data.length !== 1 ||
      !Array.isArray(input.churches.data) || !Array.isArray(input.invites.data)) {
    return { error: 'The overseer data response was incomplete. Please refresh and try again.' };
  }

  const rawTotal = input.totals.data[0];
  if (!rawTotal || typeof rawTotal !== 'object' || Array.isArray(rawTotal)) {
    return { error: 'The overseer totals response was invalid. Please refresh and try again.' };
  }
  const total = rawTotal as Record<string, unknown>;
  const totalChurches = readMetric(total, 'church_count', 'total_churches');
  const totalMembers = readMetric(total, 'member_total', 'total_members');
  const totalGiving = readMetric(total, 'giving_total', 'total_giving');
  const activePastors = readMetric(total, 'active_churches_30d', 'active_pastors');
  if ([totalChurches, totalMembers, totalGiving, activePastors].some((value) => value === null)) {
    return { error: 'The overseer totals response was incomplete. Please refresh and try again.' };
  }

  const churches: OverseerChurchItem[] = [];
  for (const value of input.churches.data) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'The church summary response was invalid. Please refresh and try again.' };
    }
    const c = value as Record<string, unknown>;
    const churchId = c.church_id ?? c.id;
    const name = c.church_name ?? c.name;
    const slug = c.slug;
    const memberCount = readMetric(c, 'member_count');
    const attendance = readMetric(c, 'attendance_30d', 'recent_attendance');
    const giving = readMetric(c, 'total_giving');
    if (typeof churchId !== 'string' || !churchId || typeof name !== 'string' ||
        typeof slug !== 'string' || memberCount === null || attendance === null || giving === null) {
      return { error: 'The church summary response was incomplete. Please refresh and try again.' };
    }
    churches.push({
      church_id: churchId,
      name,
      slug,
      pastor_name: typeof c.pastor_name === 'string' ? c.pastor_name :
        typeof c.pastor_email === 'string' ? c.pastor_email.split('@')[0] : null,
      pastor_email: typeof c.pastor_email === 'string' ? c.pastor_email : null,
      member_count: memberCount,
      recent_attendance: attendance,
      total_giving: giving,
      joined_at: typeof c.joined_at === 'string' ? c.joined_at :
        typeof c.created_at === 'string' ? c.created_at : undefined,
      status: typeof c.status === 'string' ? c.status : undefined,
    });
  }

  const invites: OverseerInvite[] = [];
  for (const value of input.invites.data) {
    const invite = normalizeInviteRow(value);
    if (!invite) {
      return { error: 'The invite response was invalid. Please refresh and try again.' };
    }
    invites.push(invite);
  }

  return {
    success: true,
    totals: {
      total_churches: totalChurches!,
      total_members: totalMembers!,
      total_giving: totalGiving!,
      active_pastors: activePastors!,
      denomination_name: typeof total.denomination_name === 'string' ? total.denomination_name : undefined,
      denomination_slug: typeof total.denomination_slug === 'string' ? total.denomination_slug : undefined,
    },
    churches,
    invites,
  };
}

/**
 * A Postgres `uuid` as text. Deliberately looser than the signup validators, which insist
 * on a version nibble: this value comes from the database, not from a form, and the only
 * thing it has to survive is PostgREST's cast of a query parameter to `uuid`.
 */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map an invite row from whichever key names `overseer_list_invites` happens to use.
 *
 * This is not cosmetics. Revoking is the only way to retire an outstanding pastor-invite
 * code before it is redeemed, and the action underneath can only address a row by its
 * `p_invite_id uuid` — the live signature measured on 2026-11-02, which has no `p_code`
 * parameter. So if the list RPC returns `invite_id` and the row is cast straight through,
 * `invite.id` is `undefined`, the revoke button renders disabled, and an overseer who wants
 * to kill a leaked code has no way to do it from the dashboard. Normalising the alias is
 * what keeps that control reachable.
 */
export function normalizeInviteRow(value: unknown): OverseerInvite | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const text = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const candidate = row[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return undefined;
  };
  const uses = readMetric(row, 'uses_count', 'usage_count', 'redeemed_count');
  const maxUses = readMetric(row, 'max_uses', 'maxUses');
  return {
    id: text('id', 'invite_id', 'inviteId'),
    label: text('label', 'note', 'description'),
    code: text('code', 'raw_code', 'invite_code'),
    max_uses: maxUses === null ? (row.max_uses === null ? null : undefined) : maxUses,
    uses_count: uses === null ? undefined : uses,
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : undefined,
    // A row that carries `revoked_at` at all is authoritative even when it is null — that is
    // "not revoked", which is a different statement from "the RPC did not tell us".
    revoked: typeof row.revoked === 'boolean'
      ? row.revoked
      : ('revoked_at' in row)
        ? (row.revoked_at !== null && row.revoked_at !== undefined)
        : undefined,
  };
}

/**
 * Decide what the revoke action may send to the database.
 *
 * The old code sent the identifier as `p_invite_id`, and if that errored, sent the same
 * string as `p_code` — a parameter the function does not have. The retry could therefore
 * never succeed; all it did was turn "this row has no id" into a raw PostgREST error shown
 * to the user, and, worse, it kept alive the fiction that the database accepts a code.
 * Saying no before the call is both honest and cheaper.
 */
export function pickRevokeTarget(inviteIdentifier: string):
  { ok: true; inviteId: string } | { ok: false; error: string } {
  const value = (inviteIdentifier || '').trim();
  if (!value) {
    return { ok: false, error: 'No invite selected.' };
  }
  if (UUID_TEXT.test(value)) {
    return { ok: true, inviteId: value.toLowerCase() };
  }
  return {
    ok: false,
    error: 'This invite cannot be revoked from the dashboard: its row was returned without an '
      + 'invite id, and the revoke function accepts an id only. Revoking by code is not '
      + 'supported by the database, so the code stays live until it expires or reaches its '
      + 'allowed number of uses.',
  };
}
