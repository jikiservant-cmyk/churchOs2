'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, Check, Loader2, Save } from 'lucide-react';
import { updateChurchMeetingDays } from '@/lib/church-settings-actions';
import { ISO_WEEKDAYS, normalizeMeetingDays } from '@/lib/meeting-days';

const WEEKDAYS = [
  { label: 'Mon', name: 'Monday', iso: 1 },
  { label: 'Tue', name: 'Tuesday', iso: 2 },
  { label: 'Wed', name: 'Wednesday', iso: 3 },
  { label: 'Thu', name: 'Thursday', iso: 4 },
  { label: 'Fri', name: 'Friday', iso: 5 },
  { label: 'Sat', name: 'Saturday', iso: 6 },
  { label: 'Sun', name: 'Sunday', iso: 7 },
] as const;

interface MeetingDaysSettingsProps {
  churchSlug: string;
  initialDays: number[];
  hasNoStoredSchedule: boolean;
  canEdit: boolean;
  schemaAvailable: boolean;
}

export default function MeetingDaysSettings({
  churchSlug,
  initialDays,
  hasNoStoredSchedule,
  canEdit,
  schemaAvailable,
}: MeetingDaysSettingsProps) {
  const router = useRouter();
  const initialDaysKey = useMemo(() => initialDays.join(','), [initialDays]);
  const [selectedDays, setSelectedDays] = useState<number[]>(initialDays);
  const [savedDays, setSavedDays] = useState<number[]>(initialDays);
  const [noStoredSchedule, setNoStoredSchedule] = useState(hasNoStoredSchedule);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    const nextDays = initialDaysKey
      ? initialDaysKey.split(',').map(Number)
      : [...ISO_WEEKDAYS];
    setSelectedDays(nextDays);
    setSavedDays(nextDays);
    setNoStoredSchedule(hasNoStoredSchedule);
    setError(null);
    setSuccess(null);
  }, [initialDaysKey, hasNoStoredSchedule]);

  const hasChanges = selectedDays.join(',') !== savedDays.join(',');

  const toggleDay = (day: number) => {
    setSelectedDays((current) => {
      if (current.includes(day)) {
        if (current.length === 1) return current;
        return current.filter((selected) => selected !== day);
      }
      return [...current, day].sort((a, b) => a - b);
    });
    setError(null);
    setSuccess(null);
  };

  const saveDays = async () => {
    if (!hasChanges || isSaving) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await updateChurchMeetingDays(churchSlug, selectedDays);
      if (result.error || !result.success) {
        setError(result.error || 'Could not save meeting days. Please try again.');
        return;
      }

      const normalized = normalizeMeetingDays(result.meetingDays) || selectedDays;
      setSelectedDays(normalized);
      setSavedDays(normalized);
      setNoStoredSchedule(false);
      setSuccess('Regular meeting days saved. Attendance follow-up will use this schedule.');
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save meeting days. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-[rgba(90,55,20,0.13)] bg-[#F0E6D3] p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3 border-b border-[rgba(90,55,20,0.08)] pb-4">
        <div className="rounded-xl bg-[#2B1A0E] p-2.5 text-[#F5E6CE]">
          <Calendar className="h-4 w-4 text-[#B5622A]" />
        </div>
        <div>
          <h2 className="text-base font-bold text-[#1E1208]">Fellowship &amp; service days</h2>
          <p className="text-[12px] text-[#9A7E65]">Set the regular weekdays your church meets.</p>
        </div>
      </div>

      {!schemaAvailable && (
        <p className="mb-4 rounded-xl border border-amber-700/15 bg-amber-100/60 p-3 text-[12px] leading-relaxed text-amber-900" role="status">
          Meeting-day settings could not be loaded from the database. The save controls are disabled to avoid reporting changes that cannot be stored; other church settings remain available.
        </p>
      )}

      {schemaAvailable && noStoredSchedule && (
        <p className="mb-4 rounded-xl border border-[rgba(90,55,20,0.08)] bg-white/50 p-3 text-[11px] leading-relaxed text-[#6B513E]">
          No weekday filter is stored yet, so attendance monitoring currently considers completed events on any day. Choose your regular days below to narrow that rule.
        </p>
      )}

      {schemaAvailable ? (
        <>
          <p className="mb-3 text-[13px] font-bold text-[#1E1208]">Which days do your services or fellowships normally meet?</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Regular service and fellowship weekdays">
            {WEEKDAYS.map(({ label, name, iso }) => {
              const active = selectedDays.includes(iso);
              return (
                <button
                  key={iso}
                  type="button"
                  aria-pressed={active}
                  aria-label={`${name}${active ? ', selected' : ', not selected'}`}
                  title={active && selectedDays.length === 1 ? 'At least one meeting day must remain selected' : `Toggle ${name}`}
                  disabled={!canEdit || isSaving || (active && selectedDays.length === 1)}
                  onClick={() => toggleDay(iso)}
                  className={`inline-flex min-w-[3.25rem] items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-xs font-bold transition ${
                    active
                      ? 'border-[#B5622A] bg-[#B5622A] text-white shadow-sm'
                      : 'border-[rgba(90,55,20,0.12)] bg-white/60 text-[#6B513E] hover:border-[#B5622A]/50 hover:bg-white'
                  } disabled:cursor-not-allowed disabled:opacity-70`}
                >
                  {active && <Check className="h-3.5 w-3.5" />}
                  {label}
                </button>
              );
            })}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-[#9A7E65]">
            This sets the church-wide attendance schedule. It does not create calendar events; add each service or fellowship on the Attendance page. Individual member expected days continue to apply as well.
          </p>

          {!canEdit && (
            <p className="mt-3 text-[11px] font-medium text-[#9A7E65]">
              Only this church’s pastor can change the regular meeting days.
            </p>
          )}
        </>
      ) : (
        <p className="text-[12px] leading-relaxed text-[#6B513E]">
          The saved schedule is unavailable right now. Once the database can provide meeting-day settings, this panel will show the current days here.
        </p>
      )}

      {error && <p className="mt-3 text-[12px] font-semibold text-red-800" role="alert">{error}</p>}
      {success && <p className="mt-3 text-[12px] font-semibold text-emerald-800" role="status">{success}</p>}

      {canEdit && schemaAvailable && (
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-[rgba(90,55,20,0.08)] pt-4">
          <p className="text-[11px] text-[#9A7E65]">{selectedDays.length} {selectedDays.length === 1 ? 'day' : 'days'} selected</p>
          <button
            type="button"
            onClick={saveDays}
            disabled={!hasChanges || isSaving}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-[#2B1A0E] px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-[#F5E6CE] transition hover:bg-[#3D2614] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {isSaving ? 'Saving…' : 'Save days'}
          </button>
        </div>
      )}
    </section>
  );
}
