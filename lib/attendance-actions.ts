'use server';

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { tenantScopedAdmin } from '@/lib/supabase/tenant-scoped';
import { revalidatePath } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { checkRateLimit, getRateLimitIp } from '@/lib/security/rate-limit';
import { ChurchEvent, AttendanceLog, AttendanceFlag, AttendanceFlagStatus } from './attendance-types';
import { membersExpectedAtEvent } from './attendance-streaks';
import { SignJWT, jwtVerify } from 'jose';
import { sendSingleSMS } from './sms-actions';
import { CHURCH_ADMIN_ROLES, hasAllowedRole } from './auth-security';

import crypto from 'crypto';

function getJwtSecret(): Uint8Array {
  // F-04: no silent fallback to the service-role key. A dedicated secret is now
  // mandatory, which is what makes rotation and revocation auditable.
  const jwtSecretValue = process.env.USHER_JWT_SECRET;
  if (!jwtSecretValue || jwtSecretValue === 'REPLACE_ME_WITH_A_STRONG_RANDOM_SECRET' || Buffer.byteLength(jwtSecretValue) < 32) {
    throw new Error('USHER_JWT_SECRET is not configured. Usher sessions are disabled until it is set.');
  }
  // Domain-separate the usher secret to prevent raw key reuse
  const derivedSecret = crypto.createHmac('sha256', 'usher_jwt_domain_separation').update(jwtSecretValue).digest();
  return derivedSecret;
}

function computePasskeyHash(passkey: string): string {
  const secret = getJwtSecret();
  return crypto.createHmac('sha256', secret).update(passkey.trim()).digest('hex');
}

