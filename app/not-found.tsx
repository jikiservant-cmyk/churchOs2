import Link from 'next/link';

export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <div 
      style={{ fontFamily: "'Outfit', sans-serif" }} 
      className="min-h-screen bg-[#2B1A0E] flex items-center justify-center p-6 text-center relative overflow-hidden"
    >
      <div className="relative z-10 bg-[#F0E6D3] rounded-3xl p-10 border border-[rgba(90,55,20,0.15)] shadow-2xl max-w-md w-full">
        <div className="w-14 h-14 rounded-2xl bg-[#2B1A0E] text-[#B5622A] flex items-center justify-center mx-auto mb-5 font-bold text-xl font-mono">
          404
        </div>
        <h2 style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208] mb-2">
          Page Not Located
        </h2>
        <p className="text-xs text-[#9A7E65] leading-relaxed mb-6">
          The requested church portal, administration workspace, or page is not available. Please return to the login screen or browse the directory.
        </p>
        <div className="space-y-2.5">
          <Link 
            href="/admin/login" 
            className="w-full block py-3.5 bg-[#2B1A0E] hover:bg-[#3D2614] text-[#F5E6CE] font-bold text-xs uppercase tracking-wider rounded-xl transition-all shadow-sm"
          >
            Go to Login
          </Link>
          <Link 
            href="/denominations" 
            className="w-full block py-3 bg-white/70 hover:bg-white text-[#6B513E] font-bold text-xs uppercase tracking-wider rounded-xl transition-all border border-[rgba(90,55,20,0.08)]"
          >
            Denominations Directory
          </Link>
        </div>
      </div>
    </div>
  );
}
