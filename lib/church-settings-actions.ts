'use server';

import { revalidatePath } from 'next/cache';
import { assertChurchAdminAuth } from '@/lib/tenant';
import { createAdminClient } from '@/lib/supabase/server';
import { normalizeMeetingDays } from '@/lib/meeting-days';

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
