'use server';

import { revalidatePath } from 'next/cache';
import { assertChurchAdminAuth } from '@/lib/tenant';
import { createAdminClient } from '@/lib/supabase/server';
import { normalizeMeetingDays } from '@/lib/meeting-days';
import { validateBirthdayTemplate } from '@/lib/birthday';

export async function updateChurchMeetingDays(churchSlug: string, requestedDays: unknown) {
  const meetingDays = normalizeMeetingDays(requestedDays);
  if (!meetingDays) {
    return { error: 'Choose at least one valid weekday.' };
  }

  try {
    // This server action accepts only the authenticated pastor of this workspace.
    // The service-role client is used only on the server, after identity, role,
    // and church-slug ownership are verified; the update is restricted to this
    // church row and the meeting_days column.
    const { church, role } = await assertChurchAdminAuth(churchSlug, ['pastor']);
    if (role !== 'pastor') {
      return { error: 'Only this church’s pastor can change its regular meeting days.' };
    }

    const adminDb = await createAdminClient();
    const { data, error } = await adminDb
      .schema('church')
      .from('churches')
      .update({ meeting_days: meetingDays })
      .eq('id', church.id)
      .select('meeting_days')
      .maybeSingle();

    if (error) {
      console.error('[updateChurchMeetingDays] Database update failed:', error);
      if (error.code === '42703' || /meeting_days/i.test(error.message)) {
        return { error: 'Meeting-day settings are not available until the database schema is updated.' };
      }
      return { error: 'Could not save meeting days. Please try again.' };
    }
    if (!data) {
      return { error: 'This church workspace was not found; no settings were changed.' };
    }

    revalidatePath(`/${churchSlug}/admin/settings`);
    revalidatePath(`/${churchSlug}/admin/attendance`);
    return { success: true, meetingDays: data.meeting_days as number[] };
  } catch (error) {
    console.error('[updateChurchMeetingDays] Authorization or update failed:', error);
    return {
      error: error instanceof Error && error.message.startsWith('Unauthorized:')
        ? 'Only this church’s pastor can change its regular meeting days.'
        : 'Could not save meeting days. Please try again.',
    };
  }
}

/**
 * Birthday wishes — the per-church ON/OFF switch and its optional message.
 *
 * Writes the row the daily pg_cron job (church.enqueue_daily_birthdays,
 * migrations/025_birthday_automation.sql) reads each morning: enabled=false
 * (the default) means the job skips the church entirely, so no SMS is ever
 * paid for or sent until a pastor turns the feature on here.
 *
 * Same trust shape as updateChurchMeetingDays: only this workspace's pastor,
 * service-role write scoped to the verified church id, and a friendly error if
 * the database has not received migration 025 yet.
 */
export async function updateBirthdayWishes(
  churchSlug: string,
  enabled: unknown,
  customTemplate: unknown,
) {
  const enable = enabled === true || enabled === 'true';
  const templateCheck = validateBirthdayTemplate(customTemplate);
  if (!templateCheck.ok) {
    return { error: templateCheck.error };
  }

  try {
    const { church, role } = await assertChurchAdminAuth(churchSlug, ['pastor']);
    if (role !== 'pastor') {
      return { error: 'Only this church’s pastor can change its birthday wishes settings.' };
    }

    const adminDb = await createAdminClient();
    const { error } = await adminDb
      .schema('church')
      .from('birthday_automation')
      .upsert(
        {
          church_id: church.id,
          enabled: enable,
          custom_template: templateCheck.value,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'church_id' },
      );

    if (error) {
      console.error('[updateBirthdayWishes] Database upsert failed:', error);
      if (error.code === '42P01' || error.code === '42703' || /birthday_automation/i.test(error.message)) {
        return { error: 'Birthday wishes are not available until the database schema is updated (migration 025).' };
      }
      return { error: 'Could not save birthday wishes. Please try again.' };
    }

    revalidatePath(`/${churchSlug}/admin/settings`);
    return { success: true, enabled: enable, customTemplate: templateCheck.value };
  } catch (error) {
    console.error('[updateBirthdayWishes] Authorization or upsert failed:', error);
    return {
      error: error instanceof Error && error.message.startsWith('Unauthorized:')
        ? 'Only this church’s pastor can change its birthday wishes settings.'
        : 'Could not save birthday wishes. Please try again.',
    };
  }
}