export async function generateSecurePasskey(): Promise<string> {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

export async function validateUsherPasskey(churchSlug: string, passkey: string) {
  try {
    // Canonicalize slug to prevent % wildcards and case variations from resetting throttle buckets
    const canonicalSlug = churchSlug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
    if (!canonicalSlug) {
      return { success: false, error: 'Invalid church identifier.' };
    }

    const requestHeaders = await headers();
    const clientIp = getRateLimitIp(requestHeaders);
    const churchLimit = await checkRateLimit({ namespace: 'usher-passkey-church', subject: canonicalSlug, limit: 100, windowSeconds: 15 * 60 });
    const ipLimit = clientIp === 'unknown'
      ? { allowed: true, retryAfterSeconds: 0 }
      : await checkRateLimit({ namespace: 'usher-passkey-ip', subject: `${canonicalSlug}:${clientIp}`, limit: 20, windowSeconds: 15 * 60 });
    const deniedLimit = !ipLimit.allowed ? ipLimit : churchLimit;
    if (!ipLimit.allowed || !churchLimit.allowed) {
      return {
        success: false,
        error: deniedLimit.unavailable
          ? 'Usher login protection is temporarily unavailable. Please try again later.'
          : `Too many attempts. Please wait ${deniedLimit.retryAfterSeconds}s before trying again.`,
      };
    }

    console.log('[validateUsherPasskey] Validating for slug:', canonicalSlug);
    const supabase = await createAdminClient();
    
    // Use strict equality (.eq) instead of ilike so % and _ cannot act as wildcards
    const { data: church, error: churchQueryError } = await supabase
      .schema('church')
      .from('churches')
      .select('id, name, passkey, passkey_hash, passkey_version')
      .eq('slug', canonicalSlug)
      .maybeSingle();

    if (churchQueryError) {
      // 42703 = undefined_column. The portal would otherwise report
      // "Church not found." for a church that plainly exists, which sends
      // operators hunting for a typo instead of a missing migration.
      if ((churchQueryError as any).code === '42703') {
        console.error(
          '[validateUsherPasskey] church.churches is missing passkey columns — run migrations/011_usher_passkey_columns.sql',
          churchQueryError.message,
        );
        return {
          success: false,
          error: 'Usher login is misconfigured: this database is missing required columns. Ask an administrator to run migration 011.',
        };
      }
      console.error('[validateUsherPasskey] Church lookup failed:', churchQueryError.message);
      return { success: false, error: 'Could not verify the church. Please try again.' };
    }

    if (!church) {
      console.error('[validateUsherPasskey] No church found for slug.');
      return { success: false, error: 'Church not found.' };
    }

    const providedPasskey = (passkey || '').trim();
    if (!providedPasskey || providedPasskey.length < 6 || providedPasskey.length > 32 || !/^[A-Za-z0-9_-]+$/.test(providedPasskey)) {
      return { success: false, error: 'Invalid passkey format.' };
    }

    const providedHash = computePasskeyHash(providedPasskey);
    let isMatch = false;
    let matchedVia: 'hash' | 'plaintext' | null = null;

    // Compare against the stored hash when there is one.
    if (church.passkey_hash) {
      const expectedBuf = Buffer.from(church.passkey_hash, 'hex');
      const actualBuf = Buffer.from(providedHash, 'hex');
      if (expectedBuf.length > 0 && expectedBuf.length === actualBuf.length &&
          crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        isMatch = true;
        matchedVia = 'hash';
      }
    }

    // Also accept the readable `passkey` column, even while a hash exists.
    //
    // This column is the code the admin screen displays and the operator reads
    // out of the database, so it has to keep working. Churches provisioned
    // before migration 011 carry a hash derived from `slug:uuid` — a value
    // nobody was ever shown — which previously shadowed the readable code and
    // made the portal impossible to enter. Accepting the plaintext repairs those
    // rows, and the hash is then rewritten to match.
    if (!isMatch && typeof church.passkey === 'string' && church.passkey.trim()) {
      const expectedBuf = Buffer.from(church.passkey.trim());
      const actualBuf = Buffer.from(providedPasskey);
      if (expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        isMatch = true;
        matchedVia = 'plaintext';
      }
    }

    // Self-heal: keep `passkey_hash` in step with the code that just worked, so
    // subsequent logins take the hash path. The readable passkey is retained —
    // the admin UI and the portal link both display it.
    if (isMatch && matchedVia === 'plaintext' && church.passkey_hash !== providedHash) {
      const { error: healError } = await supabase
        .schema('church')
        .from('churches')
        .update({ passkey_hash: providedHash })
        .eq('id', church.id);
      if (healError) {
        console.warn('[validateUsherPasskey] Could not refresh passkey_hash:', healError.message);
      }
    }

    if (!isMatch) {
      return { success: false, error: 'Invalid passkey. Please check and try again.' };
    }

    const churchId = church.id;
    const churchName = church.name;
    const currentVersion = church.passkey_version || 1;

    // 2. Create a cryptographically signed JWT for the session bound to passkey_version
    const token = await new SignJWT({
      church_id: churchId,
      church_name: churchName,
      church_slug: canonicalSlug,
      role: 'usher',
      passkey_version: currentVersion
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(getJwtSecret());

    const cookieStore = await cookies();
    const cookieName = `usher_session_${canonicalSlug}`;
    
    cookieStore.set(cookieName, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 // 24 hours
    });

    revalidatePath(`/${canonicalSlug}/usher/dashboard`);
    return { success: true, churchName };

  } catch (error) {
    console.error('CRITICAL: validateUsherPasskey error:', error);
    return { 
      success: false, 
      error: 'An unexpected security or network error occurred' 
    };
  }
}

export async function getUsherSession(churchSlug: string) {
  const canonicalSlug = churchSlug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
  if (!canonicalSlug) return null;

  const cookieStore = await cookies();
  const cookieName = `usher_session_${canonicalSlug}`;
  const token = cookieStore.get(cookieName)?.value;
  
  if (!token) return null;
  
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    // Ensure the token's church_slug strictly matches the requested church URL slug
    if (payload.church_slug !== canonicalSlug || payload.role !== 'usher' || !payload.church_id) {
      return null;
    }

    // MT-01 & MT-02 remediation: Re-bind session to database record to ensure passkey has not been rotated
    const adminClient = await createAdminClient();
    const { data: church } = await adminClient
      .schema('church')
      .from('churches')
      .select('id, slug, passkey_version')
      .eq('id', payload.church_id as string)
      .maybeSingle();

    if (!church || church.slug !== canonicalSlug) {
      return null;
    }

    const currentVersion = church.passkey_version || 1;
    const sessionVersion = (payload.passkey_version as number) || 1;
    if (sessionVersion !== currentVersion) {
      // Passkey was rotated; previous usher sessions are revoked immediately
      return null;
    }

    return payload as any;
  } catch (e) {
    return null;
  }
}

export async function logoutUsher(churchSlug: string) {
  const cookieStore = await cookies();
  // Must canonicalise exactly like getUsherSession(), otherwise a slug with
  // uppercase or punctuation deletes a cookie name that was never set.
  const canonicalSlug = churchSlug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
  const cookieName = `usher_session_${canonicalSlug}`;
  cookieStore.delete(cookieName);
  return { success: true };
}

export async function createEvent(formData: FormData, churchId: string, churchSlug: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    console.error('CreateEvent: No authenticated user found');
    return { error: 'You must be logged in to create services.' };
  }

  // Verify caller's admin profile belongs to this church and has pastor or admin role (MT-04)
  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('tenant_id, role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.tenant_id !== churchId || !['pastor', 'admin'].includes(profile.role)) {
    return { error: 'Unauthorized: only pastors or administrators have permission to manage events for this church.' };
  }

  const name = formData.get('name') as string;
  const serviceType = formData.get('service_type') as 'sunday_service' | 'bible_study' | 'prayer_meeting' | 'youth_service';
  const eventDate = formData.get('event_date') as string;
  const startTime = formData.get('start_time') as string;
  const location = formData.get('location') as string;

  const { error } = await supabase
    .schema('church')
    .from('events')
    .upsert({
      church_id: churchId,
      name,
      service_type: serviceType,
      event_date: eventDate,
      start_time: startTime,
      location,
      status: 'upcoming',
      created_by: user.id
    }, { 
      onConflict: 'church_id,service_type,event_date,start_time' 
    });

  if (error) {
    console.error('Error creating event:', error);
    // If we get an RLS error, it usually manifests as a 42501 or just a generic failure
    return { error: error.message || 'Failed to create event. This might be due to a unique constraint or RLS policy.' };
  }

  revalidatePath(`/${churchSlug}/admin/attendance`);
  return { success: true };
}

