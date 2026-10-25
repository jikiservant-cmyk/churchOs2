import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, hasValidDispatchSecret, jsonResponse, requireSupabaseSecrets } from '../_shared/runtime.ts';

function constantTimeSecret() {
  const { url, secretKey } = requireSupabaseSecrets();
  return { url, secretKey };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!hasValidDispatchSecret(request)) return jsonResponse({ error: 'Unauthorized' }, 401);

  let config: ReturnType<typeof constantTimeSecret>;
  try {
    config = constantTimeSecret();
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Supabase is not configured.' }, 503);
  }

  const db = createClient(config.url, config.secretKey, {
    db: { schema: 'church' },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await db.rpc('list_sms_queue_candidates', { p_limit: 50 });
  if (error) {
    console.error('[church-najiki-queue-worker] candidate scan failed:', error.message);
    return jsonResponse({ error: 'Could not scan the SMS queue.' }, 500);
  }

  const smsIds = [...new Set((data ?? []).map((row: { id?: unknown }) => row.id).filter((id): id is string => typeof id === 'string'))];
  if (!smsIds.length) return jsonResponse({ ok: true, candidates: 0, dispatched: 0, deferred: 0, failed: 0 });

  const endpoint = `${config.url}/functions/v1/church-najiki-dispatch`;
  const publishableOrSecretKey = config.secretKey;
  const outcomes: Array<'sent' | 'deferred' | 'failed'> = [];
  let cursor = 0;
  const concurrency = Math.min(15, smsIds.length);

  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < smsIds.length) {
      const smsId = smsIds[cursor++];
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            // The dispatcher has verify_jwt enabled; apikey alone does not
            // satisfy Supabase's Authorization JWT check.
            authorization: `Bearer ${config.secretKey}`,
            apikey: publishableOrSecretKey,
            'content-type': 'application/json',
            'x-dispatch-secret': Deno.env.get('CHURCH_DISPATCH_SECRET') ?? '',
          },
          // Keep the per-row function contract: exactly one queue ID is sent.
          body: JSON.stringify({ sms_id: smsId }),
          signal: AbortSignal.timeout(120_000),
        });
        const result = await response.json().catch(() => ({}));
        if (response.ok && result?.status === 'sent') outcomes.push('sent');
        else if (response.ok && result?.status === 'failed') outcomes.push('failed');
        else outcomes.push('deferred');
      } catch (dispatchError) {
        console.warn(`[church-najiki-queue-worker] dispatch invocation failed for ${smsId}:`, dispatchError instanceof Error ? dispatchError.message : dispatchError);
        outcomes.push('deferred');
      }
    }
  });
  await Promise.all(workers);

  const dispatched = outcomes.filter((result) => result === 'sent').length;
  const deferred = outcomes.filter((result) => result === 'deferred').length;
  const failed = outcomes.filter((result) => result === 'failed').length;
  return jsonResponse({ ok: true, candidates: smsIds.length, dispatched, deferred, failed });
});
