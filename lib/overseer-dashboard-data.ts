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

  const invites = input.invites.data as OverseerInvite[];
  if (invites.some((invite) => !invite || typeof invite !== 'object' || Array.isArray(invite))) {
    return { error: 'The invite response was invalid. Please refresh and try again.' };
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
