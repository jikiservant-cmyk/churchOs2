import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { startActivationPayment } from '@/lib/activation';
import { normalizeUgPhone } from '@/lib/utils';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { readBoundedJson } from '@/lib/http/read-json';
import { isSameOriginRequestForHeaders } from '@/lib/auth-security';

export async function POST(req: NextRequest) {
  try {
    if (!isSameOriginRequestForHeaders(req.headers.get('origin'), req.headers, req.url)) {
      return NextResponse.json({ error: 'Cross-origin request denied.' }, { status: 403 });
    }
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = await readBoundedJson<unknown>(req, 8 * 1024);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    if (!parsed.value || Array.isArray(parsed.value) || typeof parsed.value !== 'object') {
      return NextResponse.json({ error: 'JSON body must be an object.' }, { status: 400 });
    }
    const body = parsed.value as Record<string, unknown>;
    const phoneNumber = typeof body.phoneNumber === 'string'
      ? body.phoneNumber.trim()
      : typeof body.phone === 'string' ? body.phone.trim() : '';
    const plan = typeof body.plan === 'string' ? body.plan.trim() || undefined : undefined;
    const churchIdParam = typeof body.churchId === 'string' ? body.churchId.trim() : '';
    if (phoneNumber.length > 32 || (plan && !['standard', 'bundle'].includes(plan))) {
      return NextResponse.json({ error: 'Invalid phone number or activation plan.' }, { status: 400 });
    }

    // The request body is not proof of church ownership. Only the authenticated
    // user's existing admin profile may select the activation ledger tenant.
    const adminSupabase = await createAdminClient();
    const { data: profile, error: profileError } = await adminSupabase
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError) {
      return NextResponse.json({ error: 'Unable to verify church administrator access' }, { status: 500 });
    }
    if (!profile?.tenant_id || !['pastor', 'admin'].includes(profile.role)) {
      return NextResponse.json({ error: 'A linked pastor or administrator account is required' }, { status: 403 });
    }
    if (churchIdParam && churchIdParam !== profile.tenant_id) {
      return NextResponse.json({ error: 'Access denied for this church workspace' }, { status: 403 });
    }
    const targetTenantId = profile.tenant_id;
    const normalizedPhone = normalizeUgPhone(phoneNumber);
    if (!normalizedPhone) {
      return NextResponse.json({ error: 'A valid Ugandan phone number is required.' }, { status: 400 });
    }

    const accountLimit = await checkRateLimit({ namespace: 'activation-account', subject: user.id, limit: 5, windowSeconds: 60 * 60 });
    const tenantLimit = await checkRateLimit({ namespace: 'activation-tenant', subject: targetTenantId, limit: 10, windowSeconds: 24 * 60 * 60 });
    const phoneLimit = await checkRateLimit({ namespace: 'activation-phone', subject: `${targetTenantId}:${normalizedPhone}`, limit: 3, windowSeconds: 60 * 60 });
    const deniedLimit = !accountLimit.allowed ? accountLimit : !tenantLimit.allowed ? tenantLimit : phoneLimit;
    if (!accountLimit.allowed || !tenantLimit.allowed || !phoneLimit.allowed) {
      const unavailable = Boolean(deniedLimit.unavailable);
      return NextResponse.json(
        { error: unavailable ? 'Payment protection is temporarily unavailable.' : 'Too many activation payment attempts. Please try again later.' },
        { status: unavailable ? 503 : 429, headers: unavailable ? undefined : { 'Retry-After': String(deniedLimit.retryAfterSeconds) } },
      );
    }

    const result = await startActivationPayment({
      churchId: targetTenantId,
      userId: user.id,
      phoneNumber,
      plan
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Failed to start payment' }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    console.error('[API Start Activation] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal Server Error' }, { status: 500 });
  }
}
