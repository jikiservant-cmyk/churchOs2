import { createClient, createAdminClient, isServiceRoleConfigured } from '@/lib/supabase/server';
import {
  History,
  AlertCircle,
} from 'lucide-react';
import BroadcastComposer from '@/components/BroadcastComposer';
import { getChurchBySlug } from '@/lib/db';
import { readWalletWithColumnFallback, walletDerivedBalanceUgx, walletSmsRate } from '@/lib/wallet-read';
import BroadcastHistory from '@/components/BroadcastHistory';
import SMSWalletWidget from '@/components/SMSWalletWidget';

export const dynamic = 'force-dynamic';

export default async function MessagesPage(props: {
  params: Promise<{ church_slug: string }>;
}) {
  const resolvedParams = await props.params;
  const supabase = await createClient();

  let churchObj = await getChurchBySlug(resolvedParams.church_slug);

  // If slug lookup failed, try to resolve by the logged-in user's profile
  if (!churchObj) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase
        .from("admin_profiles")
        .select("tenant_id")
        .eq("id", user.id)
        .maybeSingle();

      if (profile?.tenant_id) {
        const { data: profileChurch } = await supabase
          .schema("church")
          .from("churches")
          .select("*")
          .eq("id", profile.tenant_id)
          .maybeSingle();

        if (profileChurch) {
          churchObj = {
            id: profileChurch.id,
            name: profileChurch.name,
            slug: profileChurch.slug,
            themeColor: profileChurch.theme_color || "bg-blue-600",
            logoUrl:
              profileChurch.logo_url ||
              `https://picsum.photos/seed/${profileChurch.slug}/200/200`,
          };
        }
      }
    }
  }

  const church = churchObj || {
    id: "placeholder",
    name: resolvedParams.church_slug,
    slug: resolvedParams.church_slug,
    themeColor: "bg-slate-900",
    logoUrl: `https://picsum.photos/seed/${resolvedParams.church_slug}/200/200`,
  };

  let members: any = [];
  let balanceData: any = null;

  const isPlaceholder =
    !churchObj || church.id === "placeholder" || church.id === "unknown";

  if (church && !isPlaceholder) {
    // Wallet balance is the source of truth for SMS count: public.wallets
    // (credited by the webhook's process_topup_webhook RPC).
    // Service-role read first so a stale JWT / RLS lag cannot zero it; an
    // RLS-scoped read as fallback so a missing SUPABASE_SERVICE_ROLE_KEY
    // degrades to "own tenant only" instead of silently rendering 0 — that
    // silent 0 is what made a healthy wallet look empty.
    try {
      const serviceRoleConfigured = isServiceRoleConfigured();
      const adminSupabase = await createAdminClient();
      const { data: { user: walletUser } } = await supabase.auth.getUser();
      let authorized = true;
      if (serviceRoleConfigured && walletUser) {
        const { data: walletProfile, error: walletProfileError } = await adminSupabase
          .from('admin_profiles')
          .select('tenant_id, role')
          .eq('id', walletUser.id)
          .maybeSingle();
        if (walletProfileError) {
          console.warn('[MessagesPage] Admin profile lookup failed; using the RLS-scoped wallet read instead:', walletProfileError.message);
        } else if (walletProfile?.tenant_id && walletProfile.tenant_id !== church.id) {
          authorized = false;
        }
      }
      if (!authorized) {
        console.warn('[MessagesPage] Wallet access denied for tenant mismatch');
      } else {
        // Church policy is `tenant_id = church.my_tenant_id()`, so the RLS client
        // can only ever return the signed-in user's own wallet — that makes it a
        // safe fallback when the service-role read is unavailable.
        const readers = [
          { label: 'service-role', ready: serviceRoleConfigured, client: adminSupabase },
          { label: 'RLS', ready: true, client: supabase },
        ];
        for (const reader of readers) {
          if (!reader.ready) {
            console.warn('[MessagesPage] SUPABASE_SERVICE_ROLE_KEY is not set; reading the wallet through RLS');
            continue;
          }
          // A dynamic `select(columns)` string defeats supabase-js's projection
          // typing, so the row is normalised here rather than in the helper.
          const client = reader.client;
          const result = await readWalletWithColumnFallback(async (columns) => {
            const { data, error } = await client.from('wallets').select(columns).eq('tenant_id', church.id).maybeSingle();
            return {
              data: (data ?? null) as unknown as { balance?: number | string | null; sms_rate?: number | null; tenant_id?: string | null } | null,
              error: (error ?? null) as unknown as { code?: string; message?: string } | null,
            };
          });
          if (result.wallet) {
            balanceData = result.wallet;
            if (result.degraded) {
              console.warn(`[MessagesPage] public.wallets has no sms_rate column (${reader.label}); using the default rate`);
            }
            break;
          }
          if (result.error) {
            console.warn(`[MessagesPage] Wallet fetch via ${reader.label} failed:`, result.error.code ?? '', result.error.message ?? '');
          } else {
            console.warn(`[MessagesPage] No public.wallets row for tenant ${church.id} via ${reader.label}`);
          }
        }
      }
    } catch (e: any) {
      console.warn('[MessagesPage] Wallet admin fetch threw:', e?.message ?? e);
      // Fallback to RLS path so page never hard-crashes
      try {
        const { data: balance } = await supabase
          .from('wallets')
          .select('balance, sms_rate, tenant_id')
          .eq('tenant_id', church.id)
          .maybeSingle();
        balanceData = balance;
      } catch (fallbackError: any) {
        console.warn('[MessagesPage] Wallet RLS fallback threw:', fallbackError?.message ?? fallbackError);
      }
    }

    // 2. Fetch members
    let { data: memberData, error: memberError } = await supabase
      .schema("church")
      .from("members")
      .select("*")
      .eq("church_id", church.id)
      .not("phone_number", "is", null);

    if (memberError) {
      console.error(
        "[MessagesPage] Member fetch error details:",
        memberError.message,
        memberError.details,
        memberError.hint,
      );
    }

    // 3. Fetch new converts
    let { data: newConvertsData, error: convertsError } = await supabase
      .schema("church")
      .from("new_converts")
      .select("*")
      .eq("church_id", church.id)
      .not("contact", "is", null);

    if (convertsError) {
      console.error(
        "[MessagesPage] New converts fetch error details:",
        convertsError.message,
        convertsError.details,
        convertsError.hint,
      );
    }

    // Unify them into a generic Recipient array
    const realMembers = (memberData || []).map((m) => ({
      id: m.id,
      full_name: m.full_name,
      phone_number: m.phone_number,
      source: "member" as const,
      gender: m.gender,
      is_youth: m.is_youth,
    }));

    const newConverts = (newConvertsData || []).map((nc) => ({
      id: nc.id,
      full_name: nc.name,
      phone_number: nc.contact, // map contact to phone_number
      source: "new_convert" as const,
    }));

    members = [...realMembers, ...newConverts];
  }

  const validMembersCount = members?.length || 0;
  // wallets.balance is bigint → Supabase may return a string; a missing sms_rate
  // column (older deployments) falls back to the default rate, never to a blank.
  const balanceUgx = walletDerivedBalanceUgx(balanceData);
  const smsRate = walletSmsRate(balanceData);
  const remainingSMS = Math.floor(balanceUgx / smsRate);
  const leftoverUGX = balanceUgx % smsRate;

  // Fetch recent SMS logs for broadcast history
  let smsLogs: any = [];
  if (church && !isPlaceholder) {
    const { data } = await supabase
      .schema("church")
      .from("sms_logs")
      .select("id, created_at, body, status")
      .eq("tenant_id", church.id)
      .order("created_at", { ascending: false })
      .limit(200);
    smsLogs = data || [];
  }

  // Group by date, then by message to represent a "broadcast" per day
  const groupedByDateAndMsg = (smsLogs || []).reduce((acc: any, log: any) => {
    const msgContent = log.body || "";
    let dateStr = "Unknown Date";
    try {
      if (log.created_at) {
        const d = new Date(log.created_at);
        if (!isNaN(d.getTime())) {
          dateStr = d.toLocaleDateString(undefined, {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          });
        }
      }
    } catch {}

    if (!acc[dateStr]) acc[dateStr] = {};

    if (!acc[dateStr][msgContent]) {
      acc[dateStr][msgContent] = {
        message: msgContent,
        created_at: log.created_at || new Date().toISOString(),
        count: 0,
        successCount: 0,
        failedCount: 0,
      };
    }
    
    acc[dateStr][msgContent].count++;
    if (log.status?.toLowerCase() === "failed") {
      acc[dateStr][msgContent].failedCount++;
    } else {
      acc[dateStr][msgContent].successCount++;
    }
    return acc;
  }, {});

  const broadcastDates = Object.entries(groupedByDateAndMsg).map(([dateStr, msgsMap]: [string, any]) => {
    const messages = Object.values(msgsMap).sort(
      (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const maxDate = Math.max(...messages.map((m: any) => new Date(m.created_at).getTime()));
    return {
      dateStr,
      messages,
      sortTime: maxDate,
    };
  }).sort((a, b) => b.sortTime - a.sortTime);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1
            style={{ fontFamily: "'Playfair Display', serif" }}
            className="text-3xl font-bold text-[#1E1208]"
          >
            Broadcast SMS
          </h1>
          <p className="text-[13px] text-[#9A7E65] mt-1.5 font-medium">
            Send messages to your congregation instantly.
          </p>
        </div>

        {/* SMS Wallet Widget */}
        <SMSWalletWidget 
          remainingSMS={remainingSMS}
          balanceUgx={balanceUgx}
          leftoverUGX={leftoverUGX}
          churchId={church.id}
          walletUnavailable={!balanceData}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Composer (Left Column) */}
        <div className="lg:col-span-2 space-y-6">
          {church && !isPlaceholder ? (
            <BroadcastComposer members={members || []} churchId={church.id} />
          ) : (
            <div className="bg-[#F0E6D3] rounded-2xl border border-dashed border-[#B5622A]/30 p-12 text-center">
              <div className="w-16 h-16 bg-[#B5622A]/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <AlertCircle className="w-8 h-8 text-[#B5622A]" />
              </div>
              <h3
                style={{ fontFamily: "'Playfair Display', serif" }}
                className="text-xl font-bold text-[#1E1208] mb-2"
              >
                Church Connection Required
              </h3>
              <p className="text-[#9A7E65] text-sm max-w-sm mx-auto mb-6">
                We couldn&apos;t securely verify which church you are sending
                for. Please try refreshing or visiting your church&apos;s direct
                admin portal.
              </p>
              <a
                href="."
                className="inline-block px-6 py-2 bg-[#2B1A0E] text-[#F5E6CE] text-xs font-bold rounded-lg uppercase tracking-widest hover:bg-[#3D2614] transition-all"
              >
                Refresh Dashboard
              </a>
            </div>
          )}
        </div>

        {/* History (Right Column) */}
        <div className="bg-[#F0E6D3] rounded-2xl shadow-sm border border-[rgba(90,55,20,0.13)] p-6 h-fit max-h-[600px] overflow-auto flex flex-col">
          <h2
            style={{ fontFamily: "'Playfair Display', serif" }}
            className="text-lg font-bold text-[#1E1208] mb-6 flex items-center gap-2 sticky top-0 bg-[#F0E6D3] z-10 pb-2 border-b border-[rgba(90,55,20,0.05)]"
          >
            <History className="w-5 h-5 text-[#B5622A]" />
            Recent Broadcasts
          </h2>

          <BroadcastHistory broadcastDates={broadcastDates} />
        </div>
      </div>
    </div>
  );
}
