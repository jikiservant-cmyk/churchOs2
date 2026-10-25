'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, LoaderCircle, ShieldCheck } from 'lucide-react';
import { redeemDenominationOverseerInvite } from '@/lib/super-admin-overseer-actions';

export default function OverseerInviteRedeem({ code }: { code: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');

  function redeem() {
    setError('');
    startTransition(async () => {
      const result = await redeemDenominationOverseerInvite(code);
      if (result.success) {
        router.replace('/overseer');
        router.refresh();
      } else {
        setError(result.error || 'Could not redeem this invitation.');
      }
    });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 text-slate-900">
      <section className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-8 shadow-sm sm:p-10">
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-700 text-white">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-indigo-700">Overseer invitation</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">Accept denomination access</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          This invitation is bound to a specific denomination and will link your signed-in account as its overseer. An account can be linked to only one denomination.
        </p>
        {error && <p role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
        <button
          type="button"
          onClick={redeem}
          disabled={pending}
          className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-700 px-5 py-3.5 text-sm font-semibold text-white hover:bg-indigo-800 disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {pending ? 'Validating invitation…' : 'Accept invitation'}
        </button>
        <p className="mt-4 text-center text-xs leading-5 text-slate-500">Invitation codes are single-purpose bearer links. Only accept one intended for you.</p>
      </section>
    </main>
  );
}
