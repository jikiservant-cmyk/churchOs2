'use client';

import { useMemo, useState } from 'react';
import { Cake, Check, Loader2, Save } from 'lucide-react';
import { updateBirthdayWishes } from '@/lib/church-settings-actions';
import {
  BIRTHDAY_DEFAULT_TEMPLATE,
  BIRTHDAY_TEMPLATE_MAX,
  renderBirthdayMessage,
} from '@/lib/birthday';

interface BirthdayWishesCardProps {
  churchSlug: string;
  churchName: string;
  initialEnabled: boolean;
  initialTemplate: string | null;
  canEdit: boolean;
  schemaAvailable: boolean;
}

export default function BirthdayWishesCard({
  churchSlug,
  churchName,
  initialEnabled,
  initialTemplate,
  canEdit,
  schemaAvailable,
}: BirthdayWishesCardProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [template, setTemplate] = useState(initialTemplate ?? '');
  const [savedEnabled, setSavedEnabled] = useState(initialEnabled);
  const [savedTemplate, setSavedTemplate] = useState(initialTemplate ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const effectiveTemplate = template.trim() === '' ? BIRTHDAY_DEFAULT_TEMPLATE : template;
  const preview = useMemo(
    () => renderBirthdayMessage(effectiveTemplate, 'Sarah Nakato', churchName),
    [effectiveTemplate, churchName],
  );
  const overLimit = template.trim().length > BIRTHDAY_TEMPLATE_MAX;
  const hasChanges = enabled !== savedEnabled || template !== savedTemplate;

  const save = async () => {
    if (!canEdit || isSaving || overLimit) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await updateBirthdayWishes(churchSlug, enabled, template);
      if (result.success) {
        setSavedEnabled(enabled);
        setSavedTemplate(template);
        setSuccess(enabled
          ? 'Birthday wishes are ON — members with a birthday get their message at 8:00am (Kampala time).'
          : 'Birthday wishes are OFF — no messages will be sent.');
      } else {
        setError(result.error || 'Could not save birthday wishes.');
      }
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-[rgba(90,55,20,0.13)] bg-[#F0E6D3] p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3 border-b border-[rgba(90,55,20,0.08)] pb-4">
        <div className="rounded-xl bg-[#2B1A0E] p-2.5 text-[#F5E6CE]">
          <Cake className="h-4 w-4 text-[#B5622A]" />
        </div>
        <div className="flex-1">
          <h2 className="text-base font-bold text-[#1E1208]">Birthday Wishes</h2>
          <p className="text-[12px] text-[#9A7E65]">
            Automatic SMS greetings for members on their birthday — sent at 8:00am (Kampala time) from your SMS wallet.
          </p>
        </div>

        {/* The switch itself. Off by default: nothing sends until a pastor flips it. */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Birthday wishes on or off"
          disabled={!canEdit || !schemaAvailable}
          onClick={() => { setEnabled((current) => !current); setError(null); setSuccess(null); }}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
            enabled ? 'bg-[#B5622A]' : 'bg-[#C8B89A]'
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {!schemaAvailable ? (
        <p className="rounded-xl border border-[rgba(180,60,40,0.25)] bg-[rgba(180,60,40,0.06)] px-4 py-3 text-[12px] font-semibold text-[#8A3A2A]">
          Birthday wishes are not available until the database schema is updated (migration 025).
        </p>
      ) : (
        <>
          <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[#9A7E65]">
            Birthday message (optional)
          </label>
          <textarea
            value={template}
            onChange={(event) => { setTemplate(event.target.value); setError(null); setSuccess(null); }}
            disabled={!canEdit}
            rows={3}
            maxLength={BIRTHDAY_TEMPLATE_MAX + 40}
            placeholder={BIRTHDAY_DEFAULT_TEMPLATE}
            className="w-full rounded-xl border border-[rgba(90,55,20,0.1)] bg-white/60 px-4 py-3 text-sm font-medium text-[#1E1208] outline-none transition-colors focus:border-[#B5622A] disabled:opacity-50"
          />
          <div className="mt-1 flex items-center justify-between text-[11px] text-[#9A7E65]">
            <span>
              Use <code className="rounded bg-white/70 px-1 font-mono text-[#B5622A]">{'{name}'}</code> and{' '}
              <code className="rounded bg-white/70 px-1 font-mono text-[#B5622A]">{'{church}'}</code> — filled in automatically. Birthdays use day &amp; month only, never the year.
            </span>
            <span className={overLimit ? 'font-bold text-[#B43C28]' : undefined}>
              {template.trim().length}/{BIRTHDAY_TEMPLATE_MAX}
            </span>
          </div>

          <div className="mt-3 rounded-xl border border-[rgba(90,55,20,0.1)] bg-white/60 px-4 py-3">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[#9A7E65]">Preview</span>
            <p className="text-sm font-medium text-[#1E1208]">{preview}</p>
          </div>

          {error && (
            <p className="mt-3 rounded-xl border border-[rgba(180,60,40,0.25)] bg-[rgba(180,60,40,0.06)] px-4 py-2.5 text-[12px] font-semibold text-[#8A3A2A]">
              {error}
            </p>
          )}
          {success && (
            <p className="mt-3 rounded-xl border border-[rgba(60,130,60,0.25)] bg-[rgba(60,130,60,0.06)] px-4 py-2.5 text-[12px] font-semibold text-[#2F6B2F]">
              {success}
            </p>
          )}

          {canEdit && (
            <button
              type="button"
              onClick={save}
              disabled={isSaving || overLimit || (!hasChanges && !success)}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[#2B1A0E] px-5 py-2.5 text-[12px] font-bold uppercase tracking-widest text-[#F5E6CE] shadow-md transition-all hover:bg-[#3D2614] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : hasChanges ? <Save className="h-4 w-4" /> : <Check className="h-4 w-4" />}
              {hasChanges ? 'Save birthday wishes' : 'Saved'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
