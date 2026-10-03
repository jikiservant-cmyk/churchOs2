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
  Link2
} from 'lucide-react';
import { 
  OverseerChurchItem, 
  OverseerTotals, 
  OverseerInvite, 
  createOverseerInvite, 
  revokeOverseerInvite, 
  detachOverseerChurch 
} from '@/lib/overseer-actions';
import { toast } from 'sonner';
import Link from 'next/link';

interface OverseerDashboardClientProps {
  initialTotals: OverseerTotals;
  initialChurches: OverseerChurchItem[];
  initialInvites: OverseerInvite[];
  userEmail: string;
}

export default function OverseerDashboardClient({
  initialTotals,
  initialChurches,
  initialInvites,
  userEmail,
}: OverseerDashboardClientProps) {
  const [activeTab, setActiveTab] = useState<'churches' | 'invites'>('churches');
  const [churches, setChurches] = useState<OverseerChurchItem[]>(initialChurches);
  const [invites, setInvites] = useState<OverseerInvite[]>(initialInvites);
  const [totals, setTotals] = useState<OverseerTotals>(initialTotals);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // Invite modal state
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [inviteMaxUses, setInviteMaxUses] = useState('');
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);

  // Detach confirmation modal
  const [detachingChurch, setDetachingChurch] = useState<OverseerChurchItem | null>(null);
  const [isDetaching, setIsDetaching] = useState(false);

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
    return (
      c.name.toLowerCase().includes(q) ||
      c.slug.toLowerCase().includes(q) ||
      (c.pastor_name && c.pastor_name.toLowerCase().includes(q)) ||
      (c.pastor_email && c.pastor_email.toLowerCase().includes(q))
    );
  });

  const formatCurrency = (val?: number) => {
    if (!val) return 'UGX 0';
    return `UGX ${val.toLocaleString()}`;
  };

  return (
    <div className="space-y-8" style={{ fontFamily: "'Outfit', sans-serif" }}>
      {/* KPI Cards Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <div className="bg-[#F0E6D3] rounded-2xl p-5 border border-[rgba(90,55,20,0.13)] shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold text-[#9A7E65] uppercase tracking-wider">Affiliated Churches</span>
            <div className="p-2 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl">
              <Church className="w-4 h-4 text-[#B5622A]" />
            </div>
          </div>
          <div className="text-3xl font-bold text-[#1E1208]">
            {totals.total_churches || churches.length}
          </div>
          <span className="text-[11px] text-[#9A7E65] mt-1 block">Active congregation branches</span>
        </div>

        <div className="bg-[#F0E6D3] rounded-2xl p-5 border border-[rgba(90,55,20,0.13)] shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold text-[#9A7E65] uppercase tracking-wider">Regional Members</span>
            <div className="p-2 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl">
              <Users className="w-4 h-4 text-[#B5622A]" />
            </div>
          </div>
          <div className="text-3xl font-bold text-[#1E1208]">
            {(totals.total_members || 0).toLocaleString()}
          </div>
          <span className="text-[11px] text-[#9A7E65] mt-1 block">Total souls under fellowship</span>
        </div>

        <div className="bg-[#F0E6D3] rounded-2xl p-5 border border-[rgba(90,55,20,0.13)] shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold text-[#9A7E65] uppercase tracking-wider">Total Giving (MoMo)</span>
            <div className="p-2 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl">
              <Coins className="w-4 h-4 text-[#B5622A]" />
            </div>
          </div>
          <div className="text-2xl font-bold text-[#1E1208] truncate">
            {formatCurrency(totals.total_giving)}
          </div>
          <span className="text-[11px] text-[#9A7E65] mt-1 block">Reported tithes and offerings</span>
        </div>

        <div className="bg-[#F0E6D3] rounded-2xl p-5 border border-[rgba(90,55,20,0.13)] shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold text-[#9A7E65] uppercase tracking-wider">Active Invites</span>
            <div className="p-2 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl">
              <KeyRound className="w-4 h-4 text-[#B5622A]" />
            </div>
          </div>
          <div className="text-3xl font-bold text-[#1E1208]">
            {invites.length}
          </div>
          <span className="text-[11px] text-[#9A7E65] mt-1 block">Pastor registration codes</span>
        </div>
      </div>

      {/* Tabs Navigation & Action Row */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 border-b border-[rgba(90,55,20,0.1)] pb-4">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('churches')}
            className={`px-5 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all flex items-center gap-2 ${
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
            className={`px-5 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all flex items-center gap-2 ${
              activeTab === 'invites'
                ? 'bg-[#2B1A0E] text-[#F5E6CE] shadow-sm'
                : 'bg-white/60 text-[#6B513E] hover:bg-white'
            }`}
          >
            <KeyRound className="w-4 h-4" />
            <span>Pastor Invites ({invites.length})</span>
          </button>
        </div>

        <div className="flex items-center gap-3">
          {activeTab === 'churches' && (
            <div className="relative flex-1 sm:w-64">
              <Search className="w-4 h-4 text-[#9A7E65] absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search churches or pastors..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3.5 py-2 bg-white/70 border border-[rgba(90,55,20,0.12)] rounded-xl text-xs text-[#1E1208] outline-none focus:border-[#B5622A]"
              />
            </div>
          )}

          {activeTab === 'invites' && (
            <button
              onClick={() => setIsInviteModalOpen(true)}
              className="px-4 py-2.5 bg-[#B5622A] hover:bg-[#C6733B] text-white rounded-xl font-bold text-xs uppercase tracking-wider transition-all shadow-sm flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Generate Invite</span>
            </button>
          )}
        </div>
      </div>

      {/* Tab 1: Member Churches View */}
      {activeTab === 'churches' && (
        <div>
          {filteredChurches.length === 0 ? (
            <div className="bg-[#F0E6D3] rounded-2xl p-12 text-center border border-[rgba(90,55,20,0.12)]">
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
                className="mt-6 px-5 py-2.5 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl text-xs font-bold uppercase tracking-wider hover:bg-[#3D2614] inline-flex items-center gap-2"
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
                      <th className="py-3.5 px-4 font-bold">Church Name</th>
                      <th className="py-3.5 px-4 font-bold">Pastor / Contact</th>
                      <th className="py-3.5 px-4 font-bold">Members</th>
                      <th className="py-3.5 px-4 font-bold">Recent Attendance</th>
                      <th className="py-3.5 px-4 font-bold">Total Giving</th>
                      <th className="py-3.5 px-4 font-bold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[rgba(90,55,20,0.08)]">
                    {filteredChurches.map((church) => (
                      <tr key={church.church_id} className="hover:bg-white/40 transition-colors">
                        <td className="py-4 px-4 font-bold text-[#1E1208]">
                          <div className="flex items-center gap-2">
                            <span>{church.name}</span>
                            <Link
                              href={`/${church.slug}`}
                              target="_blank"
                              title="Open public portal"
                              className="text-[#9A7E65] hover:text-[#B5622A]"
                            >
                              <ExternalLink className="w-3 h-3" />
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
                          <div className="text-[11px] text-[#9A7E65] font-mono">
                            {church.pastor_email || '—'}
                          </div>
                        </td>
                        <td className="py-4 px-4 font-bold text-[#1E1208]">
                          {(church.member_count ?? 0).toLocaleString()}
                        </td>
                        <td className="py-4 px-4 text-[#6B513E]">
                          {church.recent_attendance != null ? church.recent_attendance : '—'}
                        </td>
                        <td className="py-4 px-4 font-semibold text-[#1E1208]">
                          {formatCurrency(church.total_giving)}
                        </td>
                        <td className="py-4 px-4 text-right">
                          <button
                            onClick={() => setDetachingChurch(church)}
                            className="px-3 py-1.5 text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-colors inline-flex items-center gap-1"
                          >
                            <span>Detach</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Invites Management View */}
      {activeTab === 'invites' && (
        <div>
          {invites.length === 0 ? (
            <div className="bg-[#F0E6D3] rounded-2xl p-12 text-center border border-[rgba(90,55,20,0.12)]">
              <KeyRound className="w-12 h-12 text-[#9A7E65] mx-auto mb-3" />
              <h3 style={{ fontFamily: "'Playfair Display', serif" }} className="text-xl font-bold text-[#1E1208]">
                No Invite Codes Active
              </h3>
              <p className="text-xs text-[#9A7E65] max-w-md mx-auto mt-2 leading-relaxed">
                Generate invite codes for pastors to affiliate their independent churches or register new branch congregations with your diocese.
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
                        <span className="px-2.5 py-0.5 bg-[#2B1A0E] text-[#F5E6CE] font-mono font-bold text-xs rounded-lg uppercase tracking-wider">
                          {inv.code}
                        </span>
                        <span className="text-[10px] uppercase font-bold text-[#9A7E65]">
                          {inv.max_uses ? `${inv.uses_count || 0}/${inv.max_uses} uses` : `${inv.uses_count || 0} uses`}
                        </span>
                      </div>

                      <div className="space-y-1 text-xs text-[#6B513E] mt-3">
                        {inv.created_at && (
                          <div className="flex items-center gap-1.5 text-[11px] text-[#9A7E65]">
                            <Calendar className="w-3.5 h-3.5" />
                            <span>Created {new Date(inv.created_at).toLocaleDateString()}</span>
                          </div>
                        )}
                        {inv.expires_at && (
                          <div className="text-[11px] text-amber-700">
                            Expires {new Date(inv.expires_at).toLocaleDateString()}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-5 pt-4 border-t border-[rgba(90,55,20,0.08)] flex items-center justify-between gap-2">
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => handleCopyCode(inv.code)}
                          title="Copy Code"
                          className="px-2.5 py-1.5 bg-white/70 hover:bg-white rounded-lg text-xs font-bold text-[#1E1208] flex items-center gap-1 transition-colors"
                        >
                          {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{isCopied ? 'Copied' : 'Copy'}</span>
                        </button>

                        <button
                          onClick={() => handleCopyInviteLink(inv.code)}
                          title="Copy Direct Signup Link"
                          className="p-1.5 bg-white/70 hover:bg-white rounded-lg text-[#1E1208] transition-colors"
                        >
                          <Link2 className="w-3.5 h-3.5 text-[#B5622A]" />
                        </button>
                      </div>

                      <button
                        onClick={() => handleRevokeInvite(identifier)}
                        title="Revoke Invite"
                        className="p-1.5 text-rose-700 hover:bg-rose-100 rounded-lg transition-colors"
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

      {/* Modal: Create Invite Code */}
      {isInviteModalOpen && (
        <div className="fixed inset-0 bg-[#2B1A0E]/50 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#F0E6D3] rounded-3xl p-8 max-w-md w-full border border-[rgba(90,55,20,0.15)] shadow-2xl">
            <h3 style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208] mb-2">
              Generate Pastor Invite
            </h3>
            <p className="text-xs text-[#9A7E65] leading-relaxed mb-6">
              Create an invite code for pastors to join this denomination network during signup or via their Church Settings.
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
              This will remove this church from your denomination oversight. The church will return to independent status. Their members and donations will remain intact for the local pastor.
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
