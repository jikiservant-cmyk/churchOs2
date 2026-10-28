'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { X, Smartphone, CreditCard, Loader2, CheckCircle2, AlertCircle, RefreshCw, Clock3 } from 'lucide-react';
import { initiateNajikiPayment } from '@/lib/wallet-actions';
import { SMS_TOPUP_MAX_UGX, SMS_TOPUP_MIN_UGX } from '@/lib/money';
import { toast } from 'sonner';

interface TopUpModalProps {
  churchId: string;
  isOpen: boolean;
  onClose: () => void;
}

type PollState = 'idle' | 'polling' | 'credited' | 'failed';

export default function TopUpModal({ churchId, isOpen, onClose }: TopUpModalProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [pollState, setPollState] = useState<PollState>('idle');
  const [pendingConfirmationMessage, setPendingConfirmationMessage] = useState<string | null>(null);
  const [amount, setAmount] = useState('5000');
  const [customAmount, setCustomAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [reference, setReference] = useState<string | null>(null);
  const [najikiReference, setNajikiReference] = useState<string | null>(null);
  const [creditedAmount, setCreditedAmount] = useState<number | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const attemptRef = useRef(0);

  // Reset on open
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
      // reset only when newly opened, not while polling
      setIsSuccess(false);
      setPollState('idle');
      setPendingConfirmationMessage(null);
      setReference(null);
      setNajikiReference(null);
      setCreditedAmount(null);
      attemptRef.current = 0;
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  // Cleanup poll on unmount / close
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);
  useEffect(() => {
    if (!isOpen && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [isOpen]);

  // Poll wallet status every 3s after initiation, like ActivationClient does
  useEffect(() => {
    if (pollState !== 'polling' || !reference) return;

    const checkWallet = async () => {
      attemptRef.current += 1;
      try {
        const params = new URLSearchParams({ church_id: churchId, reference });
        if (najikiReference) params.set('najikiReference', najikiReference);
        const res = await fetch(`/api/church/wallet/status?${params.toString()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const tx = data.transaction;
        if (!tx) return;

        const status = String(tx.status || '').toLowerCase();
        if (status === 'success' || status === 'credited') {
          setPollState('credited');
          setCreditedAmount(tx.amount ?? null);
          toast.success(`Wallet credited: UGX ${Number(tx.amount).toLocaleString()}`);
          if (pollRef.current) clearInterval(pollRef.current);
          // Refresh server component that shows balance
          router.refresh();
          // Also give Next a moment to revalidate, then show confirmed state stays
          setTimeout(() => router.refresh(), 1200);
        } else if (['failed', 'cancelled', 'canceled', 'expired'].includes(status)) {
          setPollState('failed');
          setPendingConfirmationMessage(tx.note || 'Payment was not completed. You were not charged.');
          if (pollRef.current) clearInterval(pollRef.current);
        } else if (attemptRef.current > 40) {
          // ~2 minutes of polling with no terminal state — keep polling but inform user
          // We don't stop polling; Najiki webhooks can take up to a few minutes with retries
        }
      } catch (err) {
        console.warn('[TopUp] poll error', err);
      }
    };

    // immediate first check after short delay, then interval
    const t = setTimeout(checkWallet, 1500);
    pollRef.current = setInterval(checkWallet, 3000);
    return () => {
      clearTimeout(t);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pollState, reference, najikiReference, churchId, router]);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const rawAmount = customAmount || amount;
    const finalAmount = Number(rawAmount);

    if (
      !/^\d+$/.test(rawAmount) ||
      !Number.isSafeInteger(finalAmount) ||
      finalAmount < SMS_TOPUP_MIN_UGX ||
      finalAmount > SMS_TOPUP_MAX_UGX
    ) {
      toast.error(
        `Please enter a whole amount between ${SMS_TOPUP_MIN_UGX.toLocaleString()} and ${SMS_TOPUP_MAX_UGX.toLocaleString()} UGX`,
      );
      return;
    }

    if (!phone || phone.length < 10) {
      toast.error('Please enter a valid phone number');
      return;
    }

    setIsSubmitting(true);

    // surface server error inline + toast with full Najiki detail
    // keep previous inline error visible
    const setInlineError = (m: string) => {
      setPendingConfirmationMessage(m);
      setPollState('idle');
    };
    try {
      const formData = new FormData(e.currentTarget);
      formData.set('amount', finalAmount.toString());

      const result = await initiateNajikiPayment(formData);
      if (result?.success) {
        const isPendingConfirmation = result.status === 'pending_confirmation';
        setPendingConfirmationMessage(isPendingConfirmation ? (result.message ?? 'We are confirming whether the payment prompt was received. Check your phone PIN prompt.') : null);
        setReference(result.reference || null);
        setNajikiReference(result.najikiReference || result.paymentId || null);
        setIsSuccess(true);
        setPollState('polling');
        attemptRef.current = 0;
        toast.success(result.message || 'Payment prompt sent! Check your phone.');
        // Don't close — show polling state
      } else {
        const errMsg = result?.error || 'Failed to initiate payment';
        console.error('[TopUp] initiate failed:', errMsg);
        // show inline so user sees it after modal stays open
        setInlineError(errMsg);
        toast.error(errMsg, { duration: 6000 });
      }
    } catch (err: any) {
      const errMsg = err?.message || 'An unexpected error occurred';
      console.error('[TopUp] unexpected:', err);
      setInlineError(errMsg);
      toast.error(errMsg, { duration: 6000 });
    } finally {
      setIsSubmitting(false);
    }
  }

  const finalAmountForDisplay = customAmount ? Number(customAmount) : Number(amount);
  const amountLabel = Number.isFinite(finalAmountForDisplay) ? finalAmountForDisplay.toLocaleString() : amount;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200 cursor-pointer"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[#F0E6D3] rounded-[2rem] shadow-2xl border border-[rgba(90,55,20,0.13)] overflow-hidden animate-in zoom-in-95 duration-200 cursor-default"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="relative pt-8 pb-6 px-8 text-center border-b border-[rgba(90,55,20,0.05)]">
          <button
            onClick={onClose}
            className="absolute top-6 right-6 p-2 text-[#9A7E65] hover:text-[#1E1208] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="w-16 h-16 bg-[#B5622A]/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
            {pollState === 'credited' ? (
              <CheckCircle2 className="w-8 h-8 text-green-600" />
            ) : pollState === 'failed' ? (
              <AlertCircle className="w-8 h-8 text-red-600" />
            ) : isSuccess ? (
              <Smartphone className="w-8 h-8 text-[#B5622A] animate-pulse" />
            ) : (
              <CreditCard className="w-8 h-8 text-[#B5622A]" />
            )}
          </div>

          <h2 style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208]">
            {pollState === 'credited' ? 'Wallet Credited!' : pollState === 'failed' ? 'Payment Not Completed' : isSuccess ? 'Prompt Sent!' : 'Wallet Top Up'}
          </h2>
          <p className="text-[13px] text-[#9A7E65] mt-1 font-medium">
            {pollState === 'credited'
              ? `UGX ${Number(creditedAmount ?? finalAmountForDisplay).toLocaleString()} added to SMS wallet`
              : pollState === 'failed'
              ? 'No funds were deducted — you can try again'
              : isSuccess
              ? 'Waiting for Mobile Money confirmation'
              : 'Add SMS credits via Najiki Mobile Money'}
          </p>
        </div>

        {/* Form or Success / Polling State */}
        {isSuccess ? (
          <div className="p-8 text-center space-y-5 animate-in zoom-in-95 duration-300">
            {pollState === 'credited' ? (
              <>
                <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                  <CheckCircle2 className="w-10 h-10 text-green-600" />
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-[#1E1208] font-semibold">Your SMS balance has been updated.</p>
                  <p className="text-[12px] text-[#9A7E65]">Close and check the SMS Balance card — it refreshes automatically.</p>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => { router.refresh(); onClose(); }}
                    className="flex-1 py-4 bg-[#2B1A0E] text-[#F5E6CE] rounded-2xl font-bold text-[13px] uppercase tracking-widest hover:bg-[#3D2614] transition-all shadow-lg"
                  >
                    Done — View Balance
                  </button>
                </div>
              </>
            ) : pollState === 'failed' ? (
              <>
                <div className="w-20 h-20 bg-red-50 rounded-full flex items-center justify-center mx-auto">
                  <AlertCircle className="w-10 h-10 text-red-600" />
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-[#1E1208] font-semibold">Payment did not complete</p>
                  <p className="text-[12px] text-[#9A7E65] leading-relaxed">
                    {pendingConfirmationMessage || 'No charges were made. Please check your phone and try a new payment.'}
                  </p>
                  {reference && (
                    <p className="text-[11px] font-mono text-[#9A7E65] bg-white/60 rounded-lg py-1.5 px-2">Ref: {reference}</p>
                  )}
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => { setIsSuccess(false); setPollState('idle'); setPendingConfirmationMessage(null); }}
                    className="flex-1 py-3 bg-[#2B1A0E] text-[#F5E6CE] rounded-2xl font-bold text-[12px] uppercase tracking-widest"
                  >
                    Try Again
                  </button>
                  <button
                    onClick={onClose}
                    className="flex-1 py-3 bg-white/70 text-[#1E1208] border border-[#E9E1D2] rounded-2xl font-bold text-[12px] uppercase tracking-widest"
                  >
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="w-20 h-20 bg-amber-50 rounded-full flex items-center justify-center mx-auto mb-2 relative">
                  <Clock3 className="w-8 h-8 text-[#B5622A]" />
                  <span className="absolute -top-1 -right-1 w-6 h-6 bg-white rounded-full border border-[#E9E1D2] flex items-center justify-center">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[#B5622A]" />
                  </span>
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-[#1E1208] font-semibold leading-relaxed">
                    {pendingConfirmationMessage || (
                      <>Please check your phone (<strong>{phone}</strong>) and enter your Mobile Money PIN to complete the payment of <strong>UGX {amountLabel}</strong>.</>
                    )}
                  </p>
                  <div className="flex items-center justify-center gap-2 text-[12px] text-[#9A7E65] font-medium">
                    <Loader2 className="w-4 h-4 animate-spin text-[#B5622A]" />
                    <span>Waiting for PIN approval — leave this open, it updates automatically</span>
                  </div>
                  {reference && (
                    <p className="text-[11px] font-mono text-[#9A7E65] bg-white/60 rounded-lg py-1.5 px-2 inline-block">Ref: {reference}</p>
                  )}
                </div>

                <div className="flex flex-col gap-3">
                  <button
                    onClick={async () => {
                      try {
                        const params = new URLSearchParams({ church_id: churchId, reference: reference || '' });
                        const res = await fetch(`/api/church/wallet/status?${params.toString()}`, { cache: 'no-store' });
                        if (res.ok) {
                          router.refresh();
                          toast.success('Checking again…');
                        }
                      } catch {}
                    }}
                    className="w-full py-3.5 bg-white/70 text-[#1E1208] border border-[#E9E1D2] rounded-2xl font-bold text-[12px] uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-white"
                  >
                    <RefreshCw className="w-4 h-4" /> Refresh Status
                  </button>
                  <button
                    onClick={() => { if (pollRef.current) clearInterval(pollRef.current); onClose(); }}
                    className="w-full py-3 text-[#9A7E65] hover:text-[#1E1208] text-[11px] font-bold uppercase tracking-widest"
                  >
                    Keep Checking in Background
                  </button>
                  <p className="text-[11px] text-[#9A7E65] italic">
                    Your balance on the Messages page will update automatically once the webhook confirms.
                  </p>
                </div>
              </>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-8 space-y-6">
            <input type="hidden" name="churchId" value={churchId} />

            <div className="space-y-4">
              {/* Phone Number */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-[#C8B89A] uppercase tracking-widest ml-1">
                  Mobile Money Number
                </label>
                <div className="relative">
                  <Smartphone className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9A7E65]" />
                  <input
                    type="text"
                    name="phoneNumber"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="07... or 2567..."
                    className="w-full pl-11 pr-4 py-3.5 bg-white/50 border border-[#E9E1D2] rounded-2xl text-sm text-[#1E1208] placeholder:text-[#9A7E65]/50 focus:outline-none focus:border-[#B5622A] focus:ring-1 focus:ring-[#B5622A] transition-all"
                    required
                  />
                </div>
                <p className="text-[10px] text-[#9A7E65] ml-1">MTN or Airtel — the PIN prompt goes to this number.</p>
              </div>

              {/* Amount Selection */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-[#C8B89A] uppercase tracking-widest ml-1">
                  Select or Enter Amount (Min {SMS_TOPUP_MIN_UGX.toLocaleString()} UGX)
                </label>
                <div className="grid grid-cols-2 gap-3">
                  {['5000', '10000', '20000', '50000'].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => {
                        setAmount(amt);
                        setCustomAmount('');
                      }}
                      className={`py-3 px-4 rounded-xl text-sm font-bold transition-all border ${
                        amount === amt && !customAmount
                          ? 'bg-[#B5622A] text-white border-[#B5622A] shadow-md'
                          : 'bg-white/50 text-[#1E1208] border-[#E9E1D2] hover:border-[#B5622A]/30'
                      }`}
                    >
                      {parseInt(amt).toLocaleString()}
                    </button>
                  ))}
                </div>

                {/* Custom Amount Input */}
                <div className="mt-3 relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-[12px] font-bold text-[#9A7E65]">UGX</div>
                  <input
                    type="number"
                    placeholder="Enter custom amount (e.g. 2500)"
                    value={customAmount}
                    onChange={(e) => {
                      setCustomAmount(e.target.value);
                      setAmount(''); // Deselect buttons when typing
                    }}
                    className="w-full pl-14 pr-4 py-3.5 bg-white/50 border border-[#E9E1D2] rounded-2xl text-sm text-[#1E1208] placeholder:text-[#9A7E65]/50 focus:outline-none focus:border-[#B5622A] focus:ring-1 focus:ring-[#B5622A] transition-all"
                  />
                </div>
                <input type="hidden" name="amount" value={customAmount || amount} />
                {pendingConfirmationMessage && pollState === 'idle' && (
                  <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-xl flex gap-2">
                    <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                    <p className="text-[12px] text-red-700 leading-snug break-words">{pendingConfirmationMessage}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col gap-3">
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-4 bg-[#2B1A0E] text-[#F5E6CE] rounded-2xl font-bold text-[13px] uppercase tracking-widest hover:bg-[#3D2614] transition-all shadow-lg shadow-[#2B1A0E]/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Initiating...
                  </>
                ) : (
                  <>
                    Confirm & Pay
                    <CheckCircle2 className="w-4 h-4" />
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="w-full py-3 text-[#9A7E65] hover:text-[#1E1208] text-[11px] font-bold uppercase tracking-widest transition-colors"
              >
                Cancel
              </button>
            </div>

            <div className="flex items-center gap-2 justify-center py-2">
              <AlertCircle className="w-3.5 h-3.5 text-[#9A7E65]" />
              <p className="text-[11px] text-[#9A7E65] font-medium">
                You will receive a PIN prompt on your phone.
              </p>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