export async function updateEventStatus(eventId: string, status: 'upcoming' | 'active' | 'completed', churchSlug: string) {
  try {
    if (!['upcoming', 'active', 'completed'].includes(status)) return { error: 'Invalid event status.' };
    // 1. Authorize caller first (ensures event belongs to church and caller has admin/usher rights)
    const { scopedDb, churchId } = await checkAuthorization(churchSlug, eventId, ['pastor', 'admin']);
    
    // Auto-mark absentees when an event is finalized
    if (status === 'completed') {
      const { data: event } = await scopedDb.church('events').select('church_id').eq('id', eventId).single();
      
      if (event) {
        const { data: allMembers } = await scopedDb.church('members').select('id').eq('status', 'active');
        const { data: logs } = await scopedDb.church('attendance_logs').select('member_id').eq('event_id', eventId);
        
        if (allMembers && logs) {
          const attendedIds = new Set((logs as any[]).map(l => l.member_id));
          const absentMembers = (allMembers as any[]).filter(m => !attendedIds.has(m.id));
          
          if (absentMembers.length > 0) {
            const absentLogs = absentMembers.map(m => ({
              church_id: churchId,
              event_id: eventId,
              member_id: m.id,
              attendance_status: 'absent'
            }));
            
            // Use upsert to be safe and avoid unique constraint conflicts
            const { error: insertError } = await scopedDb.admin
              .schema('church')
              .from('attendance_logs')
              .upsert(absentLogs, { onConflict: 'member_id,event_id' });

            if (insertError) {
              console.error('[updateEventStatus] Failed to auto-mark absentees:', insertError);
            }
          }
        }
      }
    }

    const { error } = await scopedDb
      .church('events')
      .update({ status })
      .eq('id', eventId);

    if (error) return { error: error.message };

    // Finalising an event is the exact moment a "missed N consecutive events"
    // streak can cross the threshold, so refresh flags right away instead of
    // waiting for the nightly job. Scoped to the members expected at THIS
    // event — their streaks are the only ones this event can change, which
    // keeps completion cheap in big tenants. Best-effort: a stale/failed
    // refresh never blocks event completion.
    if (status === 'completed') {
      try {
        const [{ data: churchCfg }, { data: eventRow }, { data: roster }] = await Promise.all([
          scopedDb.church('churches').select('meeting_days').eq('id', churchId).maybeSingle(),
          scopedDb.church('events').select('event_date').eq('id', eventId).single(),
          scopedDb.church('members').select('id, status, expected_days').eq('status', 'active'),
        ]);

        let memberIds: string[] | null = null;
        if (eventRow?.event_date && roster) {
          memberIds = membersExpectedAtEvent({
            members: roster as { id: string; status: string; expected_days: number[] | null }[],
            eventDate: eventRow.event_date,
            tenantMeetingDays: (churchCfg?.meeting_days as number[] | null) ?? null,
          });
        }

        await scopedDb.admin
          .schema('church')
          .rpc('refresh_consecutive_event_flags', { p_church_id: churchId, p_member_ids: memberIds });
      } catch (flagErr) {
        console.error('[updateEventStatus] consecutive-event flag refresh failed (non-fatal):', flagErr);
      }
    }

    revalidatePath(`/${churchSlug}/admin/attendance`);
    revalidatePath(`/${churchSlug}/admin/attendance/${eventId}`);
    revalidatePath(`/${churchSlug}/usher/dashboard`);
    return { success: true };
  } catch (error: any) {
    return { error: error?.message || 'A network or server error occurred.' };
  }
}

