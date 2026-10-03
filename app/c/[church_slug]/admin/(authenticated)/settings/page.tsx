import { getChurchBySlug } from '@/lib/db';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import JoinDenominationCard from '@/components/settings/JoinDenominationCard';
import { Settings, Church as ChurchIcon, Shield, Radio, Calendar, KeyRound, ExternalLink } from 'lucide-react';
import Link from 'next/link';

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ church_slug: string }>;
}) {
  const { church_slug } = await params;
  const church = await getChurchBySlug(church_slug);

  if (!church) {
    notFound();
  }

  const supabase = await createClient();
  const adminDb = await createAdminClient();

  // Query church details from church schema
  const { data: churchRow } = await adminDb
    .schema('church')
    .from('churches')
    .select('*')
    .eq('id', church.id)
    .maybeSingle();

  // Check denomination link
  const denominationId = (churchRow as any)?.denomination_id || null;
  let denominationName: string | null = null;
  let denominationSlug: string | null = null;

  if (denominationId) {
    // Attempt to query denomination info if available
    try {
      const { data: denomRow } = await adminDb
        .from('denominations')
        .select('name, slug')
        .eq('id', denominationId)
        .maybeSingle();

      if (denomRow) {
        denominationName = denomRow.name;
        denominationSlug = denomRow.slug;
      }
    } catch {
      // Ignored if table not directly queryable
    }
  }

  // Get active session user
  const { data: { user } } = await supabase.auth.getUser();

  const meetingDaysNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const configuredMeetingDays: number[] = (churchRow as any)?.meeting_days || [7]; // 7 is Sunday in ISO
  const attendanceThreshold = (churchRow as any)?.attendance_flag_threshold ?? 3;

  return (
    <div className="space-y-8 max-w-5xl" style={{ fontFamily: "'Outfit', sans-serif" }}>
      {/* Header */}
      <div>
        <div className="flex items-center gap-2.5 text-[#B5622A] text-xs font-bold uppercase tracking-wider mb-2">
          <Settings className="w-4 h-4" />
          <span>Administration</span>
        </div>
        <h1 
          style={{ fontFamily: "'Playfair Display', serif" }} 
          className="text-3xl font-bold text-[#1E1208]"
        >
          Workspace Settings
        </h1>
        <p className="text-sm text-[#9A7E65] mt-1">
          Configure your ministry workspace, denomination network affiliation, and communication parameters.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2 Cols): Core Settings */}
        <div className="lg:col-span-2 space-y-6">
          {/* Denomination Affiliation Component */}
          <JoinDenominationCard
            churchSlug={church_slug}
            churchId={church.id}
            denominationName={denominationName}
            denominationSlug={denominationSlug}
            isLinked={Boolean(denominationId)}
          />

          {/* Ministry Profile Card */}
          <div className="bg-[#F0E6D3] rounded-2xl border border-[rgba(90,55,20,0.13)] p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-5 pb-4 border-b border-[rgba(90,55,20,0.08)]">
              <div className="p-2.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl">
                <ChurchIcon className="w-5 h-5 text-[#B5622A]" />
              </div>
              <div>
                <h2 className="text-base font-bold text-[#1E1208]">Ministry Identity</h2>
                <p className="text-xs text-[#9A7E65]">Public church profile and routing address</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-bold text-[#9A7E65] uppercase tracking-wider mb-1">
                  Church Name
                </label>
                <div className="px-4 py-3 bg-white/70 border border-[rgba(90,55,20,0.12)] rounded-xl text-sm font-semibold text-[#1E1208]">
                  {church.name}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[#9A7E65] uppercase tracking-wider mb-1">
                  Workspace Slug
                </label>
                <div className="px-4 py-3 bg-white/70 border border-[rgba(90,55,20,0.12)] rounded-xl text-sm font-mono text-[#B5622A]">
                  /{church.slug}
                </div>
              </div>

              <div className="md:col-span-2">
                <label className="block text-[11px] font-bold text-[#9A7E65] uppercase tracking-wider mb-1">
                  Public Portal Link
                </label>
                <div className="flex items-center justify-between px-4 py-3 bg-white/70 border border-[rgba(90,55,20,0.12)] rounded-xl text-xs font-mono text-[#6B513E]">
                  <span className="truncate">/{church.slug}</span>
                  <Link 
                    href={`/${church.slug}`}
                    target="_blank"
                    className="flex items-center gap-1 text-[#B5622A] font-bold hover:underline ml-2 flex-shrink-0"
                  >
                    <span>View Portal</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </Link>
                </div>
              </div>
            </div>
          </div>

          {/* Attendance & Streak Rules */}
          <div className="bg-[#F0E6D3] rounded-2xl border border-[rgba(90,55,20,0.13)] p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-5 pb-4 border-b border-[rgba(90,55,20,0.08)]">
              <div className="p-2.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl">
                <Calendar className="w-5 h-5 text-[#B5622A]" />
              </div>
              <div>
                <h2 className="text-base font-bold text-[#1E1208]">Attendance Monitoring Rules</h2>
                <p className="text-xs text-[#9A7E65]">Automated consecutive missed service flags</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between p-3.5 bg-white/60 rounded-xl border border-[rgba(90,55,20,0.08)]">
                <div>
                  <span className="text-xs font-bold text-[#1E1208] block">Consecutive Missed Event Alert Threshold</span>
                  <span className="text-[11px] text-[#9A7E65]">Members are flagged for pastoral follow-up after missing this many services.</span>
                </div>
                <span className="px-3 py-1 bg-[#2B1A0E] text-[#F5E6CE] font-mono text-xs font-bold rounded-lg">
                  {attendanceThreshold} Services
                </span>
              </div>

              <div className="p-3.5 bg-white/60 rounded-xl border border-[rgba(90,55,20,0.08)]">
                <span className="text-xs font-bold text-[#1E1208] block mb-1">Standard Fellowship Days</span>
                <div className="flex gap-1.5 flex-wrap">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, idx) => {
                    const isoDay = idx + 1;
                    const isActive = configuredMeetingDays.includes(isoDay);
                    return (
                      <span 
                        key={day}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
                          isActive 
                            ? 'bg-[#B5622A] text-white shadow-xs' 
                            : 'bg-black/5 text-[#9A7E65]'
                        }`}
                      >
                        {day}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Quick Status & Account */}
        <div className="space-y-6">
          {/* Pastor Account */}
          <div className="bg-[#F0E6D3] rounded-2xl border border-[rgba(90,55,20,0.13)] p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl">
                <Shield className="w-4 h-4 text-[#B5622A]" />
              </div>
              <h3 className="text-sm font-bold text-[#1E1208]">Pastor Account</h3>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <span className="text-[10px] uppercase font-bold text-[#9A7E65] tracking-wider block">Signed In As</span>
                <span className="text-[#1E1208] font-medium font-mono text-[11px] truncate block mt-0.5">
                  {user?.email || 'Authenticated Pastor'}
                </span>
              </div>
              <div>
                <span className="text-[10px] uppercase font-bold text-[#9A7E65] tracking-wider block">Role</span>
                <span className="inline-block mt-0.5 px-2 py-0.5 bg-[#B5622A]/10 text-[#B5622A] rounded font-bold uppercase tracking-wider text-[10px]">
                  Pastor Admin
                </span>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="bg-[#2B1A0E] rounded-2xl p-6 text-[#F5E6CE] shadow-md">
            <h3 
              style={{ fontFamily: "'Playfair Display', serif" }}
              className="text-lg font-bold mb-2"
            >
              Need Support?
            </h3>
            <p className="text-xs text-[#C8B89A] leading-relaxed mb-4">
              For assistance setting up custom SMS sender IDs, multi-campus branches, or diocese overseer connections.
            </p>
            <div className="space-y-2">
              <Link 
                href={`/${church_slug}/admin/messages`}
                className="block text-center w-full py-2.5 bg-[#B5622A] hover:bg-[#C6733B] text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-colors"
              >
                SMS & Communication
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
