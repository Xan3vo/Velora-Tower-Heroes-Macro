import React, { useState, useEffect, useRef } from 'react';

const TOWER_POSITIONS = [
  { x: -200, y: -60,  size: 32, delay: 0    },
  { x:  200, y: -60,  size: 28, delay: 0.15 },
  { x: -150, y:  80,  size: 24, delay: 0.30 },
  { x:  150, y:  80,  size: 24, delay: 0.45 },
  { x:    0, y: -130, size: 20, delay: 0.60 },
];

const TowerSVG = ({ size, opacity, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ opacity, ...style }}>
    <rect x="9"  y="14" width="6"  height="10" rx="0.8" fill="#7ca3ff" />
    <rect x="7"  y="8"  width="10" height="7"  rx="0.8" fill="#8fb2ff" />
    <rect x="5"  y="3"  width="14" height="6"  rx="0.8" fill="#a3c0ff" />
    <rect x="10" y="1"  width="4"  height="3"  rx="0.5" fill="#bdd0ff" />
    <rect x="5"  y="5"  width="2"  height="4"  rx="0.3" fill="#5a85e8" />
    <rect x="17" y="5"  width="2"  height="4"  rx="0.3" fill="#5a85e8" />
    <rect x="10" y="10" width="4"  height="3"  rx="0.3" fill="#4a73d4" />
  </svg>
);