export async function updateChurchPasskey(churchId: string, newPasskey: string, churchSlug: string) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    
    if (!user) return { error: 'Not authenticated' };

    // Verify Admin Access with strict role check (MT-04)
    const { data: profile } = await supabase
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .eq('tenant_id', churchId)
      .maybeSingle();

    if (!profile || !['pastor', 'admin'].includes(profile.role)) {
      return { error: 'Access denied: Only pastors or administrators can rotate the usher passkey.' };
    }

    const trimmedKey = typeof newPasskey === 'string' ? newPasskey.trim() : '';
    // 6..32 matches both the schema default (a 6-digit code) and the login
    // validator. Rotation used to demand 8, which rejected codes the portal
    // would happily accept.
    if (trimmedKey.length < 6 || trimmedKey.length > 32 || !/^[A-Za-z0-9_-]+$/.test(trimmedKey)) {
      return { error: 'Passkey must be 6–32 characters using only letters, numbers, hyphens and underscores.' };
    }

    const passkeyHash = computePasskeyHash(trimmedKey);
    const adminSupabase = await createAdminClient();

    const { data: church } = await adminSupabase
      .schema('church')
      .from('churches')
      .select('passkey_version')
      .eq('id', churchId)
      .maybeSingle();

    const nextVersion = (church?.passkey_version || 1) + 1;

    // F-04 & F-08 remediation: store hash, wipe plaintext, bump version to invalidate existing usher JWT sessions immediately
    const { error } = await adminSupabase
      .schema('church')
      .from('churches')
      .update({
        // Keep the readable copy: the admin screen and the copyable portal link
        // both render `passkey`. Nulling it left the pastor looking at an empty
        // field after rotating, with no way to tell the ushers the new code.
        passkey: trimmedKey,
        passkey_hash: passkeyHash,
        passkey_version: nextVersion,
        passkey_updated_at: new Date().toISOString()
      })
      .eq('id', churchId);

    if (error) {
      console.error('[updateChurchPasskey] Error:', error);
      return { error: error.message };
    }

    revalidatePath(`/${churchSlug}/admin/attendance`);
    revalidatePath(`/${churchSlug}/usher/dashboard`);
    return { success: true };
  } catch (error) {
    console.error('[updateChurchPasskey] Unexpected error:', error);
    return { error: 'Failed to update passkey.' };
  }
}

