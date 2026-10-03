'use client';

import { useState } from 'react';
import { joinDenominationWithInvite } from '@/lib/denomination-actions';
import { Building2, CheckCircle2, ShieldCheck, ArrowRight, Loader2, Link2 } from 'lucide-react';
import { toast } from 'sonner';

interface JoinDenominationCardProps {
  churchSlug: string;
  churchId: string;
  denominationName?: string | null;
  denominationSlug?: string | null;
  isLinked?: boolean;
}

export default function JoinDenominationCard({
  churchSlug,
  denominationName,
  denominationSlug,
  isLinked = false,
}: JoinDenominationCardProps) {
  const [inviteCode, setInviteCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [linkedSuccess, setLinkedSuccess] = useState(isLinked);
  const [activeDenomName, setActiveDenomName] = useState(denominationName || '');

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = inviteCode.trim();
    if (!code) {
      toast.error('Please enter an invite code');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await joinDenominationWithInvite(code, churchSlug);
      if (res.error) {
        toast.error(res.error);
      } else {
        toast.success(res.message || 'Successfully linked to denomination!');
        setLinkedSuccess(true);
        setActiveDenomName('Affiliated Denomination');
        setInviteCode('');
        window.location.reload();
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to join denomination');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (linkedSuccess) {
    return (
      <div className="bg-[#F0E6D3] rounded-2xl border border-[rgba(90,55,20,0.13)] p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl">
              <ShieldCheck className="w-5 h-5 text-[#B5622A]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-[#1E1208]">Denomination Network</h3>
                <span className="px-2.5 py-0.5 bg-emerald-500/10 text-emerald-700 text-[10px] font-bold uppercase tracking-wider rounded-full border border-emerald-500/20">
                  Affiliated
                </span>
              </div>
              <p className="text-xs text-[#9A7E65] mt-0.5">
                {activeDenomName ? `Member of ${activeDenomName}` : 'Your church is connected to a parent denomination.'}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-[rgba(90,55,20,0.08)] bg-white/40 rounded-xl p-4 flex items-center justify-between text-xs text-[#6B513E]">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span>High-level attendance and ministry progress shared with your overseer.</span>
          </div>
          {denominationSlug && (
            <span className="font-mono text-[11px] text-[#B5622A] bg-[rgba(181,98,42,0.08)] px-2 py-1 rounded">
              @{denominationSlug}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#F0E6D3] rounded-2xl border border-[rgba(90,55,20,0.13)] p-6 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl">
            <Building2 className="w-5 h-5 text-[#B5622A]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-[#1E1208]">Denomination Affiliation</h3>
              <span className="px-2.5 py-0.5 bg-[rgba(90,55,20,0.08)] text-[#9A7E65] text-[10px] font-bold uppercase tracking-wider rounded-full">
                Independent
              </span>
            </div>
            <p className="text-xs text-[#9A7E65] mt-0.5">
              Connect to your diocese or denomination network to enable overseer reporting.
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={handleJoin} className="mt-5 space-y-4">
        <div>
          <label className="block text-[11px] font-bold text-[#6B513E] uppercase tracking-wider mb-1.5">
            Pastor Invite Code
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                placeholder="e.g. GRACE-2026-X8"
                className="w-full px-4 py-3 bg-white/70 border border-[rgba(90,55,20,0.15)] rounded-xl text-[#1E1208] placeholder:text-[#C8B89A] focus:border-[#B5622A] outline-none font-mono text-sm uppercase"
              />
            </div>
            <button
              type="submit"
              disabled={isSubmitting || !inviteCode.trim()}
              className="px-5 py-3 bg-[#2B1A0E] hover:bg-[#3D2614] text-[#F5E6CE] rounded-xl font-bold text-xs uppercase tracking-wider transition-all disabled:opacity-50 flex items-center gap-2 shadow-sm"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Joining...
                </>
              ) : (
                <>
                  <Link2 className="w-4 h-4" />
                  Join Network
                </>
              )}
            </button>
          </div>
          <p className="text-[11px] text-[#9A7E65] mt-1.5">
            Your overseer or diocese administrator can generate an invite code from their Overseer Portal.
          </p>
        </div>
      </form>
    </div>
  );
}
