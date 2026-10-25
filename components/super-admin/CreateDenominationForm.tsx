'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Building2 } from 'lucide-react';
import {
  createDenomination,
  type CreateDenominationActionState,
} from '@/lib/super-admin-overseer-actions';

export default function CreateDenominationForm() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<CreateDenominationActionState | null, FormData>(
    createDenomination,
    null,
  );

  useEffect(() => {
    if (state?.success) router.refresh();
  }, [state?.success, router]);

  return (
    <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700">
          <Building2 className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-900">Create a denomination</h2>
          <p className="mt-1 text-sm text-slate-600">Add the denomination first; it will then be available for an overseer invitation below.</p>
        </div>
      </div>

      <form action={formAction} className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="denomination-name" className="mb-1.5 block text-sm font-semibold text-slate-800">Name</label>
          <input id="denomination-name" name="name" required minLength={2} maxLength={120} placeholder="Example: Diocese of Kampala" className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" />
        </div>
        <div>
          <label htmlFor="denomination-slug" className="mb-1.5 block text-sm font-semibold text-slate-800">URL slug</label>
          <input id="denomination-slug" name="slug" required maxLength={80} pattern="[A-Za-z0-9]+(-[A-Za-z0-9]+)*" placeholder="diocese-of-kampala" className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" />
          <p className="mt-1 text-xs text-slate-500">Lowercase letters, numbers, and hyphens; saved lowercase.</p>
        </div>
        <div>
          <label htmlFor="primary-color" className="mb-1.5 block text-sm font-semibold text-slate-800">Primary color</label>
          <input id="primary-color" name="primary_color" type="color" defaultValue="#2563eb" className="h-11 w-full rounded-xl border border-slate-300 bg-white p-1.5" />
        </div>
        <div>
          <label htmlFor="login-layout" className="mb-1.5 block text-sm font-semibold text-slate-800">Login layout</label>
          <select id="login-layout" name="login_layout" defaultValue="centered" className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100">
            <option value="centered">Centered</option>
            <option value="split">Split</option>
            <option value="fullbleed">Full bleed</option>
          </select>
        </div>
        <div>
          <label htmlFor="logo-url" className="mb-1.5 block text-sm font-semibold text-slate-800">Logo URL <span className="font-normal text-slate-500">(optional, HTTPS)</span></label>
          <input id="logo-url" name="logo_url" type="url" placeholder="https://…" className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" />
        </div>
        <div>
          <label htmlFor="background-url" className="mb-1.5 block text-sm font-semibold text-slate-800">Background URL <span className="font-normal text-slate-500">(optional, HTTPS)</span></label>
          <input id="background-url" name="background_url" type="url" placeholder="https://…" className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" />
        </div>
        <div>
          <label htmlFor="login-title" className="mb-1.5 block text-sm font-semibold text-slate-800">Login title <span className="font-normal text-slate-500">(optional)</span></label>
          <input id="login-title" name="login_title" maxLength={120} placeholder="Welcome to the network" className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" />
        </div>
        <div>
          <label htmlFor="login-tagline" className="mb-1.5 block text-sm font-semibold text-slate-800">Login tagline <span className="font-normal text-slate-500">(optional)</span></label>
          <input id="login-tagline" name="login_tagline" maxLength={240} placeholder="A short welcome message" className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" />
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700 md:col-span-2">
          <input type="checkbox" name="is_listed" defaultChecked className="h-4 w-4 rounded border-slate-300 text-indigo-700 focus:ring-indigo-500" />
          Show this denomination in the public directory
        </label>

        {state?.error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 md:col-span-2">{state.error}</p>}
        {state?.success && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 md:col-span-2">Created {state.name} ({state.slug}). Choose it in the overseer invitation form below.</p>}

        <div className="md:col-span-2">
          <button type="submit" disabled={pending} className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-wait disabled:opacity-60">
            {pending ? 'Creating denomination…' : 'Create denomination'}
          </button>
        </div>
      </form>
    </section>
  );
}