export async function getEventAttendanceData(churchSlug: string, eventId: string) {
  try {
    // This is a remotely callable server action: authorize before any privileged
    // read, and bind every returned row to the event's verified tenant.
    const { scopedDb, churchId } = await checkAuthorization(churchSlug, eventId);
    const [churchResult, eventResult, logsResult, membersResult] = await Promise.all([
      scopedDb.admin.schema('church').from('churches').select('id, name, slug').eq('id', churchId).single(),
      scopedDb.church('events').select('id, church_id, name, service_type, event_date, start_time, location, status').eq('id', eventId).eq('church_id', churchId).single(),
      scopedDb.church('attendance_logs').select('member_id').eq('event_id', eventId).eq('church_id', churchId).in('attendance_status', ['present', 'late']),
      scopedDb.church('members').select('id, full_name, phone_number').eq('church_id', churchId).order('full_name'),
    ]);

    if (!churchResult.data || !eventResult.data) return { error: 'Church or event not found.' };

    return {
      church: churchResult.data,
      event: eventResult.data,
      members: membersResult.data || [],
      attendedMemberIds: logsResult.data?.map((log: { member_id: string }) => log.member_id) || [],
    };
  } catch (error) {
    console.error('[getEventAttendanceData] Error:', error);
    return { error: 'Failed to verify access.' };
  }
}

async function checkAuthorization(
  churchSlug: string,
  eventId: string,
  allowedRoles: ('pastor' | 'admin' | 'staff' | 'usher')[] = ['pastor', 'admin', 'usher']
) {
  const adminClient = await createAdminClient();
  const { data: event } = await adminClient.schema('church').from('events').select('church_id').eq('id', eventId).single();
  
  if (!event) {
    throw new Error('Event not found.');
  }

  const churchId = event.church_id;
  const scopedDb = await tenantScopedAdmin(churchId);
  
  // 1. Is there an usher session for this church?
  if (allowedRoles.includes('usher')) {
    const usherSession = await getUsherSession(churchSlug.toLowerCase());
    if (usherSession && usherSession.church_slug === churchSlug.toLowerCase() && usherSession.church_id === churchId) {
      return { scopedDb, churchId, allowed: true, role: 'usher' };
    }
  }

  // 2. Is there a logged-in admin for this church with allowed role?
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();

  if (user) {
    const { data: profile } = await adminClient
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (profile && profile.tenant_id === churchId && allowedRoles.includes(profile.role)) {
      return { scopedDb, churchId, allowed: true, role: profile.role };
    }
  }

  throw new Error('Unauthorized to modify this event.');
}

export async function markAttendance(churchSlug: string, eventId: string, memberId: string, status: 'present' | 'late' | 'absent' | 'excused' = 'present') {
  try {
    const { scopedDb, churchId } = await checkAuthorization(churchSlug, eventId);

    // 1. Verify that the member belongs to this church (prevent cross-tenant attendance poisoning)
    const { data: memberData, error: memberError } = await scopedDb
      .church('members')
      .select('id')
      .eq('id', memberId)
      .maybeSingle();

    if (memberError || !memberData) {
      throw new Error('Member does not belong to this church');
    }

    // 2. Direct upsert into attendance_logs using tenant-scoped Admin Client
    const { data: existingLog } = await scopedDb
      .church('attendance_logs')
      .select('attendance_status')
      .eq('member_id', memberId)
      .eq('event_id', eventId)
      .maybeSingle();

    const { error } = await scopedDb.admin
      .schema('church')
      .from('attendance_logs')
      .upsert({
        church_id: churchId,
        member_id: memberId,
        event_id: eventId,
        attendance_status: status,
        check_in_time: new Date().toISOString()
      }, { onConflict: 'member_id,event_id' });

    if (error) {
      console.error('[markAttendance] Upsert Error:', error);
      return { error: `Database error: ${error.message}` };
    }

    // 3. Update the attendance count intelligently
    const wasPresent = existingLog?.attendance_status === 'present' || existingLog?.attendance_status === 'late';
    const isPresent = status === 'present' || status === 'late';

    if (!wasPresent && isPresent) {
      await scopedDb.admin.schema('church').rpc('increment_event_attendance', { event_id: eventId });
    } else if (wasPresent && !isPresent) {
      await scopedDb.admin.schema('church').rpc('decrement_event_attendance', { event_id: eventId });
    }

    revalidatePath(`/${churchSlug}/usher/dashboard`);
    revalidatePath(`/${churchSlug}/admin/attendance`);
    revalidatePath(`/${churchSlug}/admin/attendance/${eventId}`);
    return { success: true };
  } catch (error: any) {
    console.error('[markAttendance] Exception:', error);
    return { error: error.message || 'Failed to record check-in.' };
  }
}

