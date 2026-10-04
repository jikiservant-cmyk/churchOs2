'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { login } from '@/lib/auth-actions';
import { DenominationBranding } from '@/lib/denomination';
import { Building2, Shield, Lock, Mail, Loader2, ArrowRight } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';

interface DenominationLoginFormProps {
  slug: string;
  branding: DenominationBranding | null;
}

export default function DenominationLoginForm({ slug, branding }: DenominationLoginFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const denomName = branding?.name || slug.toUpperCase().replace(/-/g, ' ');
  const primaryColor = branding?.primary_color || '#B5622A';

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.set('email', email);
      formData.set('password', password);
      // NOTE: intentionally no churchSlug field. Login destinations are
      // derived from the database (my_login_context / admin_profiles);
      // passing the denomination slug here used to route pastors without a
      // provisioned church to /<denomination-slug>/admin (a dead 404 URL).

      const res = await login({}, formData);

      if (res?.error) {
        setError(res.error);
      } else if (res?.success && res?.redirectTo) {
        router.push(res.redirectTo);
      }
    } catch (err: any) {
      if (err?.digest?.startsWith?.('NEXT_REDIRECT') || err?.message === 'NEXT_REDIRECT') {
        return;
      }
      setError(err?.message || 'Login failed. Please check your credentials.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div 
      style={{ fontFamily: "'Outfit', sans-serif" }}
      className="relative min-h-screen flex items-center justify-center p-4 overflow-hidden bg-[#2B1A0E]"
    >
      <div className="absolute inset-0 bg-gradient-to-br from-[#2B1A0E]/90 to-[#1E1208]/90" />

      <div className="relative z-10 w-full max-w-md bg-[#F0E6D3] border border-[rgba(90,55,20,0.15)] rounded-3xl p-8 md:p-10 shadow-2xl transition-all">
        {/* Denomination Brand Header */}
        <div className="text-center mb-8">
          {branding?.logo_url ? (
            <div className="w-16 h-16 rounded-2xl overflow-hidden relative mx-auto mb-4 border border-[rgba(90,55,20,0.15)] shadow-md">
              <Image 
                src={branding.logo_url} 
                alt={denomName} 
                fill 
                className="object-cover" 
                referrerPolicy="no-referrer"
              />
            </div>
          ) : (
            <div 
              className="w-16 h-16 rounded-2xl flex items-center justify-center text-white font-bold text-2xl mx-auto mb-4 shadow-md"
              style={{ backgroundColor: primaryColor }}
            >
              <Building2 className="w-8 h-8" />
            </div>
          )}

          <span className="text-[11px] font-bold text-[#B5622A] uppercase tracking-widest block mb-1">
            Diocese & Denomination Portal
          </span>
          <h1 
            style={{ fontFamily: "'Playfair Display', serif" }} 
            className="text-2xl md:text-3xl font-bold text-[#1E1208]"
          >
            {denomName}
          </h1>
          <p className="text-xs text-[#9A7E65] mt-1">
            Sign in as an Overseer, Bishop, or Church Pastor
          </p>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-[#B5622A]/10 border border-[#B5622A]/20 rounded-xl text-[#B5622A] text-xs font-bold leading-relaxed">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-bold text-[#6B513E] uppercase tracking-wider mb-1.5">
              Email Address
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-[#9A7E65] absolute left-4 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="pastor@church.org"
                className="w-full pl-11 pr-4 py-3.5 bg-white/70 border border-[rgba(90,55,20,0.15)] rounded-xl text-[#1E1208] text-sm focus:border-[#B5622A] outline-none font-medium"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-[#6B513E] uppercase tracking-wider mb-1.5">
              Password
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-[#9A7E65] absolute left-4 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-11 pr-4 py-3.5 bg-white/70 border border-[rgba(90,55,20,0.15)] rounded-xl text-[#1E1208] text-sm focus:border-[#B5622A] outline-none font-medium"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-4 bg-[#2B1A0E] hover:bg-[#3D2614] text-[#F5E6CE] font-bold rounded-xl shadow-md uppercase tracking-wider text-xs transition-all flex items-center justify-center gap-2 mt-4 disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Signing In...</span>
              </>
            ) : (
              <>
                <span>Sign In to Portal</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-[rgba(90,55,20,0.08)] flex items-center justify-between text-xs text-[#9A7E65]">
          <Link href={`/d/${slug}`} className="hover:text-[#1E1208] hover:underline">
            ← Denomination Home
          </Link>
          <Link href={`/signup/provision?code=${slug}`} className="text-[#B5622A] font-bold hover:underline">
            Register Church
          </Link>
        </div>
      </div>
    </div>
  );
}
