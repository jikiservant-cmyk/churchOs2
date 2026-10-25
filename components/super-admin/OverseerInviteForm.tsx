'use client';

import { useActionState, useEffect, useState } from 'react';
import { Copy, Link2, ShieldCheck } from 'lucide-react';
import {
  createDenominationOverseerInvite,
  type CreateInviteActionState,
  type SuperAdminDenominationOption,
} from '@/lib/super-admin-overseer-actions';

export default function OverseerInviteForm({
  denominations,
}: {
  denominations: SuperAdminDenominationOption[];
}) {
  const [state, formAction, pending] = useActionState<CreateInviteActionState | null, FormData>(
    createDenominationOverseerInvite,
    null,
  );
  const [inviteUrl, setInviteUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (state?.code) {
      setInviteUrl(`${window.location.origin}/overseer/invite/${encodeURIComponent(state.code)}`);
      setCopied(false);
    }
  }, [state?.code]);

  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
      <form action={formAction} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <label htmlFor="denomination_id" className="mb-2 block text-sm font-semibold text-slate-800">Denomination</label>
          <select
            id="denomination_id"
            name="denomination_id"
            required
            defaultValue=""
            disabled={!denominations.length || pending}
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100"
          >
            <option value="" disabled>Select a denomination</option>
            {denominations.map((denomination) => (
              <option value={denomination.id} key={denomination.id}>
                {denomination.name} ({denomination.slug})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="label" className="mb-2 block text-sm font-semibold text-slate-800">Internal label <span className="font-normal text-slate-500">(optional)</span></label>
          <input
            id="label"
            name="label"
            maxLength={120}
            placeholder="Example: Diocese leadership invitation"
            disabled={pending}
            className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="expires_in_days" className="mb-2 block text-sm font-semibold text-slate-800">Expires after</label>
            <div className="flex items-center gap-2">
              <input
                id="expires_in_days"
                name="expires_in_days"
                type="number"
                min={1}
                max={90}
                required
                defaultValue={14}
                disabled={pending}
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              />
              <span className="text-sm text-slate-500">days</span>
            </div>
          </div>
          <div>
            <label htmlFor="max_uses" className="mb-2 block text-sm font-semibold text-slate-800">Allowed uses</label>
            <input
              id="max_uses"
              name="max_uses"
              type="number"
              min={1}
              max={1000}
              required
              defaultValue={1}
              disabled={pending}
              className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </div>
        </div>

        {state?.error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{state.error}</p>}

        <button
          type="submit"
          disabled={!denominations.length || pending}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-700 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Link2 className="h-4 w-4" />
          {pending ? 'Creating invitation…' : 'Create overseer invitation'}
        </button>
      </form>

      <aside className="rounded-2xl border border-indigo-100 bg-indigo-50/70 p-6">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-white text-indigo-700 shadow-sm">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <h2 className="text-lg font-bold text-slate-900">How this invite works</h2>
        <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
          <li>• It is bound to one denomination; the invitee cannot choose a different one.</li>
          <li>• Only a SHA-256 hash is stored. The raw link is shown once after creation.</li>
          <li>• The signed-in invitee redeems it to create their overseer link.</li>
          <li>• A user can be linked to only one denomination because `user_id` is the primary key.</li>
        </ul>
      </aside>

      {state?.success && state.code && (
        <div className="lg:col-span-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-6" role="status">
          <h2 className="font-bold text-emerald-900">Invitation created</h2>
          <p className="mt-1 text-sm text-emerald-800">
            Share this link with the invitee. It expires {state.expiresAt ? new Date(state.expiresAt).toLocaleString() : 'as configured'} and allows {state.maxUses} redemption{state.maxUses === 1 ? '' : 's'}. The raw code will not be shown again.
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              readOnly
              aria-label="New overseer invitation link"
              value={inviteUrl}
              className="min-w-0 flex-1 rounded-xl border border-emerald-200 bg-white px-4 py-3 text-sm text-slate-800"
            />
            <button
              type="button"
              onClick={copyInvite}
              disabled={!inviteUrl}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-800 px-5 py-3 text-sm font-semibold text-white hover:bg-emerald-900 disabled:opacity-50"
            >
              <Copy className="h-4 w-4" />
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
