import { getDenominationBranding } from '@/lib/denomination';
import Link from 'next/link';
import Image from 'next/image';
import { Building2, Shield, Church, ArrowRight, ExternalLink, Users, Sparkles } from 'lucide-react';
import { notFound } from 'next/navigation';

export default async function DenominationLandingPage({
  params,
}: {
  params: Promise<{ denomination_slug: string }>;
}) {
  const { denomination_slug } = await params;
  const slug = denomination_slug.toLowerCase().trim();
  const branding = await getDenominationBranding(slug);

  const denomName = branding?.name || slug.toUpperCase().replace(/-/g, ' ');
  const primaryColor = branding?.primary_color || '#B5622A';

  return (
    <div 
      style={{ fontFamily: "'Outfit', sans-serif" }} 
      className="min-h-screen bg-[#E4D5BC] text-[#1E1208]"
    >
      {/* Branded Header */}
      <header className="border-b border-[rgba(90,55,20,0.1)] bg-[#F0E6D3]/90 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {branding?.logo_url ? (
              <div className="w-10 h-10 rounded-xl overflow-hidden relative border border-[rgba(90,55,20,0.15)] flex-shrink-0">
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
                className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-lg shadow-sm"
                style={{ backgroundColor: primaryColor }}
              >
                {denomName.charAt(0)}
              </div>
            )}
            <div>
              <span 
                style={{ fontFamily: "'Playfair Display', serif" }} 
                className="text-xl font-bold tracking-tight block"
              >
                {denomName}
              </span>
              <span className="text-[10px] text-[#B5622A] font-bold uppercase tracking-widest block -mt-1">
                Diocese & Network Portal
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Link 
              href={`/d/${slug}/login`} 
              className="text-xs font-bold uppercase tracking-wider text-[#6B513E] hover:text-[#B5622A] transition-colors"
            >
              Portal Login
            </Link>
            <Link 
              href={`/signup/provision?code=${slug}`} 
              className="px-4 py-2 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl text-xs font-bold uppercase tracking-wider hover:bg-[#3D2614] transition-all shadow-sm"
            >
              Register Church
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="max-w-5xl mx-auto px-6 py-16">
        <div className="bg-[#F0E6D3] rounded-3xl border border-[rgba(90,55,20,0.13)] p-8 md:p-12 shadow-sm text-center relative overflow-hidden">
          <div 
            className="w-20 h-20 rounded-2xl flex items-center justify-center text-white mx-auto mb-6 shadow-md"
            style={{ backgroundColor: primaryColor }}
          >
            <Building2 className="w-10 h-10" />
          </div>

          <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-[rgba(90,55,20,0.06)] rounded-full text-xs font-bold uppercase tracking-wider text-[#6B513E] mb-4">
            <Sparkles className="w-3.5 h-3.5 text-[#B5622A]" />
            <span>Ecclesiastical Denomination Network</span>
          </div>

          <h1 
            style={{ fontFamily: "'Playfair Display', serif" }}
            className="text-4xl md:text-5xl font-bold text-[#1E1208] max-w-2xl mx-auto leading-tight"
          >
            {denomName}
          </h1>

          {branding?.tagline && (
            <p className="text-lg text-[#B5622A] font-medium mt-3 italic">
              &ldquo;{branding.tagline}&rdquo;
            </p>
          )}

          <p className="text-sm md:text-base text-[#6B513E] max-w-xl mx-auto mt-4 leading-relaxed">
            {branding?.description || 
              `Central administration and regional oversight network for ${denomName}. Coordinated fellowship, ministry metrics, and pastoral support.`}
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mt-8">
            <Link
              href={`/d/${slug}/login`}
              className="w-full sm:w-auto px-8 py-3.5 bg-[#2B1A0E] hover:bg-[#3D2614] text-[#F5E6CE] font-bold rounded-xl text-xs uppercase tracking-wider transition-all shadow-md flex items-center justify-center gap-2"
            >
              <span>Overseer & Pastor Login</span>
              <ArrowRight className="w-4 h-4" />
            </Link>

            <Link
              href={`/signup/provision?code=${slug}`}
              className="w-full sm:w-auto px-8 py-3.5 bg-white/80 hover:bg-white text-[#1E1208] border border-[rgba(90,55,20,0.15)] font-bold rounded-xl text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2"
            >
              <Church className="w-4 h-4 text-[#B5622A]" />
              <span>Plant a Branch Church</span>
            </Link>
          </div>
        </div>

        {/* Feature Highlights */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-10">
          <div className="bg-[#F0E6D3] rounded-2xl p-6 border border-[rgba(90,55,20,0.1)]">
            <div className="p-3 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl w-fit mb-4">
              <Shield className="w-5 h-5 text-[#B5622A]" />
            </div>
            <h3 className="font-bold text-base text-[#1E1208] mb-1">Diocese Oversight</h3>
            <p className="text-xs text-[#9A7E65] leading-relaxed">
              Overseers access real-time denomination aggregates, attendance vitality, and regional growth metrics.
            </p>
          </div>

          <div className="bg-[#F0E6D3] rounded-2xl p-6 border border-[rgba(90,55,20,0.1)]">
            <div className="p-3 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl w-fit mb-4">
              <Church className="w-5 h-5 text-[#B5622A]" />
            </div>
            <h3 className="font-bold text-base text-[#1E1208] mb-1">Local Autonomy</h3>
            <p className="text-xs text-[#9A7E65] leading-relaxed">
              Each branch church manages its own members, attendance logs, and MoMo donations with complete data isolation.
            </p>
          </div>

          <div className="bg-[#F0E6D3] rounded-2xl p-6 border border-[rgba(90,55,20,0.1)]">
            <div className="p-3 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl w-fit mb-4">
              <Users className="w-5 h-5 text-[#B5622A]" />
            </div>
            <h3 className="font-bold text-base text-[#1E1208] mb-1">Seamless Onboarding</h3>
            <p className="text-xs text-[#9A7E65] leading-relaxed">
              Pastors join using secure invite codes generated directly by the denomination overseer.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