function usePhase(schedule) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const timers = schedule.map((ms, i) => setTimeout(() => setPhase(i + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, []);
  return phase;
}

export default function Intro({ onDone }) {
  // 0=init 1=portal-open 2=towers-visible 3=towers-absorb 4=logo-emerge 5=tagline 6=exit
  const phase = usePhase([200, 600, 1800, 2800, 3600, 5200]);
  useEffect(() => {
    const t = setTimeout(onDone, 6200);
    return () => clearTimeout(t);
  }, []);

  const p1 = phase >= 1;
  const p2 = phase >= 2;
  const p3 = phase >= 3;
  const p4 = phase >= 4;
  const p5 = phase >= 5;
  const p6 = phase >= 6;

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: '#07090f',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999, overflow: 'hidden',
      opacity: p6 ? 0 : 1,
      transition: p6 ? 'opacity 1s ease' : 'none',
    }}>
      <style>{`
        @keyframes spark-float {
          0%   { transform: translate(0, 0) scale(1);   opacity: 0.9; }
          100% { transform: translate(var(--sx), var(--sy)) scale(0); opacity: 0; }
        }
        @keyframes vortex-spin {
          to { transform: rotate(360deg); }
        }
        @keyframes gate-shimmer {
          0%,100% { opacity: 0.6; }
          50%     { opacity: 1;   }
        }
        @keyframes logo-breathe {
          0%,100% { text-shadow: 0 0 30px rgba(100,150,255,0.5), 0 0 80px rgba(70,110,240,0.25); }
          50%     { text-shadow: 0 0 60px rgba(130,180,255,0.9), 0 0 140px rgba(80,130,255,0.45); }
        }
        @keyframes tower-drift {
          0%,100% { transform: translate(-50%,-50%) translateY(0px); }
          50%     { transform: translate(-50%,-50%) translateY(-6px); }
        }
      `}</style>

      {/* ── Deep background glow ── */}
      <div style={{
        position: 'absolute', width: 600, height: 600, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(50,90,220,0.14) 0%, transparent 65%)',
        opacity: p1 ? 1 : 0, transition: 'opacity 2s ease',
      }} />

      {/* ── Portal gate arch (two vertical pillars + top arc) ── */}
      <svg
        width="260" height="280"
        viewBox="0 0 260 280"
        style={{
          position: 'absolute',
          opacity: p1 ? 1 : 0,
          transform: p1 ? 'scaleY(1)' : 'scaleY(0)',
          transformOrigin: 'bottom center',
          transition: 'opacity 0.8s ease, transform 0.8s cubic-bezier(0.34,1.4,0.64,1)',
          filter: 'drop-shadow(0 0 18px rgba(80,130,255,0.7))',
          animation: p1 ? 'gate-shimmer 2.5s ease-in-out infinite' : 'none',
        }}
      >
        {/* Left pillar */}
        <rect x="18" y="60" width="16" height="200" rx="4" fill="url(#pillarGrad)" />
        {/* Right pillar */}
        <rect x="226" y="60" width="16" height="200" rx="4" fill="url(#pillarGrad)" />
        {/* Top arch */}
        <path d="M18 80 Q18 10 130 10 Q242 10 242 80" stroke="url(#archGrad)" strokeWidth="5" fill="none" strokeLinecap="round" />
        {/* Inner arch glow */}
        <path d="M30 85 Q30 28 130 28 Q230 28 230 85" stroke="rgba(120,170,255,0.3)" strokeWidth="2" fill="none" strokeLinecap="round" />
        {/* Portal interior fill */}
        <path d="M34 260 L34 85 Q34 40 130 40 Q226 40 226 85 L226 260 Z"
          fill="url(#portalFill)" opacity={p1 ? 0.85 : 0}
          style={{ transition: 'opacity 1s ease 0.3s' }} />
        {/* Pillar rune marks */}
        {[90,120,150,180].map(y => (
          <g key={y}>
            <rect x="21" y={y} width="10" height="2" rx="1" fill="rgba(150,190,255,0.6)" />
            <rect x="229" y={y} width="10" height="2" rx="1" fill="rgba(150,190,255,0.6)" />
          </g>
        ))}
        <defs>
          <linearGradient id="pillarGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#7ab0ff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#2a4db0" stopOpacity="0.7" />
          </linearGradient>
          <linearGradient id="archGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"   stopColor="#4a80ff" />
            <stop offset="50%"  stopColor="#9fc0ff" />
            <stop offset="100%" stopColor="#4a80ff" />
          </linearGradient>
          <radialGradient id="portalFill" cx="50%" cy="40%" r="60%">
            <stop offset="0%"   stopColor="#3060d0" stopOpacity="0.5" />
            <stop offset="60%"  stopColor="#1a35a0" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#050a20" stopOpacity="0.1" />
          </radialGradient>
        </defs>
      </svg>

      {/* ── Vortex energy swirl inside portal ── */}
      <div style={{
        position: 'absolute',
        width: 170, height: 170,
        borderRadius: '50%',
        background: 'conic-gradient(from 0deg, transparent 0%, rgba(60,100,255,0.25) 20%, rgba(100,150,255,0.4) 40%, transparent 60%, rgba(60,100,255,0.2) 80%, transparent 100%)',
        opacity: p1 ? 0.8 : 0,
        transition: 'opacity 1s ease 0.4s',
        animation: p1 ? 'vortex-spin 3s linear infinite' : 'none',
        top: '50%', left: '50%',
        marginTop: -20,
        transform: 'translate(-50%, -50%)',
      }} />
      <div style={{
        position: 'absolute',
        width: 110, height: 110,
        borderRadius: '50%',
        background: 'conic-gradient(from 180deg, transparent 0%, rgba(80,130,255,0.35) 30%, transparent 60%)',
        opacity: p1 ? 0.7 : 0,
        transition: 'opacity 1s ease 0.6s',
        animation: p1 ? 'vortex-spin 1.8s linear infinite reverse' : 'none',
        top: '50%', left: '50%',
        marginTop: -20,
        transform: 'translate(-50%, -50%)',
      }} />

      {/* ── Tower silhouettes ── */}
      {TOWER_POSITIONS.map((t, i) => (
        <div key={i} style={{
          position: 'absolute',
          left: `calc(50% + ${t.x}px)`,
          top: `calc(50% + ${t.y}px)`,
          transform: p3
            ? `translate(-50%, -50%) scale(0) translate(${-t.x * 0.5}px, ${-t.y * 0.5}px)`
            : 'translate(-50%, -50%) scale(1)',
          opacity: p3 ? 0 : p2 ? 0.85 : 0,
          transition: p3
            ? `opacity 0.5s ease ${t.delay}s, transform 0.6s ease ${t.delay}s`
            : `opacity 0.5s ease ${t.delay + 0.1}s`,
          animation: p2 && !p3 ? `tower-drift ${2 + i * 0.3}s ease-in-out infinite` : 'none',
          filter: 'drop-shadow(0 0 8px rgba(80,130,255,0.6))',
        }}>
          <TowerSVG size={t.size} opacity={1} />
        </div>
      ))}

      {/* ── Spark particles flying into portal when towers absorb ── */}
      {p3 && !p4 && Array.from({ length: 16 }).map((_, i) => {
        const angle = (360 / 16) * i;
        const rad = (angle * Math.PI) / 180;
        const dist = 120 + Math.random() * 60;
        return (
          <div key={i} style={{
            position: 'absolute',
            left: '50%', top: '50%',
            width: 3, height: 3,
            borderRadius: '50%',
            background: '#8ab4ff',
            boxShadow: '0 0 6px 2px rgba(100,150,255,0.8)',
            '--sx': `${Math.cos(rad) * -dist}px`,
            '--sy': `${Math.sin(rad) * -dist}px`,
            animation: `spark-float 0.7s ${(i * 0.04)}s ease-in forwards`,
            marginLeft: `${Math.cos(rad) * dist - 1.5}px`,
            marginTop: `${Math.sin(rad) * dist - 1.5}px`,
          }} />
        );
      })}

      {/* ── VELORA logo + tagline ── */}
      <div style={{
        position: 'absolute',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 10,
        opacity: p4 ? 1 : 0,
        transform: p4 ? 'translateY(0) scale(1)' : 'translateY(16px) scale(0.9)',
        transition: 'opacity 1s ease, transform 1s cubic-bezier(0.25,1,0.5,1)',
        top: '50%', left: '50%',
        marginTop: -16,
        translate: '-50% -50%',
      }}>
        {/* Glow bolt */}
        <svg width="26" height="26" viewBox="0 0 24 24" fill="#6fa3ff"
          style={{ filter: 'drop-shadow(0 0 12px rgba(80,140,255,1))' }}>
          <polygon points="13,2 3,14 12,14 11,22 21,10 12,10"/>
        </svg>

        {/* Name */}
        <div style={{
          fontSize: 38,
          fontWeight: 800,
          letterSpacing: '0.3em',
          color: '#eef3ff',
          fontFamily: 'Segoe UI, system-ui, sans-serif',
          textTransform: 'uppercase',
          animation: p4 ? 'logo-breathe 2.5s ease-in-out infinite' : 'none',
        }}>
          Velora
        </div>

        {/* Expanding line */}
        <div style={{
          width: p5 ? 190 : 0,
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(110,163,255,0.8), transparent)',
          transition: 'width 0.9s ease',
          borderRadius: 1,
        }} />

        {/* Tagline */}
        <div style={{
          fontSize: 11,
          fontWeight: 400,
          letterSpacing: '0.2em',
          color: 'rgba(160,190,255,0.7)',
          fontFamily: 'Segoe UI, system-ui, sans-serif',
          textTransform: 'uppercase',
          opacity: p5 ? 1 : 0,
          transform: p5 ? 'translateY(0)' : 'translateY(8px)',
          transition: 'opacity 0.9s ease, transform 0.9s ease',
          whiteSpace: 'nowrap',
        }}>
          Step into automated victory.
        </div>
      </div>

    </div>
  );
}