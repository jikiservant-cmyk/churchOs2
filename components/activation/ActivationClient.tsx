'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  X,
  Users,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  MessageSquare,
  LockKeyhole,
  Church,
  Smartphone,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
  RefreshCw,
  ShieldCheck
} from 'lucide-react';

interface ActivationClientProps {
  churchName: string;
  churchSlug: string;
  churchId: string;
  userEmail: string;
  /**
   * The amount the server will actually charge. Passed down from the server
   * component because a client bundle cannot read `ACTIVATION_FEE_UGX`: a
   * non-`NEXT_PUBLIC_` variable is not inlined, and a second hardcoded copy of
   * the price here is what used to let the screen quote one number while the
   * ledger recorded another.
   */
  activationFeeUgx: number;
  /** The undiscounted price. Only used to label a test override honestly. */
  standardFeeUgx?: number;
  /** True while a deployment is charging a non-standard (test) fee. */
  isTestPricing?: boolean;
}

const PLAN_NAME = 'Lifetime Setup';
const PLAN_PERIOD = 'one-time';
const PLAN_TAG = 'One-time parish activation';

const features = [
  {
    icon: Users,
    title: 'Flock & Member Registry',
    description: 'Keep member records, cell groups,\nand new converts organized in one place.',
  },
  {
    icon: CalendarDays,
    title: 'Sunday Attendance & Alerts',
    description: 'Track Sunday service attendance streaks\nand automatically flag missed services.',
  },
  {
    icon: MessageSquare,
    title: 'Pastoral SMS Broadcasts',
    description: 'Send service reminders and prayer messages\ndirectly to MTN and Airtel handsets.',
  },
  {
    icon: ChartNoAxesColumnIncreasing,
    title: 'Mobile Money Tithes & Giving',
    description: 'Enable congregation members to give tithes\nand offerings securely via MoMo.',
  },
];

const money = (amount: number) =>
  `UGX ${amount.toLocaleString('en-US')}`;

