'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Building2, CheckCircle2, Link2, Loader2, ShieldCheck } from 'lucide-react';
import { joinDenominationWithInvite } from '@/lib/denomination-actions';

interface JoinDenominationCardProps {
  churchSlug: string;
  denominationName?: string | null;
  denominationSlug?: string | null;
  isLinked?: boolean;
  canJoin?: boolean;
}

export default function JoinDenominationCard({
  churchSlug,
  denominationName,
  denominationSlug,
  isLinked = false,
  canJoin = false,
}: JoinDenominationCardProps) {
  const router = useRouter();
  const [inviteCode, setInviteCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasJoined, setHasJoined] = useState(isLinked);
  const [activeDenomination, setActiveDenomination] = useState(denominationName || 'Your denomination');

  const handleJoin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = inviteCode.trim();
    if (!code || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const result = await joinDenominationWithInvite(code, churchSlug);
      if (result.error) {
        toast.error(result.error);
        return;
      }

      setActiveDenomination('Affiliated denomination');
      setHasJoined(true);
      setInviteCode('');
      toast.success(result.message || 'Your church joined the denomination network.');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not join the denomination network.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-[rgba(90,55,20,0.13)] bg-[#F0E6D3] shadow-sm">
      <div className="flex flex-col gap-5 border-b border-[rgba(90,55,20,0.08)] p-6 sm:flex-row sm:items-start sm:justify-between md:p-7">
        <div className="flex items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#2B1A0E] text-[#F5E6CE]">
            {hasJoined ? <ShieldCheck className="h-5 w-5 text-[#B5622A]" /> : <Building2 className="h-5 w-5 text-[#B5622A]" />}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-[#1E1208]">Denomination Network</h2>
              <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                hasJoined
                  ? 'border-emerald-700/15 bg-emerald-700/10 text-emerald-800'
                  : 'border-[rgba(90,55,20,0.1)] bg-white/50 text-[#9A7E65]'
              }`}>
                {hasJoined ? 'Connected' : 'Independent'}
              </span>
            </div>
            <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-[#9A7E65]">
              Connect your church to its diocese or denomination using an invitation code from an overseer.
            </p>
          </div>
        </div>
        {hasJoined && denominationSlug && (
          <span className="self-start rounded-lg bg-[rgba(181,98,42,0.08)] px-3 py-1.5 font-mono text-xs font-semibold text-[#B5622A]">
            @{denominationSlug}
          </span>
        )}
      </div>

      {hasJoined ? (
        <div className="p-6 md:p-7">
          <div className="flex items-start gap-3 rounded-xl border border-emerald-700/10 bg-emerald-700/[0.045] p-4">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
            <div>
              <p className="text-sm font-bold text-[#1E1208]">Your church is connected</p>
              <p className="mt-1 text-[13px] leading-relaxed text-[#6B513E]">
                {denominationName || activeDenomination} affiliation is active. Your denomination overseer can view the ministry reporting enabled for this network.
              </p>
            </div>
          </div>
        </div>
      ) : !canJoin ? (
        <div className="p-6 md:p-7">
          <div className="rounded-xl border border-[rgba(90,55,20,0.08)] bg-white/45 p-4 text-[13px] leading-relaxed text-[#6B513E]">
            Only this church’s pastor can link the workspace to a denomination. Ask the pastor to sign in and enter the overseer’s invite code.
          </div>
        </div>
      ) : (
        <div className="grid gap-6 p-6 md:grid-cols-[minmax(0,1fr)_minmax(250px,0.72fr)] md:p-7">
          <form onSubmit={handleJoin} className="space-y-3.5">
            <div>
              <label htmlFor="denomination-invite-code" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[#6B513E]">
                Denomination invite code
              </label>
              <input
                id="denomination-invite-code"
                name="inviteCode"
                type="text"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
                placeholder="e.g. GRACE-2026-X8"
                autoComplete="off"
                maxLength={100}
                required
                aria-describedby="denomination-invite-help"
                className="w-full rounded-xl border border-[rgba(90,55,20,0.15)] bg-white/70 px-4 py-3 text-sm font-mono uppercase text-[#1E1208] outline-none transition placeholder:font-sans placeholder:normal-case placeholder:text-[#B8A58D] focus:border-[#B5622A] focus:ring-2 focus:ring-[#B5622A]/10"
              />
              <p id="denomination-invite-help" className="mt-1.5 text-[11px] leading-relaxed text-[#9A7E65]">
                Ask your diocese or denomination overseer for a valid invitation code.
              </p>
            </div>
            <button
              type="submit"
              disabled={isSubmitting || !inviteCode.trim()}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#B5622A] px-5 py-3 text-xs font-bold uppercase tracking-wider text-white shadow-sm transition hover:bg-[#C6733B] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {isSubmitting ? 'Joining network…' : 'Join denomination'}
            </button>
          </form>

          <aside className="rounded-xl border border-[rgba(90,55,20,0.08)] bg-white/45 p-4 sm:p-5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#B5622A]">How it works</p>
            <ol className="mt-3 space-y-3 text-[12px] leading-relaxed text-[#6B513E]">
              <li className="flex gap-2.5"><span className="font-bold text-[#B5622A]">01</span><span>Receive an invite code from your denomination overseer.</span></li>
              <li className="flex gap-2.5"><span className="font-bold text-[#B5622A]">02</span><span>Submit the code to link this church workspace.</span></li>
              <li className="flex gap-2.5"><span className="font-bold text-[#B5622A]">03</span><span>Once verified, the network affiliation appears here.</span></li>
            </ol>
          </aside>
        </div>
      )}
    </section>
  );
}
