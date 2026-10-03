'use client';

import { useState } from 'react';
import { 
  Building2, 
  Church, 
  Users, 
  Coins, 
  ShieldCheck, 
  Plus, 
  Trash2, 
  Copy, 
  Check, 
  ExternalLink, 
  AlertCircle, 
  Calendar, 
  LogOut,
  RefreshCw,
  Search,
  KeyRound,
  Link2,
  Mail,
  UserCheck,
  TrendingUp,
  Shield,
  Layers,
  Sparkles,
  ChevronRight,
  Eye
} from 'lucide-react';
import { 
  OverseerChurchItem, 
  OverseerTotals, 
  OverseerInvite, 
  createOverseerInvite, 
  revokeOverseerInvite, 
  detachOverseerChurch 
} from '@/lib/overseer-actions';
import OverseerCharts from './OverseerCharts';
import { toast } from 'sonner';
import Link from 'next/link';

interface OverseerDashboardClientProps {
  initialTotals: OverseerTotals;
  initialChurches: OverseerChurchItem[];
  initialInvites: OverseerInvite[];
  userEmail: string;
  denominationName?: string;
  denominationSlug?: string;
}

// Sample demonstration dataset for brand new dioceses prior to pastor onboarding
const SAMPLE_CHURCHES: OverseerChurchItem[] = [
  {
    church_id: 'sample-1',
    name: 'Grace Cathedral Central',
    slug: 'grace-central',
    pastor_name: 'Rev. Emmanuel Kato',
    pastor_email: 'emmanuel@gracecentral.org',
    member_count: 420,
    recent_attendance: 385,
    total_giving: 14250000,
    joined_at: new Date(Date.now() - 90 * 86400000).toISOString(),
    status: 'active',
  },
  {
    church_id: 'sample-2',
    name: 'St. Luke Parish North',
    slug: 'st-luke-north',
    pastor_name: 'Pastor Sarah Namubiru',
    pastor_email: 'sarah@stlukenorth.org',
    member_count: 280,
    recent_attendance: 245,
    total_giving: 8900000,
    joined_at: new Date(Date.now() - 60 * 86400000).toISOString(),
    status: 'active',
  },
  {
    church_id: 'sample-3',
    name: 'Faith Fellowship East',
    slug: 'faith-east',
    pastor_name: 'Pastor David Mugisha',
    pastor_email: 'david@faitheast.org',
    member_count: 195,
    recent_attendance: 170,
    total_giving: 5400000,
    joined_at: new Date(Date.now() - 45 * 86400000).toISOString(),
    status: 'active',
  },
  {
    church_id: 'sample-4',
    name: 'Hope Community Chapel',
    slug: 'hope-chapel',
    pastor_name: 'Rev. Joshua Okello',
    pastor_email: 'joshua@hopechapel.org',
    member_count: 140,
    recent_attendance: 125,
    total_giving: 3750000,
    joined_at: new Date(Date.now() - 20 * 86400000).toISOString(),
    status: 'active',
  },
  {
    church_id: 'sample-5',
    name: 'New Life Outreach Campus',
    slug: 'newlife-outreach',
    pastor_name: 'Pastor Grace Akello',
    pastor_email: 'grace@newlife.org',
    member_count: 95,
    recent_attendance: 88,
    total_giving: 2100000,
    joined_at: new Date(Date.now() - 10 * 86400000).toISOString(),
    status: 'active',
  },
];

const SAMPLE_INVITES: OverseerInvite[] = [
  {
    id: 'inv-sample-1',
    code: 'DIOCESE-2026-WEST',
    max_uses: 5,
    uses_count: 2,
    created_at: new Date(Date.now() - 15 * 86400000).toISOString(),
    expires_at: new Date(Date.now() + 75 * 86400000).toISOString(),
  },
  {
    id: 'inv-sample-2',
    code: 'PLANTING-EAST-01',
    max_uses: 1,
    uses_count: 0,
    created_at: new Date(Date.now() - 5 * 86400000).toISOString(),
    expires_at: new Date(Date.now() + 25 * 86400000).toISOString(),
  },
  {
    id: 'inv-sample-3',
    code: 'CAMPUS-YOUTH-NET',
    max_uses: null,
    uses_count: 3,
    created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
    expires_at: null,
  }
];

