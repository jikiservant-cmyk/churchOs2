// Dynamic loader for Supabase server client so file can be imported in Node test runner without Next.js bundler
async function getSupabaseServerClient() {
  const { createClient } = await import('./supabase/server');
  return createClient();
}

export interface PublicDenomination {
  slug: string;
  name: string;
  logo_url: string | null;
  primary_color: string | null;
}

export interface DenominationBranding {
  id?: string;
  name: string;
  slug: string;
  logo_url: string | null;
  primary_color: string | null;
  tagline?: string | null;
  website_url?: string | null;
  description?: string | null;
}

export interface LoginContext {
  account_type: 'overseer' | 'pastor' | 'admin' | 'none';
  church_id?: string | null;
  church_name?: string | null;
  church_slug?: string | null;
  denomination_id?: string | null;
  denomination_name?: string | null;
  denomination_slug?: string | null;
  role?: string | null;
}

/**
 * Normalizes an invite code for database comparison.
 */
export function normalizeInviteCode(code?: string | null): string {
  if (!code) return '';
  return code.trim().toUpperCase();
}

const PUBLIC_IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,45}$/;

/**
 * Validates the provision_church_v3 parameter requirements:
 * p_user_id, p_name, p_slug, p_role are required; p_invite_code and p_ip are
 * optional. `p_ip` is the client IP recorded on the church row so the
 * one-church-per-IP scam guard has data to match against — it is only stored,
 * never trusted for authorization.
 */
export function validateProvisionV3Payload(payload: Record<string, any>): { valid: boolean; error?: string } {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Payload must be an object' };
  }

  if (payload.p_ip !== undefined && payload.p_ip !== null && payload.p_ip !== '') {
    if (typeof payload.p_ip !== 'string' || !(PUBLIC_IP_RE.test(payload.p_ip) || IPV6_RE.test(payload.p_ip))) {
      return { valid: false, error: 'p_ip must be a valid IPv4 or IPv6 address' };
    }
  }

  if (!payload.p_user_id) {
    return { valid: false, error: 'p_user_id is required' };
  }

  if (!payload.p_name || typeof payload.p_name !== 'string' || payload.p_name.trim().length < 3) {
    return { valid: false, error: 'p_name must be at least 3 characters' };
  }

  if (!payload.p_slug || typeof payload.p_slug !== 'string' || payload.p_slug.trim().length < 3) {
    return { valid: false, error: 'p_slug must be at least 3 characters' };
  }

  if (payload.p_role !== 'pastor') {
    return { valid: false, error: 'p_role must be pastor' };
  }

  return { valid: true };
}

/**
 * Safely parses the output from my_login_context RPC into a LoginContext object.
 */
export function parseLoginContext(data: any): LoginContext | null {
  if (!data) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;

  return {
    account_type: row.account_type || 'none',
    church_id: row.church_id || null,
    church_name: row.church_name || null,
    church_slug: row.church_slug || null,
    denomination_id: row.denomination_id || null,
    denomination_name: row.denomination_name || null,
    denomination_slug: row.denomination_slug || null,
    role: row.role || null,
  };
}

/**
 * Loads safe public fields from denominations_public view.
 * An unlisted denomination is hidden from the picker.
 */
export async function getPublicDenominations(customClient?: any): Promise<PublicDenomination[]> {
  try {
    const supabase = customClient || (await getSupabaseServerClient());
    const { data, error } = await supabase
      .from('denominations_public')
      .select('slug, name, logo_url, primary_color')
      .order('name', { ascending: true });

    if (error) {
      console.warn('[getPublicDenominations] Query notice:', error.message);
      return [];
    }

    return (data as PublicDenomination[]) || [];
  } catch (err) {
    console.warn('[getPublicDenominations] Exception:', err);
    return [];
  }
}

/**
 * Fetches branding for a denomination by slug via public.get_denomination_branding.
 * Unlisted denominations still return branding when looked up by slug.
 */
export async function getDenominationBranding(slug: string, customClient?: any): Promise<DenominationBranding | null> {
  if (!slug) return null;

  try {
    const supabase = customClient || (await getSupabaseServerClient());
    const { data, error } = await supabase.rpc('get_denomination_branding', {
      p_slug: slug.trim().toLowerCase(),
    });

    if (error) {
      console.warn(`[getDenominationBranding] Notice for ${slug}:`, error.message);
      return null;
    }

    const branding = data?.[0] ?? null;
    if (!branding) return null;

    return {
      id: branding.id,
      name: branding.name || slug,
      slug: branding.slug || slug,
      logo_url: branding.logo_url || null,
      primary_color: branding.primary_color || '#B5622A',
      tagline: branding.tagline || null,
      website_url: branding.website_url || null,
      description: branding.description || null,
    };
  } catch (err) {
    console.warn(`[getDenominationBranding] Exception for ${slug}:`, err);
    return null;
  }
}

/**
 * Calls public.my_login_context to determine the user's role and routing target.
 */
export async function getMyLoginContext(customClient?: any): Promise<LoginContext | null> {
  try {
    const supabase = customClient || (await getSupabaseServerClient());
    const { data, error } = await supabase.rpc('my_login_context');

    if (error) {
      console.warn('[getMyLoginContext] Notice:', error.message);
      return null;
    }

    return parseLoginContext(data);
  } catch (err) {
    console.warn('[getMyLoginContext] Exception:', err);
    return null;
  }
}
