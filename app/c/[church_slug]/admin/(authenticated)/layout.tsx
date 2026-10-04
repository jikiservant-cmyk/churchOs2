import { getChurchBySlug } from '@/lib/db';
import { createClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import AdminSidebar from '@/components/AdminSidebar';

export default async function AdminLayout({ 
  children, 
  params 
}: { 
  children: React.ReactNode, 
  params: Promise<{ church_slug: string }> 
}) {
  const { church_slug } = await params;
  let church = await getChurchBySlug(church_slug);

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect(`/?error=Session Expired`);
  }

  // Role Check
  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('role, tenant_id')
    .eq('id', user.id)
    .maybeSingle();

  // Role and Tenant Check (fail closed if no tenant_id assigned)
  if (!profile || profile.role !== 'pastor' || !profile.tenant_id) {
    redirect(`/?error=Access Denied`);
  }

  // If church was not found by the slug in the URL, recover using the pastor's tenant_id
  if (!church) {
    const { data: pastorChurch } = await supabase
      .schema('church')
      .from('churches')
      .select('*')
      .eq('id', profile.tenant_id)
      .maybeSingle();

    if (pastorChurch?.slug) {
      redirect(`/${pastorChurch.slug}/admin`);
    } else {
      redirect('/signup/provision');
    }
  }

  // Church Mismatch Check
  if (church.id !== profile.tenant_id) {
    const { data: correctChurch } = await supabase
      .schema('church')
      .from('churches')
      .select('slug')
      .eq('id', profile.tenant_id)
      .maybeSingle();
      
    if (correctChurch?.slug && correctChurch.slug !== church_slug) {
      redirect(`/${correctChurch.slug}/admin`);
    } else {
       // If mismatch but no clear home, just render error instead of redirect loop
       return (
         <div className="min-h-screen bg-[#E4D5BC] flex items-center justify-center p-12 text-center">
            <div className="bg-[#F0E6D3] p-8 rounded-3xl border border-[#B5622A]/20 shadow-xl max-w-md">
               <h2 className="text-2xl font-bold text-[#1E1208] mb-4">Church Mismatch</h2>
               <p className="text-[#9A7E65]">You are not authorized to manage this church portal. Please contact support if this is an error.</p>
               <Link href="/" className="inline-block mt-6 px-6 py-2 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl font-bold uppercase tracking-widest text-xs">Return Home</Link>
            </div>
         </div>
       );
    }
  }

  // App Gate: Check activation status
  if (church.activation_status === 'pending_payment') {
    redirect(`/${church_slug}/admin/activation`);
  } else if (church.activation_status === 'suspended') {
    return (
      <div 
        style={{ fontFamily: "'Outfit', sans-serif" }}
        className="min-h-screen bg-[#2B1A0E] flex items-center justify-center p-6 text-center"
      >
        <div className="bg-[#F0E6D3] p-8 rounded-3xl border border-[#B5622A]/20 shadow-2xl max-w-md w-full">
          <div className="w-12 h-12 bg-[#B5622A]/10 text-[#B5622A] rounded-full flex items-center justify-center mx-auto mb-4 font-bold text-xl">
            !
          </div>
          <h2 style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208] mb-3">
            Workspace Suspended
          </h2>
          <p className="text-[#9A7E65] text-sm leading-relaxed mb-6">
            This church workspace ({church.name}) has been temporarily suspended. Please contact administrative support to reactivate your portal.
          </p>
          <form action="/api/auth/logout" method="POST">
            <button 
              type="submit" 
              className="w-full py-3 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl font-bold uppercase tracking-widest text-xs hover:bg-[#3D2614] transition-all"
            >
              Sign Out
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div 
      style={{ fontFamily: "'Outfit', sans-serif" }}
      className="h-screen bg-[#E4D5BC] flex overflow-hidden"
    >
      <AdminSidebar church={church} churchSlug={church_slug} />
      <main className="flex-1 h-full overflow-y-auto px-6 py-8 md:px-12 md:py-10">
        <div className="max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
