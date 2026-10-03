import { getPublicDenominations } from '@/lib/denomination';
import Link from 'next/link';
import Image from 'next/image';
import { Building2, Search, ArrowRight, Shield, Church, ExternalLink } from 'lucide-react';

export default async function DenominationsDirectoryPage() {
  const denominations = await getPublicDenominations();

  return (
    <div 
      style={{ fontFamily: "'Outfit', sans-serif" }} 
      className="min-h-screen bg-[#E4D5BC] text-[#1E1208]"
    >
      {/* Navigation Header */}
      <header className="border-b border-[rgba(90,55,20,0.1)] bg-[#F0E6D3]/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#2B1A0E] text-[#F5E6CE] flex items-center justify-center font-bold text-lg shadow-sm">
              †
            </div>
            <div>
              <span style={{ fontFamily: "'Playfair Display', serif" }} className="text-xl font-bold tracking-tight block">
                pastorOs
              </span>
              <span className="text-[10px] text-[#B5622A] font-bold uppercase tracking-widest block -mt-1">
                Denomination Directory
              </span>
            </div>
          </Link>

          <div className="flex items-center gap-4">
            <Link 
              href="/admin/login" 
              className="text-xs font-bold uppercase tracking-wider text-[#6B513E] hover:text-[#B5622A] transition-colors"
            >
              Sign In
            </Link>
            <Link 
              href="/signup" 
              className="px-4 py-2 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl text-xs font-bold uppercase tracking-wider hover:bg-[#3D2614] transition-all shadow-sm"
            >
              Launch Church
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Banner */}
      <section className="max-w-6xl mx-auto px-6 pt-16 pb-12 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#2B1A0E]/5 border border-[rgba(90,55,20,0.15)] rounded-full text-[11px] font-bold text-[#B5622A] uppercase tracking-wider mb-4">
          <Building2 className="w-3.5 h-3.5" />
          <span>Ecclesiastical Networks & Dioceses</span>
        </div>
        <h1 
          style={{ fontFamily: "'Playfair Display', serif" }}
          className="text-4xl md:text-5xl font-bold text-[#1E1208] max-w-3xl mx-auto tracking-tight leading-tight"
        >
          Denominations & Diocesan Networks
        </h1>
        <p className="text-base text-[#6B513E] max-w-2xl mx-auto mt-4 leading-relaxed">
          Find your diocesan or denominational fellowship network to access overseer oversight, regional reports, and pastor fellowship.
        </p>

        {/* Unlisted Denomination Quick Finder */}
        <div className="max-w-md mx-auto mt-8 bg-[#F0E6D3] p-3 rounded-2xl border border-[rgba(90,55,20,0.12)] shadow-sm">
          <form action="/d" method="GET" className="flex gap-2">
            <input 
              type="text" 
              name="slug"
              placeholder="Enter diocese or denomination slug..." 
              className="flex-1 px-4 py-2.5 bg-white/70 border border-[rgba(90,55,20,0.1)] rounded-xl text-xs font-mono text-[#1E1208] focus:border-[#B5622A] outline-none"
            />
            <button 
              type="submit"
              className="px-4 py-2.5 bg-[#B5622A] text-white rounded-xl text-xs font-bold uppercase tracking-wider hover:bg-[#C6733B] transition-colors flex items-center gap-1.5"
            >
              <span>Find</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>
      </section>

      {/* Directory Grid */}
      <main className="max-w-6xl mx-auto px-6 pb-24">
        {denominations.length === 0 ? (
          <div className="bg-[#F0E6D3] rounded-3xl p-12 text-center border border-[rgba(90,55,20,0.12)] shadow-sm max-w-2xl mx-auto">
            <div className="w-16 h-16 rounded-2xl bg-[#2B1A0E] text-[#F5E6CE] flex items-center justify-center mx-auto mb-5 shadow-sm">
              <Building2 className="w-8 h-8 text-[#B5622A]" />
            </div>
            <h2 style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208] mb-2">
              Public Directory
            </h2>
            <p className="text-sm text-[#9A7E65] leading-relaxed max-w-lg mx-auto mb-6">
              Public denomination listings will appear here once registered by your platform administrator. If your denomination is unlisted, you can still access its portal directly using your diocese slug or invite code.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/signup"
                className="px-6 py-3 bg-[#2B1A0E] hover:bg-[#3D2614] text-[#F5E6CE] rounded-xl text-xs font-bold uppercase tracking-wider transition-all"
              >
                Register a Church
              </Link>
              <Link
                href="/admin/login"
                className="px-6 py-3 bg-white/80 hover:bg-white text-[#1E1208] border border-[rgba(90,55,20,0.12)] rounded-xl text-xs font-bold uppercase tracking-wider transition-all"
              >
                Overseer / Pastor Login
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {denominations.map((denom) => (
              <div 
                key={denom.slug}
                className="bg-[#F0E6D3] rounded-2xl p-6 border border-[rgba(90,55,20,0.12)] hover:border-[#B5622A]/40 transition-all hover:shadow-md flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center gap-3 mb-4">
                    {denom.logo_url ? (
                      <div className="w-12 h-12 rounded-xl overflow-hidden relative border border-[rgba(90,55,20,0.1)] flex-shrink-0">
                        <Image 
                          src={denom.logo_url} 
                          alt={denom.name} 
                          fill 
                          className="object-cover" 
                          referrerPolicy="no-referrer"
                        />
                      </div>
                    ) : (
                      <div 
                        className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg shadow-xs"
                        style={{ backgroundColor: denom.primary_color || '#B5622A' }}
                      >
                        {denom.name.charAt(0)}
                      </div>
                    )}
                    <div>
                      <h3 className="font-bold text-base text-[#1E1208]">{denom.name}</h3>
                      <span className="text-xs font-mono text-[#9A7E65]">/d/{denom.slug}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-[rgba(90,55,20,0.08)] flex items-center justify-between">
                  <Link 
                    href={`/d/${denom.slug}`}
                    className="text-xs font-bold text-[#B5622A] hover:underline flex items-center gap-1"
                  >
                    <span>View Network</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>

                  <Link 
                    href={`/d/${denom.slug}/login`}
                    className="text-xs font-bold text-[#6B513E] hover:text-[#1E1208]"
                  >
                    Portal Login
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
