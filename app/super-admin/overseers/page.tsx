import { notFound } from 'next/navigation';
import { ShieldCheck, UsersRound } from 'lucide-react';
import CreateDenominationForm from '@/components/super-admin/CreateDenominationForm';
import OverseerInviteForm from '@/components/super-admin/OverseerInviteForm';
import { getSuperAdminOverseerRegistrationData } from '@/lib/super-admin-overseer-actions';

export const dynamic = 'force-dynamic';

export default async function SuperAdminOverseersPage() {
  const data = await getSuperAdminOverseerRegistrationData();
  if (!data.authorized) {
    // Do not reveal whether the route exists to non-super-admin visitors.
    notFound();
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-700 text-white shadow-sm">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-indigo-700">Platform administration</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Register an overseer</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Create denominations, then issue denomination-bound overseer invitations. The recipient signs in to redeem an invite and receive their overseer link.
            </p>
          </div>
        </header>

        <CreateDenominationForm />

        {data.denominations.length === 0 ? (
          <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            <div className="flex items-center gap-2 font-semibold"><UsersRound className="h-4 w-4" /> No denominations are available</div>
            <p className="mt-2">Create a denomination first, then return here to issue its overseer invitation.</p>
          </section>
        ) : (
          <OverseerInviteForm denominations={data.denominations} />
        )}
      </div>
    </main>
  );
}
