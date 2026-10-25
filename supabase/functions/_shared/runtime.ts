export const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-dispatch-secret',
  'access-control-allow-methods': 'POST, OPTIONS',
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  });
}

export function hasValidDispatchSecret(request: Request): boolean {
  const expected = Deno.env.get('CHURCH_DISPATCH_SECRET') ?? '';
  const provided = request.headers.get('x-dispatch-secret') ?? '';
  if (expected.length < 32 || expected.length !== provided.length) return false;

  // Constant-time comparison for equal-length UTF-8 secrets.
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(provided);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

export function requireSupabaseSecrets() {
  const url = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured for the Edge Function.');
  return { url, secretKey: serviceRoleKey };
}

export function exponentialBackoffMs(attempt: number): number {
  return Math.min(15 * 60_000, 30_000 * (2 ** Math.max(0, Math.min(attempt - 1, 8))));
}