export default function OverseerDashboardClient({
  initialTotals,
  initialChurches,
  initialInvites,
  userEmail,
  denominationName = 'Diocese Governance',
  denominationSlug,
}: OverseerDashboardClientProps) {
  // If zero real churches exist, enable demo toggle so the overseer sees the full UI potential
  const isZeroState = initialChurches.length === 0;
  const [useDemoData, setUseDemoData] = useState(isZeroState);

  const activeChurches = useDemoData ? SAMPLE_CHURCHES : initialChurches;
  const activeInvites = useDemoData && initialInvites.length === 0 ? SAMPLE_INVITES : initialInvites;

  const [activeTab, setActiveTab] = useState<'churches' | 'invites' | 'governance'>('churches');
  const [churches, setChurches] = useState<OverseerChurchItem[]>(activeChurches);
  const [invites, setInvites] = useState<OverseerInvite[]>(activeInvites);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'large' | 'medium' | 'growth'>('all');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // Invite modal state
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [inviteMaxUses, setInviteMaxUses] = useState('');
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);

  // Detach confirmation modal
  const [detachingChurch, setDetachingChurch] = useState<OverseerChurchItem | null>(null);
  const [isDetaching, setIsDetaching] = useState(false);

  // Compute calculated metrics
  const totalChurchesCount = churches.length;
  const totalMembersCount = churches.reduce((sum, c) => sum + (c.member_count || 0), 0);
  const totalAttendanceCount = churches.reduce((sum, c) => sum + (c.recent_attendance || 0), 0);
  const totalGivingAmount = churches.reduce((sum, c) => sum + (c.total_giving || 0), 0);
  const averageAttendance = totalChurchesCount > 0 ? Math.round(totalAttendanceCount / totalChurchesCount) : 0;

  // Prepare chart datasets
  const churchAttendanceData = churches.slice(0, 7).map(c => ({
    name: c.name.length > 15 ? `${c.name.slice(0, 15)}...` : c.name,
    attendance: c.recent_attendance || 0,
    members: c.member_count || 0,
  }));

  const givingByChurchData = churches.slice(0, 7).map(c => ({
    name: c.name.length > 15 ? `${c.name.slice(0, 15)}...` : c.name,
    giving: c.total_giving || 0,
  }));

  const sizeDistributionData = [
    { name: '100+ Members', value: churches.filter(c => (c.member_count || 0) >= 100).length, color: '#2B1A0E' },
    { name: '< 100 Members', value: churches.filter(c => (c.member_count || 0) < 100).length, color: '#B5622A' },
  ];

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    toast.success(`Invite code copied: ${code}`);
    setTimeout(() => setCopiedCode(null), 2500);
  };

  const handleCopyInviteLink = (code: string) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const link = `${origin}/signup/provision?code=${code}`;
    navigator.clipboard.writeText(link);
    toast.success('Registration invite link copied to clipboard!');
  };

  const handleCreateInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreatingInvite(true);

    try {
      const formData = new FormData();
      if (inviteCodeInput.trim()) {
        formData.set('code', inviteCodeInput.trim().toUpperCase());
      }
      if (inviteMaxUses.trim()) {
        formData.set('max_uses', inviteMaxUses.trim());
      }

      const res = await createOverseerInvite(formData);
      if (res.error) {
        toast.error(res.error);
      } else {
        toast.success('Pastor invite created successfully!');
        setIsInviteModalOpen(false);
        setInviteCodeInput('');
        setInviteMaxUses('');
        window.location.reload();
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create invite');
    } finally {
      setIsCreatingInvite(false);
    }
  };

  const handleRevokeInvite = async (inviteIdentifier: string) => {
    if (!confirm('Are you sure you want to revoke this invite code?')) return;

    try {
      const res = await revokeOverseerInvite(inviteIdentifier);
      if (res.error) {
        toast.error(res.error);
      } else {
        toast.success('Invite code revoked');
        setInvites(prev => prev.filter(inv => (inv.id || inv.code) !== inviteIdentifier));
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to revoke invite');
    }
  };

  const handleConfirmDetach = async () => {
    if (!detachingChurch) return;
    setIsDetaching(true);

    try {
      const res = await detachOverseerChurch(detachingChurch.church_id);
      if (res.error) {
        toast.error(res.error);
      } else {
        toast.success(`Detached ${detachingChurch.name} from denomination`);
        setChurches(prev => prev.filter(c => c.church_id !== detachingChurch.church_id));
        setDetachingChurch(null);
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to detach church');
    } finally {
      setIsDetaching(false);
    }
  };

  const filteredChurches = churches.filter(c => {
    const q = searchQuery.toLowerCase();
    const matchesQuery = (
      c.name.toLowerCase().includes(q) ||
      c.slug.toLowerCase().includes(q) ||
      (c.pastor_name && c.pastor_name.toLowerCase().includes(q)) ||
      (c.pastor_email && c.pastor_email.toLowerCase().includes(q))
    );

    if (!matchesQuery) return false;

    if (statusFilter === 'large') return (c.member_count || 0) >= 200;
    if (statusFilter === 'medium') return (c.member_count || 0) >= 100 && (c.member_count || 0) < 200;
    if (statusFilter === 'growth') return (c.member_count || 0) < 100;
    return true;
  });

  const formatCurrency = (val?: number) => {
    if (!val) return 'UGX 0';
    return `UGX ${val.toLocaleString()}`;
  };

  // Greeting based on current hour
  const currentHour = new Date().getHours();
  const timeGreeting = currentHour < 12 ? 'Good morning' : currentHour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="space-y-8" style={{ fontFamily: "'Outfit', sans-serif" }}>
      {/* Zero State / Demo Mode Ticker Banner */}
      {isZeroState && (
        <div className="bg-[#F0E6D3] border border-[#B5622A]/30 rounded-2xl p-4 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[#B5622A] text-white rounded-xl">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-bold text-[#1E1208]">
                {useDemoData ? 'Showing Demonstration Diocese Preview' : 'Your Denomination Network is Freshly Provisioned'}
              </p>
              <p className="text-[11px] text-[#9A7E65]">
                {useDemoData 
                  ? 'Previewing metrics with sample parish congregations. Generate your first pastor invite to start onboarding.' 
                  : 'No member churches have linked yet. Use the toggle to preview how the executive charts will look.'}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              const nextState = !useDemoData;
              setUseDemoData(nextState);
              setChurches(nextState ? SAMPLE_CHURCHES : []);
              setInvites(nextState ? SAMPLE_INVITES : initialInvites);
            }}
            className="px-3.5 py-1.5 bg-[#2B1A0E] text-[#F5E6CE] hover:bg-[#3D2614] rounded-xl text-xs font-bold uppercase tracking-wider transition-colors shrink-0"
          >
            {useDemoData ? 'Switch to Live Data' : 'Preview Demo View'}
          </button>
        </div>
      )}

      {/* Executive Greeting Hero Banner */}
      <div className="bg-[#F0E6D3] rounded-3xl border border-[rgba(90,55,20,0.15)] p-6 md:p-8 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-6 relative overflow-hidden">
        <div className="flex items-start gap-4 z-10">
          <div className="w-16 h-16 rounded-2xl bg-[#2B1A0E] text-[#F5E6CE] flex items-center justify-center shrink-0 shadow-md">
            <ShieldCheck className="w-8 h-8 text-[#B5622A]" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-bold text-[#B5622A] uppercase tracking-widest bg-[rgba(181,98,42,0.1)] px-2.5 py-0.5 rounded-full">
                Regional Episcopate
              </span>
              <span className="text-xs text-[#9A7E65] font-mono">
                {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
            <h2 style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl md:text-3xl font-bold text-[#1E1208]">
              {timeGreeting}, Bishop
            </h2>
            <p className="text-xs md:text-sm text-[#6B513E] mt-1 max-w-xl leading-relaxed">
              Oversight console for <strong className="text-[#1E1208]">{denominationName}</strong>. Monitoring {totalChurchesCount} parish branches and {totalMembersCount.toLocaleString()} souls across the region.
            </p>
          </div>
        </div>

        {/* Action Button Row */}
        <div className="flex flex-wrap items-center gap-2.5 z-10 w-full md:w-auto">
          <button
            onClick={() => {
              setActiveTab('invites');
              setIsInviteModalOpen(true);
            }}
            className="flex-1 md:flex-initial px-4 py-3 bg-[#B5622A] hover:bg-[#C6733B] text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-all shadow-sm flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>New Pastor Invite</span>
          </button>

          {denominationSlug && (
            <Link
              href={`/d/${denominationSlug}`}
              target="_blank"
              className="flex-1 md:flex-initial px-4 py-3 bg-[#2B1A0E] hover:bg-[#3D2614] text-[#F5E6CE] rounded-xl text-xs font-bold uppercase tracking-wider transition-all shadow-sm flex items-center justify-center gap-2"
            >
              <ExternalLink className="w-4 h-4" />
              <span>Diocese Portal</span>
            </Link>
          )}
        </div>
      </div>

      {/* 6 Top-Level KPI Metric Tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {/* Tile 1: Total Churches */}
        <div className="bg-[#F0E6D3] rounded-2xl p-4 border border-[rgba(90,55,20,0.13)] shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-[#9A7E65] uppercase tracking-wider">Parishes</span>
            <div className="p-1.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-lg">
              <Church className="w-3.5 h-3.5 text-[#B5622A]" />
            </div>
          </div>
          <div>
            <div style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208]">
              {totalChurchesCount}
            </div>
            <p className="text-[10px] text-[#9A7E65] font-medium mt-0.5">Active branch churches</p>
          </div>
        </div>

        {/* Tile 2: Regional Members */}
        <div className="bg-[#F0E6D3] rounded-2xl p-4 border border-[rgba(90,55,20,0.13)] shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-[#9A7E65] uppercase tracking-wider">Total Souls</span>
            <div className="p-1.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-lg">
              <Users className="w-3.5 h-3.5 text-[#B5622A]" />
            </div>
          </div>
          <div>
            <div style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208]">
              {totalMembersCount.toLocaleString()}
            </div>
            <p className="text-[10px] text-[#9A7E65] font-medium mt-0.5">Registered congregation</p>
          </div>
        </div>

        {/* Tile 3: Weekly Attendance */}
        <div className="bg-[#F0E6D3] rounded-2xl p-4 border border-[rgba(90,55,20,0.13)] shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-[#9A7E65] uppercase tracking-wider">Attendance</span>
            <div className="p-1.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-lg">
              <TrendingUp className="w-3.5 h-3.5 text-[#B5622A]" />
            </div>
          </div>
          <div>
            <div style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208]">
              {totalAttendanceCount.toLocaleString()}
            </div>
            <p className="text-[10px] text-[#9A7E65] font-medium mt-0.5">Recent service check-ins</p>
          </div>
        </div>

        {/* Tile 4: Average Attendance */}
        <div className="bg-[#F0E6D3] rounded-2xl p-4 border border-[rgba(90,55,20,0.13)] shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-[#9A7E65] uppercase tracking-wider">Avg / Parish</span>
            <div className="p-1.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-lg">
              <UserCheck className="w-3.5 h-3.5 text-[#B5622A]" />
            </div>
          </div>
          <div>
            <div style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208]">
              {averageAttendance}
            </div>
            <p className="text-[10px] text-[#9A7E65] font-medium mt-0.5">Congregants per service</p>
          </div>
        </div>

        {/* Tile 5: Total Giving (UGX) */}
        <div className="bg-[#F0E6D3] rounded-2xl p-4 border border-[rgba(90,55,20,0.13)] shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-[#9A7E65] uppercase tracking-wider">MoMo Giving</span>
            <div className="p-1.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-lg">
              <Coins className="w-3.5 h-3.5 text-[#B5622A]" />
            </div>
          </div>
          <div>
            <div style={{ fontFamily: "'Playfair Display', serif" }} className="text-lg font-bold text-[#1E1208] truncate">
              {formatCurrency(totalGivingAmount)}
            </div>
            <p className="text-[10px] text-[#9A7E65] font-medium mt-0.5">Reported contributions</p>
          </div>
        </div>

        {/* Tile 6: Active Invites */}
        <div className="bg-[#F0E6D3] rounded-2xl p-4 border border-[rgba(90,55,20,0.13)] shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-[#9A7E65] uppercase tracking-wider">Pastor Invites</span>
            <div className="p-1.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-lg">
              <KeyRound className="w-3.5 h-3.5 text-[#B5622A]" />
            </div>
          </div>
          <div>
            <div style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208]">
              {invites.length}
            </div>
            <p className="text-[10px] text-[#9A7E65] font-medium mt-0.5">Active join codes</p>
          </div>
        </div>
      </div>

      {/* Diocesan Visual Analytics Row */}
      <OverseerCharts
        churchAttendanceData={churchAttendanceData}
        givingByChurchData={givingByChurchData}
        sizeDistributionData={sizeDistributionData}
      />

      {/* Tab Navigation Row */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 border-b border-[rgba(90,55,20,0.1)] pb-4">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('churches')}
            className={`px-4 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all flex items-center gap-2 ${
              activeTab === 'churches'
                ? 'bg-[#2B1A0E] text-[#F5E6CE] shadow-sm'
                : 'bg-white/60 text-[#6B513E] hover:bg-white'
            }`}
          >
            <Church className="w-4 h-4" />
            <span>Member Churches ({churches.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('invites')}
            className={`px-4 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all flex items-center gap-2 ${
              activeTab === 'invites'
                ? 'bg-[#2B1A0E] text-[#F5E6CE] shadow-sm'
                : 'bg-white/60 text-[#6B513E] hover:bg-white'
            }`}
          >
            <KeyRound className="w-4 h-4" />
            <span>Pastor Invites ({invites.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('governance')}
            className={`px-4 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all flex items-center gap-2 ${
              activeTab === 'governance'
                ? 'bg-[#2B1A0E] text-[#F5E6CE] shadow-sm'
                : 'bg-white/60 text-[#6B513E] hover:bg-white'
            }`}
          >
            <Shield className="w-4 h-4" />
            <span>Governance & Privacy</span>
          </button>
        </div>

        {/* Search & Filters */}
        {activeTab === 'churches' && (
          <div className="flex items-center gap-2">
            <div className="relative flex-1 sm:w-64">
              <Search className="w-4 h-4 text-[#9A7E65] absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search parishes or pastors..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3.5 py-2 bg-white/70 border border-[rgba(90,55,20,0.12)] rounded-xl text-xs text-[#1E1208] outline-none focus:border-[#B5622A]"
              />
            </div>

            <div className="hidden lg:flex gap-1 bg-white/60 p-1 rounded-xl border border-[rgba(90,55,20,0.08)]">
              {(['all', 'large', 'medium', 'growth'] as const).map((filter) => (
                <button
                  key={filter}
                  onClick={() => setStatusFilter(filter)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${
                    statusFilter === filter
                      ? 'bg-[#2B1A0E] text-[#F5E6CE]'
                      : 'text-[#9A7E65] hover:text-[#1E1208]'
                  }`}
                >
                  {filter}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Tab 1: Member Churches Directory */}
      {activeTab === 'churches' && (
        <div className="space-y-4">
          {filteredChurches.length === 0 ? (
            <div className="bg-[#F0E6D3] rounded-3xl p-12 text-center border border-[rgba(90,55,20,0.12)]">
              <Church className="w-12 h-12 text-[#9A7E65] mx-auto mb-3" />
              <h3 style={{ fontFamily: "'Playfair Display', serif" }} className="text-xl font-bold text-[#1E1208]">
                No Affiliated Churches Found
              </h3>
              <p className="text-xs text-[#9A7E65] max-w-md mx-auto mt-2 leading-relaxed">
                Churches will appear here once pastors join using your denomination invite codes. Generate an invite code to begin onboarding congregations.
              </p>
              <button
                onClick={() => {
                  setActiveTab('invites');
                  setIsInviteModalOpen(true);
                }}
                className="mt-6 px-5 py-2.5 bg-[#B5622A] hover:bg-[#C6733B] text-white rounded-xl text-xs font-bold uppercase tracking-wider inline-flex items-center gap-2 shadow-sm"
              >
                <Plus className="w-4 h-4" />
                <span>Create Pastor Invite Code</span>
              </button>
            </div>
          ) : (
            <div className="bg-[#F0E6D3] rounded-2xl border border-[rgba(90,55,20,0.12)] overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#2B1A0E] text-[#F5E6CE] uppercase text-[10px] tracking-wider">
                    <tr>
                      <th className="py-3.5 px-4 font-bold">Parish Congregation</th>
                      <th className="py-3.5 px-4 font-bold">Senior Pastor</th>
                      <th className="py-3.5 px-4 font-bold">Total Members</th>
                      <th className="py-3.5 px-4 font-bold">Recent Attendance</th>
                      <th className="py-3.5 px-4 font-bold">Total MoMo Giving</th>
                      <th className="py-3.5 px-4 font-bold">Vitality Status</th>
                      <th className="py-3.5 px-4 font-bold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[rgba(90,55,20,0.08)]">
                    {filteredChurches.map((church) => {
                      const isHighAttendance = (church.recent_attendance || 0) >= 150;
                      return (
                        <tr key={church.church_id} className="hover:bg-white/40 transition-colors">
                          <td className="py-4 px-4 font-bold text-[#1E1208]">
                            <div className="flex items-center gap-2">
                              <span>{church.name}</span>
                              <Link
                                href={`/${church.slug}`}
                                target="_blank"
                                title="Open public church portal"
                                className="text-[#9A7E65] hover:text-[#B5622A]"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </Link>
                            </div>
                            <span className="font-mono text-[11px] text-[#9A7E65] block mt-0.5">
                              /{church.slug}
                            </span>
                          </td>

                          <td className="py-4 px-4 text-[#6B513E]">
                            <div className="font-semibold text-[#1E1208]">
                              {church.pastor_name || 'Pastor'}
                            </div>
                            {church.pastor_email && (
                              <a 
                                href={`mailto:${church.pastor_email}`}
                                className="text-[11px] text-[#9A7E65] font-mono hover:text-[#B5622A] flex items-center gap-1 mt-0.5"
                              >
                                <Mail className="w-3 h-3" />
                                <span>{church.pastor_email}</span>
                              </a>
                            )}
                          </td>

                          <td className="py-4 px-4 font-bold text-[#1E1208]">
                            <span style={{ fontFamily: "'Playfair Display', serif" }} className="text-sm">
                              {(church.member_count ?? 0).toLocaleString()}
                            </span>
                          </td>

                          <td className="py-4 px-4 text-[#6B513E]">
                            <div className="font-semibold text-[#1E1208]">
                              {church.recent_attendance != null ? church.recent_attendance : '—'}
                            </div>
                            <div className="text-[10px] text-[#9A7E65]">last service</div>
                          </td>

                          <td className="py-4 px-4 font-semibold text-[#1E1208]">
                            <div className="font-mono text-xs">
                              {formatCurrency(church.total_giving)}
                            </div>
                          </td>

                          <td className="py-4 px-4">
                            <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider inline-flex items-center gap-1 ${
                              isHighAttendance 
                                ? 'bg-emerald-500/10 text-emerald-800 border border-emerald-500/20' 
                                : 'bg-amber-500/10 text-amber-800 border border-amber-500/20'
                            }`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${isHighAttendance ? 'bg-emerald-600' : 'bg-amber-600'}`} />
                              <span>{isHighAttendance ? 'Strong Vitality' : 'Growing'}</span>
                            </span>
                          </td>

                          <td className="py-4 px-4 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <Link
                                href={`/${church.slug}`}
                                target="_blank"
                                className="p-1.5 text-[#6B513E] hover:text-[#1E1208] hover:bg-white rounded-lg transition-colors"
                                title="View Church Portal"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </Link>

                              <button
                                onClick={() => setDetachingChurch(church)}
                                className="px-2.5 py-1 text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-colors inline-flex items-center gap-1"
                              >
                                <span>Detach</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Invites Management View */}
      {activeTab === 'invites' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 style={{ fontFamily: "'Playfair Display', serif" }} className="text-lg font-bold text-[#1E1208]">
                Pastor Affiliation Codes
              </h3>
              <p className="text-xs text-[#9A7E65]">
                Generate invite codes for pastors to affiliate their independent church or plant a new congregation branch.
              </p>
            </div>
            <button
              onClick={() => setIsInviteModalOpen(true)}
              className="px-4 py-2.5 bg-[#B5622A] hover:bg-[#C6733B] text-white rounded-xl font-bold text-xs uppercase tracking-wider transition-all shadow-sm flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Generate Invite Code</span>
            </button>
          </div>

          {invites.length === 0 ? (
            <div className="bg-[#F0E6D3] rounded-3xl p-12 text-center border border-[rgba(90,55,20,0.12)]">
              <KeyRound className="w-12 h-12 text-[#9A7E65] mx-auto mb-3" />
              <h3 style={{ fontFamily: "'Playfair Display', serif" }} className="text-xl font-bold text-[#1E1208]">
                No Invite Codes Active
              </h3>
              <p className="text-xs text-[#9A7E65] max-w-md mx-auto mt-2 leading-relaxed">
                Generate invite codes for pastors to link their churches during signup or via their Church Settings.
              </p>
              <button
                onClick={() => setIsInviteModalOpen(true)}
                className="mt-6 px-5 py-2.5 bg-[#B5622A] hover:bg-[#C6733B] text-white rounded-xl text-xs font-bold uppercase tracking-wider inline-flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>Generate First Invite Code</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {invites.map((inv) => {
                const identifier = inv.id || inv.code;
                const isCopied = copiedCode === inv.code;

                return (
                  <div 
                    key={identifier}
                    className="bg-[#F0E6D3] rounded-2xl p-5 border border-[rgba(90,55,20,0.12)] shadow-sm hover:border-[#B5622A]/30 transition-all flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <span className="px-3 py-1 bg-[#2B1A0E] text-[#F5E6CE] font-mono font-bold text-sm rounded-xl uppercase tracking-wider shadow-xs">
                          {inv.code}
                        </span>
                        <span className="text-[10px] uppercase font-bold text-[#B5622A] bg-[rgba(181,98,42,0.1)] px-2 py-0.5 rounded-full">
                          {inv.max_uses ? `${inv.uses_count || 0}/${inv.max_uses} used` : `${inv.uses_count || 0} uses`}
                        </span>
                      </div>

                      <div className="space-y-1.5 text-xs text-[#6B513E] mt-4">
                        {inv.created_at && (
                          <div className="flex items-center gap-1.5 text-[11px] text-[#9A7E65]">
                            <Calendar className="w-3.5 h-3.5" />
                            <span>Generated: {new Date(inv.created_at).toLocaleDateString()}</span>
                          </div>
                        )}
                        {inv.expires_at ? (
                          <div className="text-[11px] text-amber-800 font-medium">
                            Expires: {new Date(inv.expires_at).toLocaleDateString()}
                          </div>
                        ) : (
                          <div className="text-[11px] text-emerald-800 font-medium">
                            No Expiration (Perpetual)
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-5 pt-4 border-t border-[rgba(90,55,20,0.08)] flex items-center justify-between gap-2">
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleCopyCode(inv.code)}
                          title="Copy Code"
                          className="px-3 py-1.5 bg-white/70 hover:bg-white rounded-lg text-xs font-bold text-[#1E1208] flex items-center gap-1.5 transition-colors shadow-xs"
                        >
                          {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{isCopied ? 'Copied' : 'Copy Code'}</span>
                        </button>

                        <button
                          onClick={() => handleCopyInviteLink(inv.code)}
                          title="Copy Direct Signup Link"
                          className="px-2.5 py-1.5 bg-white/70 hover:bg-white rounded-lg text-xs font-bold text-[#B5622A] flex items-center gap-1 transition-colors shadow-xs"
                        >
                          <Link2 className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Link</span>
                        </button>
                      </div>

                      <button
                        onClick={() => handleRevokeInvite(identifier)}
                        title="Revoke Invite Code"
                        className="p-2 text-rose-700 hover:bg-rose-100 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Denomination Governance & Data Privacy */}
      {activeTab === 'governance' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-[#F0E6D3] rounded-2xl border border-[rgba(90,55,20,0.13)] p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-4 pb-3 border-b border-[rgba(90,55,20,0.08)]">
                <div className="p-2.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl">
                  <ShieldCheck className="w-5 h-5 text-[#B5622A]" />
                </div>
                <div>
                  <h3 className="font-bold text-base text-[#1E1208]">Ecclesiastical Privacy Architecture</h3>
                  <p className="text-xs text-[#9A7E65]">Strict separation between diocese reporting and pastoral confidence</p>
                </div>
              </div>

              <div className="space-y-4 text-xs text-[#6B513E] leading-relaxed">
                <p>
                  pastorOs is engineered with cryptographic multi-tenant isolation. When pastors link their church to your denomination network, the database enforces privacy rules at the PostgreSQL schema layer:
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                  <div className="p-3.5 bg-white/60 rounded-xl border border-[rgba(90,55,20,0.08)]">
                    <span className="font-bold text-[#1E1208] block mb-1">Visible to Overseer:</span>
                    <ul className="list-disc list-inside space-y-1 text-[#6B513E] text-[11px]">
                      <li>Parish name, slug & senior pastor contact</li>
                      <li>Total active registered member counts</li>
                      <li>Recent Sunday / midweek attendance totals</li>
                      <li>Total Mobile Money giving volume</li>
                      <li>Church planting & affiliation status</li>
                    </ul>
                  </div>

                  <div className="p-3.5 bg-white/60 rounded-xl border border-[rgba(90,55,20,0.08)]">
                    <span className="font-bold text-[#B5622A] block mb-1">Protected & Isolated to Pastor:</span>
                    <ul className="list-disc list-inside space-y-1 text-[#6B513E] text-[11px]">
                      <li>Individual member names & phone numbers</li>
                      <li>Confidential personal prayer requests</li>
                      <li>Specific donor identities & tithe records</li>
                      <li>Direct SMS conversation threads</li>
                      <li>Local visitor contact cards</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#F0E6D3] rounded-2xl border border-[rgba(90,55,20,0.13)] p-6 shadow-sm">
              <h3 className="font-bold text-base text-[#1E1208] mb-3">Diocese Public Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="text-[10px] uppercase font-bold text-[#9A7E65] block mb-1">Denomination Name</span>
                  <div className="px-3.5 py-2.5 bg-white/70 rounded-xl border border-[rgba(90,55,20,0.1)] font-semibold text-[#1E1208]">
                    {denominationName}
                  </div>
                </div>

                <div>
                  <span className="text-[10px] uppercase font-bold text-[#9A7E65] block mb-1">Public Network URL</span>
                  <div className="px-3.5 py-2.5 bg-white/70 rounded-xl border border-[rgba(90,55,20,0.1)] font-mono text-[#B5622A]">
                    {denominationSlug ? `/d/${denominationSlug}` : '/denominations'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="bg-[#2B1A0E] text-[#F5E6CE] rounded-2xl p-6 shadow-md">
              <h4 style={{ fontFamily: "'Playfair Display', serif" }} className="text-lg font-bold mb-2">
                Regional Growth
              </h4>
              <p className="text-xs text-[#C8B89A] leading-relaxed mb-4">
                Share invite codes with your regional presbyters and church planters to expand the diocese network across Uganda.
              </p>
              <button
                onClick={() => {
                  setActiveTab('invites');
                  setIsInviteModalOpen(true);
                }}
                className="w-full py-3 bg-[#B5622A] hover:bg-[#C6733B] text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-colors"
              >
                Generate Invite Code
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Create Invite Code */}
      {isInviteModalOpen && (
        <div className="fixed inset-0 bg-[#2B1A0E]/50 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#F0E6D3] rounded-3xl p-8 max-w-md w-full border border-[rgba(90,55,20,0.15)] shadow-2xl">
            <div className="w-12 h-12 rounded-2xl bg-[#2B1A0E] text-[#F5E6CE] flex items-center justify-center mb-4">
              <KeyRound className="w-6 h-6 text-[#B5622A]" />
            </div>

            <h3 style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208] mb-1">
              Generate Pastor Invite
            </h3>
            <p className="text-xs text-[#9A7E65] leading-relaxed mb-6">
              Create a secure invite code for pastors to connect their church to <strong className="text-[#1E1208]">{denominationName}</strong>.
            </p>

            <form onSubmit={handleCreateInviteSubmit} className="space-y-4">
              <div>
                <label className="block text-[11px] font-bold text-[#6B513E] uppercase tracking-wider mb-1">
                  Custom Code (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. DIOCESE-EAST-2026"
                  value={inviteCodeInput}
                  onChange={(e) => setInviteCodeInput(e.target.value.toUpperCase())}
                  className="w-full px-4 py-3 bg-white/70 border border-[rgba(90,55,20,0.15)] rounded-xl text-sm font-mono text-[#1E1208] uppercase focus:border-[#B5622A] outline-none"
                />
                <span className="text-[10px] text-[#9A7E65] mt-1 block">Leave empty to auto-generate a secure random code.</span>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[#6B513E] uppercase tracking-wider mb-1">
                  Maximum Uses (Optional)
                </label>
                <input
                  type="number"
                  placeholder="Unlimited (or e.g. 5)"
                  min="1"
                  value={inviteMaxUses}
                  onChange={(e) => setInviteMaxUses(e.target.value)}
                  className="w-full px-4 py-3 bg-white/70 border border-[rgba(90,55,20,0.15)] rounded-xl text-sm text-[#1E1208] focus:border-[#B5622A] outline-none"
                />
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setIsInviteModalOpen(false)}
                  className="flex-1 py-3 bg-white/60 hover:bg-white text-[#6B513E] font-bold text-xs uppercase tracking-wider rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreatingInvite}
                  className="flex-1 py-3 bg-[#2B1A0E] hover:bg-[#3D2614] text-[#F5E6CE] font-bold text-xs uppercase tracking-wider rounded-xl transition-colors disabled:opacity-50"
                >
                  {isCreatingInvite ? 'Creating...' : 'Create Invite'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Detach Church Confirmation */}
      {detachingChurch && (
        <div className="fixed inset-0 bg-[#2B1A0E]/50 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#F0E6D3] rounded-3xl p-8 max-w-md w-full border border-[rgba(90,55,20,0.15)] shadow-2xl">
            <div className="w-12 h-12 rounded-2xl bg-rose-100 text-rose-700 flex items-center justify-center mb-4">
              <AlertCircle className="w-6 h-6" />
            </div>
            <h3 style={{ fontFamily: "'Playfair Display', serif" }} className="text-xl font-bold text-[#1E1208] mb-2">
              Detach {detachingChurch.name}?
            </h3>
            <p className="text-xs text-[#9A7E65] leading-relaxed mb-6">
              This will remove this church from your denomination oversight. The church will safely return to independent status. Their member rows, logs, and donation records will remain intact for the local pastor.
            </p>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setDetachingChurch(null)}
                className="flex-1 py-3 bg-white/60 hover:bg-white text-[#6B513E] font-bold text-xs uppercase tracking-wider rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDetaching}
                onClick={handleConfirmDetach}
                className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs uppercase tracking-wider rounded-xl transition-colors disabled:opacity-50"
              >
                {isDetaching ? 'Detaching...' : 'Confirm Detach'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
