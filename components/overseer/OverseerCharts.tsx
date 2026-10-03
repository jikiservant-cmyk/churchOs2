'use client';

import { useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  PieChart,
  Pie,
  LineChart,
  Line,
} from 'recharts';

interface OverseerChartsProps {
  churchAttendanceData: { name: string; attendance: number; members: number }[];
  givingByChurchData: { name: string; giving: number }[];
  sizeDistributionData: { name: string; value: number; color: string }[];
}

export default function OverseerCharts({
  churchAttendanceData,
  givingByChurchData,
  sizeDistributionData,
}: OverseerChartsProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
        <div className="h-[280px] bg-[#F0E6D3] rounded-2xl animate-pulse border border-[rgba(90,55,20,0.13)]" />
        <div className="h-[280px] bg-[#F0E6D3] rounded-2xl animate-pulse border border-[rgba(90,55,20,0.13)]" />
      </div>
    );
  }

  const formatCurrencyShort = (value: number) => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
    return `${value}`;
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
      {/* Chart 1: Church Attendance & Membership Comparison */}
      <div className="bg-[#F0E6D3] border border-[rgba(90,55,20,0.13)] rounded-2xl p-6 shadow-sm flex flex-col justify-between">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h4 style={{ fontFamily: "'Playfair Display', serif" }} className="text-base font-bold text-[#1E1208]">
              Parish Vitality & Attendance
            </h4>
            <p className="text-[11px] text-[#9A7E65]">Recent service attendance vs total membership</p>
          </div>
          <span className="px-2.5 py-1 bg-[#2B1A0E] text-[#F5E6CE] text-[10px] font-bold uppercase tracking-wider rounded-lg">
            Active Branches
          </span>
        </div>

        <div className="w-full h-[220px]" style={{ minWidth: 0 }}>
          {churchAttendanceData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-[#9A7E65]">
              No church attendance records available yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={churchAttendanceData} margin={{ top: 10, right: 10, left: -20, bottom: 20 }}>
                <XAxis 
                  dataKey="name" 
                  tick={{ fill: '#7A4F30', fontSize: 10 }}
                  axisLine={{ stroke: 'rgba(90,55,20,0.15)' }}
                  tickLine={false}
                  interval={0}
                  angle={-15}
                  textAnchor="end"
                />
                <YAxis 
                  tick={{ fill: '#7A4F30', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: '#2B1A0E', 
                    borderRadius: '12px', 
                    border: 'none', 
                    color: '#F5E6CE',
                    fontSize: '11px',
                    fontFamily: "'Outfit', sans-serif"
                  }}
                  formatter={(value: any, name: any) => [
                    value, 
                    name === 'attendance' ? 'Recent Attendance' : 'Total Members'
                  ]}
                />
                <Bar dataKey="members" fill="#2B1A0E" radius={[4, 4, 0, 0]} name="members" />
                <Bar dataKey="attendance" fill="#B5622A" radius={[4, 4, 0, 0]} name="attendance" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="flex items-center justify-center gap-6 pt-3 border-t border-[rgba(90,55,20,0.08)] text-[11px] font-semibold text-[#6B513E]">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#2B1A0E]" />
            <span>Total Members</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#B5622A]" />
            <span>Recent Attendance</span>
          </div>
        </div>
      </div>

      {/* Chart 2: Giving Distribution by Church */}
      <div className="bg-[#F0E6D3] border border-[rgba(90,55,20,0.13)] rounded-2xl p-6 shadow-sm flex flex-col justify-between">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h4 style={{ fontFamily: "'Playfair Display', serif" }} className="text-base font-bold text-[#1E1208]">
              Regional MoMo Giving (UGX)
            </h4>
            <p className="text-[11px] text-[#9A7E65]">Reported contributions by congregation branch</p>
          </div>
          <span className="px-2.5 py-1 bg-[#B5622A]/10 text-[#B5622A] text-[10px] font-bold uppercase tracking-wider rounded-lg border border-[#B5622A]/20">
            Tithes & Offerings
          </span>
        </div>

        <div className="w-full h-[220px]" style={{ minWidth: 0 }}>
          {givingByChurchData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-[#9A7E65]">
              No giving records reported yet across branches
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={givingByChurchData} margin={{ top: 10, right: 10, left: -10, bottom: 20 }}>
                <XAxis 
                  dataKey="name" 
                  tick={{ fill: '#7A4F30', fontSize: 10 }}
                  axisLine={{ stroke: 'rgba(90,55,20,0.15)' }}
                  tickLine={false}
                  interval={0}
                  angle={-15}
                  textAnchor="end"
                />
                <YAxis 
                  tick={{ fill: '#7A4F30', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={formatCurrencyShort}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: '#2B1A0E', 
                    borderRadius: '12px', 
                    border: 'none', 
                    color: '#F5E6CE',
                    fontSize: '11px',
                    fontFamily: "'Outfit', sans-serif"
                  }}
                  formatter={(val: any) => [`UGX ${Number(val).toLocaleString()}`, 'Reported Giving']}
                />
                <Bar dataKey="giving" fill="#B5622A" radius={[6, 6, 0, 0]}>
                  {givingByChurchData.map((_, index) => (
                    <Cell 
                      key={`cell-${index}`} 
                      fill={index % 2 === 0 ? '#B5622A' : '#7C2D12'} 
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-[rgba(90,55,20,0.08)] text-[11px] text-[#9A7E65]">
          <span>Denomination aggregate transparency</span>
          <span className="font-semibold text-[#1E1208]">Live Mobile Money Ledger</span>
        </div>
      </div>
    </div>
  );
}
