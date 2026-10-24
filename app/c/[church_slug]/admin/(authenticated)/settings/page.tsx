import { getChurchBySlug } from '@/lib/db';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import JoinDenominationCard from '@/components/settings/JoinDenominationCard';
import MeetingDaysSettings from '@/components/settings/MeetingDaysSettings';
import { ISO_WEEKDAYS } from '@/lib/meeting-days';
import { Church as ChurchIcon, ExternalLink, Settings, Shield } from 'lucide-react';

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ church_slug: string }>;
}) {
  const { church_slug } = await params;
  const church = await getChurchBySlug(church_slug);
  if (!church) notFound();

  const [supabase, adminDb] = await Promise.all([createClient(), createAdminClient()]);
  const [
    { data: churchRow },
    { data: scheduleRow, error: scheduleError },
    { data: { user } },
  ] = await Promise.all([
    adminDb
      .schema('church')
      .from('churches')
      .select('denomination_id')
      .eq('id', church.id)
      .maybeSingle(),
    adminDb
      .schema('church')
      .from('churches')
      .select('meeting_days, attendance_flag_threshold')
      .eq('id', church.id)
      .maybeSingle(),
    supabase.auth.getUser(),
  ]);

  let canJoinDenomination = false;
  let canEditMeetingDays = false;
  if (user) {
    const { data: profile } = await supabase
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .maybeSingle();
    const isChurchPastor = profile?.tenant_id === church.id && profile.role === 'pastor';
    canJoinDenomination = isChurchPastor;
    canEditMeetingDays = isChurchPastor;
  }

  const denominationId = churchRow?.denomination_id ?? null;
  let denominationName: string | null = null;
  let denominationSlug: string | null = null;

  if (denominationId) {
    const { data: denomination } = await adminDb
      .from('denominations')
      .select('name, slug')
      .eq('id', denominationId)
      .maybeSingle();
    denominationName = denomination?.name ?? null;
    denominationSlug = denomination?.slug ?? null;
  }

  const meetingDaysSchemaAvailable = !scheduleError;
  const hasNoStoredSchedule = meetingDaysSchemaAvailable && scheduleRow?.meeting_days == null;
  // NULL means there is no weekday filter in attendance monitoring, so show
  // every ISO weekday as eligible rather than misleadingly displaying Sunday.
  const configuredMeetingDays: number[] = meetingDaysSchemaAvailable
    ? scheduleRow?.meeting_days ?? [...ISO_WEEKDAYS]
    : [...ISO_WEEKDAYS];
  const attendanceThreshold = scheduleRow?.attendance_flag_threshold ?? 3;

  return (
    <div className="mx-auto max-w-7xl space-y-6" style={{ fontFamily: "'Outfit', sans-serif" }}>
      <header className="mb-2">
        <div className="mb-2 flex items-center gap-2.5 text-xs font-bold uppercase tracking-wider text-[#B5622A]">
          <Settings className="h-4 w-4" />
          <span>Administration</span>
        </div>
        <h1 style={{ fontFamily: "'Playfair Display', serif" }} className="text-3xl font-bold text-[#1E1208]">
          Settings
        </h1>
        <p className="mt-1.5 text-[13px] font-medium text-[#9A7E65]">
          Manage your church workspace, denomination affiliation, and ministry preferences.
        </p>
      </header>

      <JoinDenominationCard
        churchSlug={church_slug}
        denominationName={denominationName}
        denominationSlug={denominationSlug}
        isLinked={Boolean(denominationId)}
        canJoin={canJoinDenomination}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="rounded-2xl border border-[rgba(90,55,20,0.13)] bg-[#F0E6D3] p-6 shadow-sm">
            <div className="mb-5 flex items-center gap-3 border-b border-[rgba(90,55,20,0.08)] pb-4">
              <div className="rounded-xl bg-[#2B1A0E] p-2.5 text-[#F5E6CE]">
                <ChurchIcon className="h-4 w-4 text-[#B5622A]" />
              </div>
              <div>
                <h2 className="text-base font-bold text-[#1E1208]">Ministry Identity</h2>
                <p className="text-[12px] text-[#9A7E65]">Your public church profile and workspace address.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[#9A7E65]">Church name</span>
                <div className="rounded-xl border border-[rgba(90,55,20,0.1)] bg-white/60 px-4 py-3 text-sm font-semibold text-[#1E1208]">
                  {church.name}
                </div>
              </div>
              <div>
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[#9A7E65]">Workspace slug</span>
                <div className="rounded-xl border border-[rgba(90,55,20,0.1)] bg-white/60 px-4 py-3 font-mono text-sm text-[#B5622A]">
                  /{church.slug}
                </div>
              </div>
              <div className="md:col-span-2">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[#9A7E65]">Public portal</span>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-[rgba(90,55,20,0.1)] bg-white/60 px-4 py-3">
                  <span className="truncate font-mono text-xs text-[#6B513E]">/{church.slug}</span>
                  <Link
                    href={`/${church.slug}`}
                    target="_blank"
                    className="inline-flex shrink-0 items-center gap-1.5 text-xs font-bold text-[#B5622A] transition-colors hover:text-[#8E471D]"
                  >
                    View portal <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-[rgba(90,55,20,0.13)] bg-[#F0E6D3] p-6 shadow-sm">
            <div className="mb-5 flex items-center gap-3 border-b border-[rgba(90,55,20,0.08)] pb-4">
              <div className="rounded-xl bg-[#2B1A0E] p-2.5 text-[#F5E6CE]">
                <Shield className="h-4 w-4 text-[#B5622A]" />
              </div>
              <div>
                <h2 className="text-base font-bold text-[#1E1208]">Attendance Monitoring</h2>
                <p className="text-[12px] text-[#9A7E65]">Current rules used for pastoral follow-up alerts.</p>
              </div>
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-[rgba(90,55,20,0.08)] bg-white/50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[13px] font-bold text-[#1E1208]">Missed-event alert threshold</p>
                <p className="mt-0.5 text-[11px] text-[#9A7E65]">Number of consecutive services before a member is flagged.</p>
              </div>
              <span className="self-start rounded-lg bg-[#2B1A0E] px-3 py-1.5 font-mono text-xs font-bold text-[#F5E6CE] sm:self-auto">
                {attendanceThreshold} services
              </span>
            </div>
          </section>

          <MeetingDaysSettings
            churchSlug={church_slug}
            initialDays={configuredMeetingDays}
            hasNoStoredSchedule={hasNoStoredSchedule}
            canEdit={canEditMeetingDays}
            schemaAvailable={meetingDaysSchemaAvailable}
          />
        </div>

        <aside className="space-y-6">
          <section className="rounded-2xl border border-[rgba(90,55,20,0.13)] bg-[#F0E6D3] p-6 shadow-sm">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-xl bg-[#2B1A0E] p-2.5 text-[#F5E6CE]">
                <Shield className="h-4 w-4 text-[#B5622A]" />
              </div>
              <h2 className="text-sm font-bold text-[#1E1208]">Signed-in account</h2>
            </div>
            <div className="space-y-3">
              <div>
                <span className="block text-[10px] font-bold uppercase tracking-wider text-[#9A7E65]">Email</span>
                <span className="mt-1 block truncate font-mono text-[11px] text-[#1E1208]">
                  {user?.email || 'Authenticated church administrator'}
                </span>
              </div>
              <div>
                <span className="block text-[10px] font-bold uppercase tracking-wider text-[#9A7E65]">Workspace</span>
                <span className="mt-1 inline-flex rounded-md bg-[#B5622A]/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#B5622A]">
                  {church.name}
                </span>
              </div>
            </div>
          </section>

          <section className="rounded-2xl bg-[#2B1A0E] p-6 text-[#F5E6CE] shadow-md">
            <h2 style={{ fontFamily: "'Playfair Display', serif" }} className="text-lg font-bold">
              Need help?
            </h2>
            <p className="mt-2 text-[12px] leading-relaxed text-[#C8B89A]">
              Ask your denomination overseer for an invite code, or contact support for workspace assistance.
            </p>
            <Link
              href={`/${church_slug}/admin/messages`}
              className="mt-4 block w-full rounded-xl bg-[#B5622A] px-4 py-2.5 text-center text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-[#C6733B]"
            >
              Contact support
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
