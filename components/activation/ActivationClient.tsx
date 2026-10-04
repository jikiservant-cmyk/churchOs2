'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { 
  ShieldCheck, 
  Sparkles, 
  Smartphone, 
  CheckCircle2, 
  AlertCircle, 
  ArrowRight, 
  RotateCw,
  LogOut,
  Lock,
  Users,
  MessageSquare,
  BarChart3
} from 'lucide-react';

interface ActivationClientProps {
  churchName: string;
  churchSlug: string;
  churchId: string;
  userEmail: string;
}

export default function ActivationClient({
  churchName,
  churchSlug,
  churchId,
  userEmail
}: ActivationClientProps) {
  const router = useRouter();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [network, setNetwork] = useState<'mtn' | 'airtel'>('mtn');
  const [isLoading, setIsLoading] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [merchantRef, setMerchantRef] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Poll status endpoint while waiting for mobile money push confirmation
  useEffect(() => {
    if (!isPolling) return;

    const checkStatus = async () => {
      try {
        const res = await fetch('/api/church/activation/status', { cache: 'no-store' });
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
  }, [isPolling, churchSlug, router]);

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
          provider: 'najiki',
          network
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
      setInstructions(data.instructions || 'Please enter your Mobile Money PIN on your handset to approve the transaction.');
      setIsPolling(true);
    } catch (err: any) {
      setErrorMessage(err.message || 'Network connection failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Test Simulation Helper
  const handleSimulatePayment = async () => {
    if (!merchantRef) return;
    setIsSimulating(true);
    try {
      const res = await fetch('/api/church/activation/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchantReference: merchantRef })
      });
      const data = await res.json();
      if (data.success) {
        setIsPolling(false);
        setIsSuccess(true);
        setTimeout(() => {
          router.replace(`/${churchSlug}/admin`);
          router.refresh();
        }, 1500);
      } else {
        setErrorMessage(data.error || 'Simulation failed');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Simulation error');
    } finally {
      setIsSimulating(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Fallback
    }
    window.location.href = '/';
  };

  return (
    <div 
      style={{ fontFamily: "'Outfit', sans-serif" }}
      className="min-h-screen bg-[#2B1A0E] text-[#1E1208] relative overflow-hidden flex flex-col justify-between"
    >
      {/* Background Graphic */}
      <Image
        src="https://images.unsplash.com/photo-1438232992991-995b7058bbb3?q=80&w=2073&auto=format&fit=crop"
        alt="background"
        fill
        className="object-cover opacity-15"
        priority
        referrerPolicy="no-referrer"
      />
      <div className="absolute inset-0 bg-gradient-to-br from-[#2B1A0E]/80 via-[#2B1A0E]/60 to-[#1E1208]/90" />

      {/* Top Header Nav */}
      <header className="relative z-10 px-6 py-5 flex items-center justify-between border-b border-[rgba(240,230,211,0.08)]">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 bg-[#B5622A] rounded-xl flex items-center justify-center text-[#F0E6D3] font-bold shadow-md">
            ✝
          </div>
          <div>
            <h1 style={{ fontFamily: "'Playfair Display', serif" }} className="text-lg font-bold text-[#F0E6D3]">
              pastorOs
            </h1>
            <p className="text-[11px] text-[#C8B89A] font-medium">{churchName}</p>
          </div>
        </div>

        <button
          onClick={handleSignOut}
          className="flex items-center space-x-1.5 px-3.5 py-2 bg-[rgba(240,230,211,0.08)] hover:bg-[rgba(240,230,211,0.15)] text-[#C8B89A] hover:text-[#F0E6D3] rounded-xl text-xs font-semibold transition-all border border-[rgba(240,230,211,0.1)]"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Sign Out</span>
        </button>
      </header>

      {/* Main Content Area */}
      <main className="relative z-10 flex-1 max-w-4xl mx-auto w-full px-4 py-8 md:py-12 flex flex-col items-center justify-center">
        
        {/* Success Screen */}
        {isSuccess ? (
          <div className="bg-[#F0E6D3] rounded-3xl p-8 md:p-12 text-center shadow-2xl border border-[#B5622A]/20 max-w-lg w-full animate-in fade-in duration-500">
            <div className="w-16 h-16 bg-emerald-100 text-emerald-700 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-inner">
              <CheckCircle2 className="w-10 h-10" />
            </div>
            <h2 style={{ fontFamily: "'Playfair Display', serif" }} className="text-3xl font-bold text-[#1E1208] mb-3">
              Workspace Activated!
            </h2>
            <p className="text-sm text-[#9A7E65] mb-6 leading-relaxed">
              Your one-time fee of UGX 17,000 has been verified. Welcome to your full <strong>{churchName}</strong> pastorOs management portal.
            </p>
            <div className="flex items-center justify-center space-x-2 text-xs font-bold text-[#B5622A] uppercase tracking-widest">
              <RotateCw className="w-4 h-4 animate-spin" />
              <span>Redirecting to your dashboard...</span>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 w-full items-stretch">
            
            {/* Left Column: Value Prop & Pricing Summary */}
            <div className="lg:col-span-6 bg-[#F0E6D3] rounded-3xl p-8 shadow-xl border border-[rgba(90,55,20,0.12)] flex flex-col justify-between">
              <div>
                <div className="inline-flex items-center space-x-2 px-3 py-1 bg-[#B5622A]/10 border border-[#B5622A]/20 rounded-full text-[#B5622A] text-xs font-bold tracking-wider uppercase mb-4">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>One-Time Church Activation</span>
                </div>

                <h2 style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl md:text-3xl font-bold text-[#1E1208] mb-3">
                  Activate {churchName}
                </h2>
                
                <p className="text-sm text-[#9A7E65] leading-relaxed mb-6 font-medium">
                  Unlock the complete church operating suite for your ministry with a single, one-time activation fee.
                </p>

                {/* Features List */}
                <div className="space-y-3.5 mb-8">
                  <div className="flex items-start space-x-3">
                    <div className="p-1.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-lg mt-0.5">
                      <Users className="w-3.5 h-3.5" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-[#1E1208]">Congregation & Member Directory</h4>
                      <p className="text-[11px] text-[#9A7E65]">Unlimited member records, cell groups, and visitors.</p>
                    </div>
                  </div>

                  <div className="flex items-start space-x-3">
                    <div className="p-1.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-lg mt-0.5">
                      <BarChart3 className="w-3.5 h-3.5" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-[#1E1208]">Attendance & Service Analytics</h4>
                      <p className="text-[11px] text-[#9A7E65]">QR code roll call, headcounts, and growth reports.</p>
                    </div>
                  </div>

                  <div className="flex items-start space-x-3">
                    <div className="p-1.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-lg mt-0.5">
                      <MessageSquare className="w-3.5 h-3.5" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-[#1E1208]">Instant SMS & Pastoral Broadcasts</h4>
                      <p className="text-[11px] text-[#9A7E65]">Direct mobile messaging and prayer follow-ups.</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Price Banner */}
              <div className="p-4 bg-[rgba(181,98,42,0.08)] border border-[rgba(181,98,42,0.18)] rounded-2xl flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-bold text-[#9A7E65] uppercase tracking-wider">One-Time Lifetime Fee</p>
                  <p className="text-2xl font-extrabold text-[#B5622A]">UGX 17,000</p>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-semibold bg-[#2B1A0E] text-[#F5E6CE] px-2.5 py-1 rounded-lg">
                    Per Church
                  </span>
                </div>
              </div>
            </div>

            {/* Right Column: Mobile Money Payment Form */}
            <div className="lg:col-span-6 bg-[#F0E6D3] rounded-3xl p-8 shadow-xl border border-[rgba(90,55,20,0.12)] flex flex-col justify-between">
              
              {!isPolling ? (
                <div>
                  <h3 style={{ fontFamily: "'Playfair Display', serif" }} className="text-xl font-bold text-[#1E1208] mb-2">
                    Mobile Money Checkout
                  </h3>
                  <p className="text-xs text-[#9A7E65] mb-6">
                    Enter the MTN or Airtel mobile money number registered for payment approval.
                  </p>

                  {errorMessage && (
                    <div className="mb-5 p-3.5 bg-red-50 border border-red-200 text-red-700 rounded-xl text-xs font-medium flex items-start space-x-2">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <span>{errorMessage}</span>
                    </div>
                  )}

                  <form onSubmit={handleStartPayment} className="space-y-4">
                    {/* Network Selector */}
                    <div className="space-y-1.5">
                      <label className="block text-[10px] font-bold text-[#9A7E65] uppercase tracking-widest">
                        Select Provider
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setNetwork('mtn')}
                          className={`py-2.5 px-3 rounded-xl border text-xs font-bold transition-all flex items-center justify-center space-x-2 ${
                            network === 'mtn'
                              ? 'bg-[#FFCC00]/20 border-[#FFCC00] text-[#1E1208] shadow-sm'
                              : 'bg-white/60 border-[rgba(90,55,20,0.1)] text-[#9A7E65]'
                          }`}
                        >
                          <span className="w-2.5 h-2.5 rounded-full bg-[#FFCC00]"></span>
                          <span>MTN MoMo</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setNetwork('airtel')}
                          className={`py-2.5 px-3 rounded-xl border text-xs font-bold transition-all flex items-center justify-center space-x-2 ${
                            network === 'airtel'
                              ? 'bg-[#E60000]/15 border-[#E60000] text-[#1E1208] shadow-sm'
                              : 'bg-white/60 border-[rgba(90,55,20,0.1)] text-[#9A7E65]'
                          }`}
                        >
                          <span className="w-2.5 h-2.5 rounded-full bg-[#E60000]"></span>
                          <span>Airtel Money</span>
                        </button>
                      </div>
                    </div>

                    {/* Phone Number Input */}
                    <div className="space-y-1.5">
                      <label className="block text-[10px] font-bold text-[#9A7E65] uppercase tracking-widest">
                        Mobile Money Phone Number
                      </label>
                      <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                          <Smartphone className="w-4 h-4 text-[#9A7E65]" />
                        </div>
                        <input
                          type="tel"
                          required
                          value={phoneNumber}
                          onChange={(e) => setPhoneNumber(e.target.value)}
                          placeholder="e.g. 0771234567 or 25677..."
                          className="w-full pl-10 pr-4 py-3.5 bg-white border border-[rgba(90,55,20,0.15)] rounded-xl text-[#1E1208] placeholder:text-[#C8B89A] focus:border-[#B5622A] outline-none text-sm font-medium"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={isLoading || !phoneNumber.trim()}
                      className="w-full py-4 bg-[#2B1A0E] text-[#F5E6CE] font-bold rounded-xl shadow-lg active:scale-[0.98] transition-all hover:bg-[#3D2614] flex justify-center items-center uppercase tracking-widest text-[12px] mt-4 disabled:opacity-50"
                    >
                      {isLoading ? (
                        <div className="flex items-center space-x-2">
                          <div className="w-4 h-4 border-2 border-[rgba(245,230,206,0.3)] border-t-[#F5E6CE] rounded-full animate-spin" />
                          <span>Sending Push Request...</span>
                        </div>
                      ) : (
                        <div className="flex items-center space-x-2">
                          <span>Pay UGX 17,000 to Activate</span>
                          <ArrowRight className="w-4 h-4" />
                        </div>
                      )}
                    </button>
                  </form>
                </div>
              ) : (
                /* Polling / Waiting for Mobile Money PIN confirmation */
                <div className="text-center py-4 flex flex-col justify-between h-full">
                  <div>
                    <div className="relative w-16 h-16 mx-auto mb-5 flex items-center justify-center">
                      <div className="absolute inset-0 rounded-full bg-[#B5622A]/20 animate-ping" />
                      <div className="relative w-12 h-12 bg-[#2B1A0E] text-[#F5E6CE] rounded-full flex items-center justify-center shadow-lg">
                        <Smartphone className="w-6 h-6 animate-pulse" />
                      </div>
                    </div>

                    <h3 style={{ fontFamily: "'Playfair Display', serif" }} className="text-xl font-bold text-[#1E1208] mb-2">
                      Prompt Sent to Handset
                    </h3>

                    <p className="text-xs text-[#9A7E65] leading-relaxed mb-4">
                      {instructions || 'Please enter your Mobile Money PIN on your phone to approve UGX 17,000.'}
                    </p>

                    <div className="p-3 bg-white/70 border border-[rgba(90,55,20,0.1)] rounded-xl text-[11px] text-[#9A7E65] mb-6">
                      <span className="font-bold text-[#1E1208]">Merchant Ref:</span> {merchantRef}
                    </div>
                  </div>

                  <div className="space-y-2">
                    {/* Instant verification simulator for rapid testing */}
                    <button
                      type="button"
                      onClick={handleSimulatePayment}
                      disabled={isSimulating}
                      className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center space-x-2 shadow"
                    >
                      {isSimulating ? (
                        <RotateCw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      )}
                      <span>Simulate Mobile Money PIN Approval</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsPolling(false)}
                      className="text-xs text-[#9A7E65] hover:text-[#1E1208] font-bold underline transition-colors"
                    >
                      Change Number or Retry
                    </button>
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-[rgba(90,55,20,0.08)] text-center text-[10px] text-[#9A7E65] font-medium flex items-center justify-center space-x-1">
                <Lock className="w-3 h-3" />
                <span>Protected by 256-bit bank grade encryption & LivePay</span>
              </div>
            </div>

          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="relative z-10 py-4 text-center text-[11px] text-[#C8B89A] border-t border-[rgba(240,230,211,0.06)]">
        &copy; {new Date().getFullYear()} pastorOs &bull; Church Operating System
      </footer>
    </div>
  );
}
