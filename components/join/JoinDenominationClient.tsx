'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Building2, CheckCircle2, Link2, LoaderCircle } from 'lucide-react';
import { joinDenominationWithInvite } from '@/lib/denomination-actions';

/**
 * Confirmation screen behind the /join/<code> one-click link. The write goes
 * through the existing pastor-scoped server action (and the
 * `join_denomination_with_invite` RPC beneath it) — this component adds no
 * new path to the database, it only frames the same join the Settings card
 * performs, without asking for a code.
 */
export default function JoinDenominationClient({
  code,
  denominationName,
  denominationSlug,
  logoUrl,
  churchName,
  churchSlug,
}: {
  code: string;
  denominationName: string;
  denominationSlug: string;
  logoUrl: string | null;
  churchName: string;
  churchSlug: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState('');

  function join() {
    setError('');
    startTransition(async () => {
      const result = await joinDenominationWithInvite(code, churchSlug);
      if (result.error) {
        setError(result.error);
        return;
      }
      setJoined(true);
      router.refresh();
    });
  }

  if (joined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 text-slate-900">
        <section className="w-full max-w-lg rounded-3xl border border-emerald-200 bg-white p-8 shadow-sm sm:p-10">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">Welcome to the network</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">
            You&apos;re now part of {denominationName} ✅
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            {churchName} is linked. Your members, events and funds stay yours — the denomination sees shared reporting only.
          </p>
          <Link
            href={`/${churchSlug}/admin`}
            className="mt-7 inline-flex w-full items-center justify-center rounded-xl bg-emerald-700 px-5 py-3.5 text-sm font-semibold text-white hover:bg-emerald-800"
          >
            Go to my dashboard
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 text-slate-900">
      <section className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-8 shadow-sm sm:p-10">
        <div className="mb-6 flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl bg-indigo-100 text-indigo-700">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={`${denominationName} logo`} className="h-full w-full object-cover" />
          ) : (
            <Building2 className="h-6 w-6" />
          )}
        </div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-indigo-700">Church join link</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">Join {denominationName}</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          <strong>{churchName}</strong> will be linked to <strong>{denominationName}</strong>. Your church keeps full
          data isolation; the denomination overseer sees shared reporting only.
        </p>
        {error && (
          <p role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={join}
          disabled={pending}
          className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-700 px-5 py-3.5 text-sm font-semibold text-white hover:bg-indigo-800 disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
          {pending ? 'Linking your church…' : `Join ${denominationName}`}
        </button>
        <p className="mt-4 text-center text-xs leading-5 text-slate-500">
          Only the pastor can link a church. Visit{' '}
          <Link href={`/d/${denominationSlug}`} className="font-semibold text-indigo-700 hover:underline">
            {denominationName}
          </Link>{' '}
          to learn more.
        </p>
      </section>
    </main>
  );
}