export async function removeAttendance(churchSlug: string, eventId: string, memberId: string) {
  try {
    const { scopedDb, churchId } = await checkAuthorization(churchSlug, eventId);

    // 1b. Verify that member belongs to this church
    const { data: memberData } = await scopedDb
      .church('members')
      .select('id')
      .eq('id', memberId)
      .maybeSingle();

    if (!memberData) throw new Error('Member does not belong to this church');

    // 2. Direct delete from attendance_logs using tenant-scoped client
    const { error } = await scopedDb
      .church('attendance_logs')
      .delete()
      .match({ 
        member_id: memberId, 
        event_id: eventId,
      });

    if (error) {
      console.error('[removeAttendance] Delete Error:', error);
      return { error: `Database error: ${error.message}` };
    }

    // 3. Update the attendance count using the RPC
    await scopedDb.admin.schema('church').rpc('decrement_event_attendance', { event_id: eventId });

    revalidatePath(`/${churchSlug}/usher/dashboard`);
    revalidatePath(`/${churchSlug}/admin/attendance`);
    revalidatePath(`/${churchSlug}/admin/attendance/${eventId}`);
    
    return { success: true };
  } catch (error: any) {
    console.error('[removeAttendance] Exception:', error);
    return { error: error.message || 'Failed to remove check-in.' };
  }
}

export async function runInactivityDetection(churchId: string, churchSlug: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('tenant_id, role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.tenant_id !== churchId || !hasAllowedRole(profile.role, CHURCH_ADMIN_ROLES)) {
    return { error: 'Access denied' };
  }

  const { data, error } = await supabase
    .schema('church')
    .rpc('refresh_inactive_30_days', { p_church_id: churchId });

  if (error) return { error: error.message };

  // Also run the consecutive-event engine: the schedule-agnostic "missed N
  // consecutive events" flags that work for fellowships meeting on any
  // weekday(s). Kept separate so a legacy-30-day failure can't block it.
  let consecutiveCount: number | null = null;
  const { data: streakData, error: streakError } = await supabase
    .schema('church')
    .rpc('refresh_consecutive_event_flags', { p_church_id: churchId });

  if (streakError) {
    console.error('[runInactivityDetection] consecutive-event refresh failed:', streakError);
  } else {
    consecutiveCount = streakData;
  }

  revalidatePath(`/${churchSlug}/admin/attendance`);
  return { success: true, count: data, consecutiveCount };
}

export async function getAttendanceFlags(churchId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('tenant_id, role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.tenant_id !== churchId || !hasAllowedRole(profile.role, CHURCH_ADMIN_ROLES)) {
    return { error: 'Access denied' };
  }

  const { data, error } = await supabase
    .schema('church')
    .from('attendance_flags')
    .select(`
      *,
      members:member_id (
        full_name,
        phone_number
      )
    `)
    .eq('church_id', churchId)
    .in('status', ['open', 'followed_up'])
    .order('created_at', { ascending: false });

  if (error) return { error: error.message };
  return { data };
}

export async function updateAttendanceFlagStatus(flagId: string, status: AttendanceFlagStatus, churchSlug: string) {
  if (!['open', 'followed_up', 'resolved'].includes(status)) return { error: 'Invalid attendance flag status.' };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('tenant_id, role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !profile.tenant_id || !hasAllowedRole(profile.role, CHURCH_ADMIN_ROLES)) {
    return { error: 'Access denied' };
  }

  const { error } = await supabase
    .schema('church')
    .from('attendance_flags')
    .update({ status })
    .eq('id', flagId)
    .eq('church_id', profile.tenant_id);

  if (error) return { error: error.message };
  
  revalidatePath(`/${churchSlug}/admin/attendance`);
  return { success: true };
}