export default function ActivationClient({
  churchName,
  churchSlug,
  churchId,
  userEmail,
  activationFeeUgx,
  standardFeeUgx,
  isTestPricing = false
}: ActivationClientProps) {
  const router = useRouter();
  const [selected] = useState<'standard'>('standard');
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [network, setNetwork] = useState<'mtn' | 'airtel'>('mtn');
  const [isLoading, setIsLoading] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [initiationAmbiguous, setInitiationAmbiguous] = useState(false);
  const [merchantRef, setMerchantRef] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // One price everywhere on this screen, and it is the price the server charges.
  const plan = {
    name: PLAN_NAME,
    price: activationFeeUgx,
    period: PLAN_PERIOD,
    tag: PLAN_TAG,
  };

  // Poll status endpoint while waiting for mobile money push confirmation
  useEffect(() => {
    if (!isPolling) return;

    const checkStatus = async () => {
      try {
        const res = await fetch(`/api/church/activation/status?church_slug=${encodeURIComponent(churchSlug)}&church_id=${encodeURIComponent(churchId)}`, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data.isActive || data.activationStatus === 'active') {
            setIsPolling(false);
            setIsSuccess(true);
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            setTimeout(() => {
              router.replace(`/${churchSlug}/admin`);
              router.refresh();
            }, 1800);
          } else if (
            merchantRef && data.latestPayment?.merchantReference === merchantRef &&
            ['failed', 'cancelled'].includes(String(data.latestPayment.status).toLowerCase())
          ) {
            setIsPolling(false);
            setInitiationAmbiguous(false);
            setErrorMessage('The payment was not completed. No activation was recorded; you may start a new payment.');
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          }
        }
      } catch (err) {
        console.warn('Status poll error:', err);
      }
    };

    pollIntervalRef.current = setInterval(checkStatus, 3000);
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [isPolling, churchSlug, churchId, merchantRef, router]);

  const handleStartPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setIsLoading(true);

    try {
      const res = await fetch('/api/church/activation/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber,
          network,
          plan: selected,
          churchId,
          churchSlug
        })
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setErrorMessage(data.error || 'Failed to start payment. Please check your phone number.');
        setIsLoading(false);
        return;
      }

      if (data.alreadyActive) {
        setIsSuccess(true);
        setTimeout(() => {
          router.replace(`/${churchSlug}/admin`);
          router.refresh();
        }, 1000);
        return;
      }

      setMerchantRef(data.merchantReference);
      setInitiationAmbiguous(data.status === 'pending_confirmation');
      setInstructions(data.instructions || 'Please enter your Mobile Money PIN on your handset to approve the transaction.');
      setIsPolling(true);
    } catch (err: any) {
      setErrorMessage(err.message || 'Network connection failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Check existing payment status
  const handleCheckStatus = async () => {
    setIsCheckingStatus(true);
    try {
      const res = await fetch(`/api/church/activation/status?church_slug=${encodeURIComponent(churchSlug)}&church_id=${encodeURIComponent(churchId)}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.isActive || data.activationStatus === 'active') {
          setIsSuccess(true);
          setTimeout(() => {
            router.replace(`/${churchSlug}/admin`);
            router.refresh();
          }, 1200);
          return;
        }
      }
      alert('No verified payment detected yet. Please complete the mobile money approval on your phone.');
    } catch {
      alert('Could not verify status at this moment. Please try again.');
    } finally {
      setIsCheckingStatus(false);
    }
  };

  const handleSignOutOrClose = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Fallback
    }
    router.replace('/');
  };

  return (
    <main className="min-h-screen relative flex items-center justify-center p-0 sm:p-6 font-sans overflow-x-hidden bg-[#0b0f17]/30">
      {/* Subtle blurred workspace backdrop showing pastor operating portal */}
      <div 
        aria-hidden="true" 
        className="fixed inset-0 z-0 pointer-events-none select-none opacity-45 filter blur-[10px] scale-[1.03]"
      >
        <div className="h-full w-full bg-[#f8fafc] flex">
          {/* Mock Church Sidebar */}
          <div className="hidden md:flex w-64 border-r border-slate-200/80 bg-white/90 flex-col p-6 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-slate-900 flex items-center justify-center text-white font-bold shadow-sm">
                <Church size={20} />
              </div>
              <div>
                <p className="font-bold text-slate-800 text-sm leading-tight truncate max-w-[150px]">{churchName}</p>
                <p className="text-[11px] text-slate-400 font-medium">Parish OS</p>
              </div>
            </div>
            <div className="space-y-2 pt-4">
              <div className="h-9 rounded-xl bg-slate-200/80 w-full" />
              <div className="h-9 rounded-xl bg-slate-100/60 w-full" />
              <div className="h-9 rounded-xl bg-slate-100/60 w-full" />
              <div className="h-9 rounded-xl bg-slate-100/60 w-full" />
            </div>
          </div>
          {/* Mock Dashboard Area */}
          <div className="flex-1 p-8 space-y-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200/70">
              <div className="space-y-2">
                <div className="h-7 w-48 bg-slate-300/80 rounded-lg" />
                <div className="h-4 w-72 bg-slate-200/60 rounded" />
              </div>
              <div className="h-10 w-32 bg-slate-200/80 rounded-xl" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="h-32 bg-white/80 rounded-2xl border border-slate-200/60 p-5 space-y-3">
                <div className="h-4 w-24 bg-slate-200/70 rounded" />
                <div className="h-8 w-20 bg-slate-300/80 rounded" />
              </div>
              <div className="h-32 bg-white/80 rounded-2xl border border-slate-200/60 p-5 space-y-3">
                <div className="h-4 w-24 bg-slate-200/70 rounded" />
                <div className="h-8 w-20 bg-slate-300/80 rounded" />
              </div>
              <div className="h-32 bg-white/80 rounded-2xl border border-slate-200/60 p-5 space-y-3">
                <div className="h-4 w-24 bg-slate-200/70 rounded" />
                <div className="h-8 w-20 bg-slate-300/80 rounded" />
              </div>
            </div>
            <div className="h-72 bg-white/80 rounded-2xl border border-slate-200/60 p-6 space-y-4">
              <div className="h-5 w-40 bg-slate-200/70 rounded" />
              <div className="space-y-2 pt-2">
                <div className="h-10 bg-slate-100/70 rounded-lg w-full" />
                <div className="h-10 bg-slate-100/70 rounded-lg w-full" />
                <div className="h-10 bg-slate-100/70 rounded-lg w-full" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Dark frosted transparent backdrop overlay */}
      <div 
        aria-hidden="true" 
        className="fixed inset-0 z-0 bg-neutral-950/45 backdrop-blur-md pointer-events-none" 
      />

      {/* Translucent Frosted Glass Paywall Card */}
      <section className="relative z-10 w-full max-w-[480px] min-h-screen sm:min-h-0 sm:my-8 sm:rounded-[36px] bg-white/80 sm:bg-white/75 backdrop-blur-2xl border border-white/60 px-6 sm:px-10 pt-7 pb-8 text-[#111827] shadow-[0_25px_70px_rgba(0,0,0,0.32)]">

        {/* Top navigation */}
        <header className="flex items-center justify-between">
          <button
            aria-label="Close paywall"
            className="text-gray-900 hover:opacity-50 transition p-1 cursor-pointer"
            onClick={handleSignOutOrClose}
          >
            <X size={25} strokeWidth={1.8} />
          </button>

          <button 
            onClick={handleCheckStatus}
            disabled={isCheckingStatus}
            className="text-sm font-medium text-[#718096] hover:text-black transition flex items-center gap-1.5 cursor-pointer"
          >
            {isCheckingStatus ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            <span>Check Status</span>
          </button>
        </header>

        {/* Church mark */}
        <div className="flex flex-col items-center mt-7">
          <div className="w-[104px] h-[104px] rounded-[27px] bg-gradient-to-br from-white/95 via-[#f5f6f8]/85 to-[#e6e8eb]/75 border border-white/80 shadow-[0_8px_24px_rgba(0,0,0,0.08)] backdrop-blur-sm flex items-center justify-center">
            <Church size={52} strokeWidth={1.25} className="text-[#89929e]" />
          </div>

          <p className="mt-6 text-[12px] tracking-[4px] font-semibold text-[#7b8798] uppercase">
            PARISH WORKSPACE SETUP
          </p>

          <h1 className="mt-4 text-[30px] sm:text-[34px] leading-[1.15] tracking-[-1.5px] font-semibold text-center text-[#111827]">
            Empower Your Ministry,
            <br />
            Shepherd Your Flock
          </h1>

          <p className="mt-4 text-[15px] sm:text-[16px] leading-relaxed text-center text-[#7b8798] max-w-[340px]">
            Activate <strong className="text-[#111827] font-semibold">{churchName}</strong> with tools built for Ugandan churches to track attendance, send pastoral SMS, and receive Mobile Money tithes.
          </p>
        </div>

        {/* Benefits tailored to pastorOs */}
        <div className="mt-8 space-y-5">
          {features.map(({ icon: Icon, title, description }) => (
            <div key={title} className="flex items-start gap-4">
              <div className="shrink-0 w-[52px] h-[52px] rounded-[18px] bg-white/70 border border-black/[0.05] shadow-xs backdrop-blur-sm flex items-center justify-center">
                <Icon size={25} strokeWidth={2.1} className="text-[#111827]" />
              </div>

              <div className="pt-0.5 min-w-0">
                <h2 className="text-[16px] font-semibold tracking-[-0.3px] text-[#111827]">
                  {title}
                </h2>
                <p className="mt-1 text-[14px] leading-[1.5] whitespace-pre-line text-[#788598]">
                  {description}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Pricing — single Lifetime tier */}
        <div className="mt-8">
          <div className="relative text-left rounded-[20px] border p-5 bg-[#191919]/95 border-[#191919] text-white shadow-xl">
            <div className="flex items-center justify-between gap-2 text-[13px] font-medium">
              <span>{plan.name}</span>
              <span className="w-4 h-4 rounded-full border border-white flex items-center justify-center shrink-0">
                <span className="w-2.5 h-2.5 rounded-full bg-white" />
              </span>
            </div>
            <span className="block mt-2 text-[22px] tracking-[-0.7px] font-semibold whitespace-nowrap">
              {money(plan.price)}
            </span>
            <span className="block mt-1 text-[11px] font-medium text-gray-300">
              {plan.tag}
            </span>
          </div>
          {isTestPricing && (
            <p
              role="status"
              className="mt-3 flex items-start gap-2 rounded-[14px] border border-amber-300/70 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900"
            >
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>
                Test pricing is active on this deployment: you will be charged{' '}
                {money(activationFeeUgx)} instead of the standard {money(standardFeeUgx ?? activationFeeUgx)}.
              </span>
            </p>
          )}
        </div>

        {/* Main action */}
        <button
          onClick={() => {
            setShowCheckoutModal(true);
            setErrorMessage(null);
          }}
          className="mt-6 w-full min-h-[56px] rounded-[17px] bg-[#191919] text-white text-[16px] font-medium hover:bg-black active:scale-[0.99] transition-all cursor-pointer flex items-center justify-center gap-2 shadow-xl"
        >
          <span>Continue with {plan.name}</span>
          <ArrowRight size={18} />
        </button>

        {/* Reassurance */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[12px] text-[#8490a1]">
          <span>One-time setup fee</span>
          <span>·</span>
          <span>No monthly charges</span>
          <span>·</span>
          <span className="flex items-center gap-1.5">
            <LockKeyhole size={13} />
            Secure MoMo
          </span>
        </div>

      </section>

      {/* Mobile Money Checkout Modal Sheet */}
      {showCheckoutModal && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => {
            if (!isLoading) setShowCheckoutModal(false);
          }}
        >
          <div 
            className="w-full max-w-[440px] bg-white/90 sm:bg-white/85 backdrop-blur-2xl border border-white/60 rounded-[32px] p-7 sm:p-8 shadow-2xl text-[#111827] animate-in zoom-in-95 duration-200 relative"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-4 border-b border-[#f0f2f5] mb-5">
              <div>
                <h3 className="text-xl font-semibold tracking-tight text-[#111827]">
                  Mobile Money Checkout
                </h3>
                <p className="text-xs text-[#788598] mt-0.5">
                  {plan.name} &bull; {money(plan.price)}
                </p>
              </div>
              <button 
                onClick={() => setShowCheckoutModal(false)}
                disabled={isLoading}
                className="p-1.5 text-gray-400 hover:text-black rounded-full hover:bg-gray-100 transition-colors disabled:opacity-40 cursor-pointer"
              >
                <X size={20} />
              </button>
            </div>

            {isSuccess ? (
              /* Success confirmation state */
              <div className="text-center py-6 space-y-4">
                <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto shadow-sm">
                  <CheckCircle2 size={36} />
                </div>
                <h4 className="text-2xl font-semibold text-[#111827]">
                  Workspace Activated!
                </h4>
                <p className="text-sm text-[#788598]">
                  Your parish operating dashboard for <strong>{churchName}</strong> is now open. Redirecting...
                </p>
                <div className="flex items-center justify-center gap-2 text-xs font-semibold text-[#111827] pt-2">
                  <Loader2 size={16} className="animate-spin" />
                  <span>Loading dashboard...</span>
                </div>
              </div>
            ) : isPolling ? (
              /* Polling / Handset Approval State */
              <div className="text-center py-4 space-y-5">
                <div className="relative w-16 h-16 mx-auto flex items-center justify-center">
                  <div className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping" />
                  <div className="relative w-14 h-14 bg-[#191919] text-white rounded-2xl flex items-center justify-center shadow-lg">
                    <Smartphone size={28} className="animate-pulse" />
                  </div>
                </div>

                <div>
                  <h4 className="text-lg font-semibold text-[#111827]">
                    {initiationAmbiguous ? 'Confirming Payment Request' : 'Prompt Sent to Handset'}
                  </h4>
                  <p className="text-xs text-[#788598] mt-1.5 leading-relaxed">
                    {instructions || `Please enter your Mobile Money PIN on ${phoneNumber} to complete the payment of ${money(plan.price)}.`}
                  </p>
                </div>

                {merchantRef && (
                  <div className="p-3 bg-[#f5f6f8] rounded-xl text-xs text-[#788598]">
                    Ref: <span className="font-mono text-[#111827] font-semibold">{merchantRef}</span>
                  </div>
                )}

                <div className="flex items-center justify-center gap-2 text-xs text-[#788598]">
                  <Loader2 size={14} className="animate-spin text-[#191919]" />
                  <span>{initiationAmbiguous ? 'Waiting for provider confirmation; please do not submit another payment.' : 'Waiting for PIN confirmation...'}</span>
                </div>

              </div>
            ) : (
              /* Form to start payment */
              <form onSubmit={handleStartPayment} className="space-y-4">
                {errorMessage && (
                  <div className="p-3 bg-red-50 border border-red-100 text-red-600 rounded-xl text-xs flex items-start gap-2">
                    <AlertCircle size={15} className="shrink-0 mt-0.5" />
                    <span>{errorMessage}</span>
                  </div>
                )}

                {/* Network Selection */}
                <div>
                  <label className="block text-[11px] font-medium text-[#788598] uppercase tracking-wider mb-1.5">
                    Select Network
                  </label>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setNetwork('mtn')}
                      className={`py-3 px-3 rounded-xl border text-xs font-medium transition-all flex items-center justify-center gap-2 cursor-pointer ${
                        network === 'mtn'
                          ? 'bg-[#191919] border-[#191919] text-white shadow-sm'
                          : 'bg-[#f8f9fb] border-[#e5e7eb] text-[#111827] hover:border-gray-400'
                      }`}
                    >
                      <span className="w-2.5 h-2.5 rounded-full bg-[#FFCC00]"></span>
                      <span>MTN MoMo</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setNetwork('airtel')}
                      className={`py-3 px-3 rounded-xl border text-xs font-medium transition-all flex items-center justify-center gap-2 cursor-pointer ${
                        network === 'airtel'
                          ? 'bg-[#191919] border-[#191919] text-white shadow-sm'
                          : 'bg-[#f8f9fb] border-[#e5e7eb] text-[#111827] hover:border-gray-400'
                      }`}
                    >
                      <span className="w-2.5 h-2.5 rounded-full bg-[#E60000]"></span>
                      <span>Airtel Money</span>
                    </button>
                  </div>
                </div>

                {/* Phone Number Input */}
                <div>
                  <label className="block text-[11px] font-medium text-[#788598] uppercase tracking-wider mb-1.5">
                    Mobile Money Number
                  </label>
                  <div className="relative">
                    <Smartphone size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="tel"
                      required
                      value={phoneNumber}
                      onChange={(e) => setPhoneNumber(e.target.value)}
                      placeholder="e.g. 0772 123 456 or 2567..."
                      className="w-full pl-10 pr-3.5 py-3 bg-[#f8f9fb] border border-[#e5e7eb] rounded-xl text-sm text-[#111827] focus:outline-none focus:border-black focus:bg-white transition-all font-medium"
                    />
                  </div>
                  <p className="text-[11px] text-[#788598] mt-1">
                    Enter the phone number that will approve the PIN prompt on MTN or Airtel.
                  </p>
                </div>

                {/* Submit Action */}
                <button
                  type="submit"
                  disabled={isLoading || !phoneNumber.trim()}
                  className="mt-2 w-full min-h-[50px] rounded-[15px] bg-[#191919] text-white text-[15px] font-medium hover:bg-black active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer shadow-md"
                >
                  {isLoading ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      <span>Sending PIN Prompt...</span>
                    </>
                  ) : (
                    <>
                      <span>Pay {money(plan.price)}</span>
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