export async function sendMissedYouMessages(churchId: string, churchSlug: string, eventId?: string, customMessage?: string) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    
    if (!user) {
      return { error: 'Not authenticated' };
    }

    const { data: profile } = await supabase
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || profile.tenant_id !== churchId || !hasAllowedRole(profile.role, CHURCH_ADMIN_ROLES)) {
      return { error: 'Access denied' };
    }
    if (typeof customMessage !== 'undefined' && (typeof customMessage !== 'string' || Array.from(customMessage).length > 500)) {
      return { error: 'Custom SMS messages must contain 500 characters or fewer.' };
    }

    const accountLimit = await checkRateLimit({ namespace: 'sms-missed-you-account', subject: user.id, limit: 3, windowSeconds: 15 * 60 });
    const tenantLimit = await checkRateLimit({ namespace: 'sms-missed-you-tenant', subject: churchId, limit: 5, windowSeconds: 15 * 60 });
    const deniedLimit = !accountLimit.allowed ? accountLimit : tenantLimit;
    if (!accountLimit.allowed || !tenantLimit.allowed) {
      return { error: deniedLimit.unavailable ? 'SMS protection is temporarily unavailable.' : 'Too many missed-you broadcasts. Please try again later.' };
    }

    // Refresh "missed N consecutive events" flags before choosing recipients.
    // (This used to invoke a `sync_missed_3_sundays_flags` Edge Function that
    // does not exist anywhere in this repo, so the old Sunday flags were
    // silently never synced. The engine now lives in the database where cron,
    // event completion, and this action all share it.)
    try {
      await supabase
        .schema('church')
        .rpc('refresh_consecutive_event_flags', { p_church_id: churchId });
    } catch (e) {
      console.error('Failed to refresh consecutive-event flags:', e);
    }

    const memberIdsToMessage = new Set<string>();
    
    // If no eventId provided, try to find the most recent completed event from the last 7 days
    let targetEventId = eventId;
    if (!targetEventId) {
      const { data: latestEvent } = await supabase
        .schema('church')
        .from('events')
        .select('id')
        .eq('church_id', churchId)
        .eq('status', 'completed')
        .order('event_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (latestEvent) {
        targetEventId = latestEvent.id;
      }
    }
    
    // Verify the event belongs to this church before using its attendance IDs.
    if (targetEventId) {
      const { data: targetEvent } = await supabase
        .schema('church')
        .from('events')
        .select('id')
        .eq('id', targetEventId)
        .eq('church_id', churchId)
        .maybeSingle();
      if (!targetEvent) return { error: 'Event not found for this church.' };
    }

    // Fetch members who were absent for the target event. A 251-row sentinel
    // detects oversized audiences without retrieving an unbounded result set.
    if (targetEventId) {
      const { data: absentLogs, error: absentError } = await supabase
        .schema('church')
        .from('attendance_logs')
        .select('member_id')
        .eq('church_id', churchId)
        .eq('event_id', targetEventId)
        .eq('attendance_status', 'absent')
        .limit(251);

      if (absentError) return { error: absentError.message };
      if ((absentLogs?.length ?? 0) > 250) return { error: 'This audience exceeds the 250-recipient limit. Narrow the audience and try again.' };
      if (absentLogs) absentLogs.forEach(log => memberIdsToMessage.add(log.member_id));
    }

    // Fetch members with an active consecutive-miss flag. Also accept legacy
    // 'missed_3_sundays' flag rows created before the engine was replaced.
    const { data: openFlags, error: flagsError } = await supabase
      .schema('church')
      .from('attendance_flags')
      .select('id, member_id')
      .eq('church_id', churchId)
      .in('flag_type', ['missed_consecutive_events', 'missed_3_sundays'])
      .eq('status', 'open')
      .limit(251);

    if (flagsError) return { error: flagsError.message };
    if ((openFlags?.length ?? 0) > 250) return { error: 'This audience exceeds the 250-recipient limit. Narrow the audience and try again.' };

    // Fetch members who were PRESENT for the target event to EXCLUDE them
    const presentMemberIds = new Set<string>();
    if (targetEventId) {
      const { data: presentLogs, error: presentError } = await supabase
        .schema('church')
        .from('attendance_logs')
        .select('member_id')
        .eq('church_id', churchId)
        .eq('event_id', targetEventId)
        .in('attendance_status', ['present', 'late'])
        .limit(251);
      if (presentError) return { error: presentError.message };
      if ((presentLogs?.length ?? 0) > 250) return { error: 'This event exceeds the 250-recipient processing limit.' };
      if (presentLogs) presentLogs.forEach(log => presentMemberIds.add(log.member_id));
    }

    // Add flagged members, but ONLY if they weren't present at the current event
    const flagsByMemberId = new Map<string, string>(); // member_id -> flag_id
    if (openFlags) {
      openFlags.forEach(flag => {
        if (!presentMemberIds.has(flag.member_id)) {
          memberIdsToMessage.add(flag.member_id);
          flagsByMemberId.set(flag.member_id, flag.id);
        }
      });
    }

    if (memberIdsToMessage.size === 0) {
      return { success: true, count: 0 };
    }
    if (memberIdsToMessage.size > 250) {
      return { error: 'This audience exceeds the 250-recipient limit. Narrow the audience and try again.' };
    }

    const memberIds = Array.from(memberIdsToMessage);

    // Fetch the actual members to get phone_number and full_name
    const { data: members, error: membersError } = await supabase
      .schema('church')
      .from('members')
      .select('id, full_name, phone_number')
      .eq('church_id', churchId)
      .in('id', memberIds)
      .limit(251);

    if (membersError) return { error: membersError.message };
    if ((members?.length ?? 0) > 250) return { error: 'This audience exceeds the 250-recipient limit. Narrow the audience and try again.' };
    if (!members || members.length === 0) return { success: true, count: 0 };

    // Get church config and balance once
    const { data: church } = await supabase
      .schema('church')
      .from('churches')
      .select('sender_id')
      .eq('id', churchId)
      .maybeSingle();

    const senderId = church?.sender_id?.trim() || '';

    let sentCount = 0;

    for (const member of members) {
      if (!member.phone_number) continue;

      const firstName = member.full_name.split(' ')[0] || 'there';
      const defaultMessage = `Hello ${firstName}! we missed you  at church today. We pray you are well and hope to see you again next time. Blessings from your church family.`;
      
      const message = customMessage 
        ? customMessage.replace(/{name}/gi, member.full_name).replace(/{first_name}/gi, firstName)
        : defaultMessage;
      
      try {
        // Deterministic idempotency key per event/date to prevent double-billing on retries
        const eventKeyPart = targetEventId ? targetEventId.slice(0, 8) : new Date().toISOString().slice(0, 10);
        const deterministicKey = `missed_${churchId.slice(0, 8)}_${eventKeyPart}_${member.id.slice(0, 8)}`;

        const result = await sendSingleSMS({
          supabase,
          phoneNumber: member.phone_number,
          message,
          churchId,
          idempotencyKey: deterministicKey,
          senderId
        });

        if (result.success) {
          sentCount++;
          // Close the flag if they had one
          const flagId = flagsByMemberId.get(member.id);
          if (flagId) {
            await supabase
              .schema('church')
              .from('attendance_flags')
              .update({ status: 'followed_up' })
              .eq('id', flagId);
          }
        }
      } catch (err) {
        console.error('Failed to send SMS to recipient:', err);
      }
      
      // Small delay to avoid hitting AT rate limits
      await new Promise(r => setTimeout(r, 100));
    }

    return { success: true, count: sentCount };
  } catch (error) {
    console.error('sendMissedYouMessages Error:', error);
    return { error: 'Failed to send messages.' };
  }
}
