import { useEffect, useRef, useState } from 'react';
import { MASHUP_REELS, REEL_LABEL, ROUND1_SCENES, sceneUrl, type ReelKey } from '../../shared/bank';
import type { PublicRound } from '../../shared/types';

export type Stage = 'spin' | 'preview' | 'open' | 'closed';

/** Where a spin is on its server timeline (now = server-corrected ms). */
export function stageOf(r: PublicRound, now: number): { stage: Stage; msLeft: number } {
  const t = (s: string) => new Date(s).getTime();
  if (now < t(r.previewFrom)) return { stage: 'spin', msLeft: t(r.previewFrom) - now };
  if (now < t(r.previewUntil)) return { stage: 'preview', msLeft: t(r.previewUntil) - now };
  if (now < t(r.deadlineAt)) return { stage: 'open', msLeft: t(r.deadlineAt) - now };
  return { stage: 'closed', msLeft: 0 };
}

/** Server-synced animation clock (re-renders every frame while active). */
export function useFrameNow(offset: number, active: boolean) {
  const [now, setNow] = useState(Date.now() + offset);
  const raf = useRef(0);
  useEffect(() => {
    if (!active) { setNow(Date.now() + offset); return; }
    const tick = () => { setNow(Date.now() + offset); raf.current = requestAnimationFrame(tick); };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [offset, active]);
  return now;
}

const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3.2);

/** The prize wheel: 12 scene thumbnails; lands on the chosen scene exactly when the server says. */
export function SceneWheel({ round, now, size = 520 }: { round: PublicRound; now: number; size?: number }) {
  const n = ROUND1_SCENES.length;
  const target = Math.max(0, ROUND1_SCENES.findIndex((s) => s.id === round.sceneId));
  const start = new Date(round.spinAt).getTime(), end = new Date(round.previewFrom).getTime();
  const p = easeOut((now - start) / Math.max(1, end - start));
  const finalAngle = 360 * 6 + (360 - target * (360 / n));
  const angle = finalAngle * p;
  const R = size / 2, thumb = size * 0.17;
  return (
    <div className="relative mx-auto" style={{ width: size, height: size }} aria-label="Spinning wheel">
      <div className="absolute left-1/2 -top-3 z-10 -translate-x-1/2 h-0 w-0 border-x-[18px] border-t-[34px] border-x-transparent border-t-paper drop-shadow" />
      <svg width={size} height={size} style={{ transform: `rotate(${angle}deg)` }}>
        <defs>{ROUND1_SCENES.map((s, i) => <clipPath key={s.id} id={`c${i}`}><circle r={thumb / 2} /></clipPath>)}</defs>
        <circle cx={R} cy={R} r={R - 4} fill="#211B45" stroke="#3A3270" strokeWidth={8} />
        {ROUND1_SCENES.map((s, i) => {
          const a0 = (i - 0.5) * (360 / n) - 90, a1 = (i + 0.5) * (360 / n) - 90;
          const pt = (a: number, r: number) => [R + r * Math.cos((a * Math.PI) / 180), R + r * Math.sin((a * Math.PI) / 180)];
          const [x0, y0] = pt(a0, R - 8), [x1, y1] = pt(a1, R - 8);
          const [cx, cy] = pt((a0 + a1) / 2, R * 0.68);
          const fill = ['#FF5468', '#3FE3A6', '#5A86FF'][i % 3];
          return (
            <g key={s.id}>
              <path d={`M${R} ${R} L${x0} ${y0} A${R - 8} ${R - 8} 0 0 1 ${x1} ${y1}Z`} fill={fill} opacity={0.22} stroke="#15112E" strokeWidth={3} />
              <g transform={`translate(${cx} ${cy}) rotate(${(a0 + a1) / 2 + 90})`}>
                <image href={sceneUrl(s.id, 'thumb')} x={-thumb / 2} y={-thumb / 2} width={thumb} height={thumb} clipPath={`url(#c${i})`} preserveAspectRatio="xMidYMid slice" />
                <circle r={thumb / 2} fill="none" stroke="#F3F0FF" strokeWidth={3} />
              </g>
            </g>
          );
        })}
        <circle cx={R} cy={R} r={size * 0.1} fill="#15112E" stroke="#F3F0FF" strokeWidth={4} />
      </svg>
    </div>
  );
}

/** Round 2: three slot reels (genre / hero / setting) that stop one after another. */
export function MashupReels({ round, now, big = false }: { round: PublicRound; now: number; big?: boolean }) {
  const start = new Date(round.spinAt).getTime(), end = new Date(round.previewFrom).getTime();
  const span = Math.max(1, end - start);
  const keys: ReelKey[] = ['genre', 'hero', 'setting'];
  const colors = ['text-sub-r', 'text-sub-g', 'text-sub-b'];
  return (
    <div className={`grid gap-4 ${big ? 'md:grid-cols-3 gap-6' : ''}`}>
      {keys.map((k, j) => {
        const stopAt = start + span * (0.45 + 0.27 * j);
        const list = MASHUP_REELS[k];
        const spinning = now < stopAt;
        const k2 = Math.floor(Math.max(0, now - start) / 90) + j * 3;
        const text = now < start ? '?' : spinning ? list[k2 % list.length] : round.concepts[j];
        return (
          <div key={k} className={`rounded-2xl bg-panel ${big ? 'p-8 min-h-48' : 'p-4'} ${spinning ? '' : 'ring-2 ring-paper/70'}`}>
            <p className={`display font-extrabold ${colors[j]} ${big ? 'text-3xl' : 'text-base'}`}>{REEL_LABEL[k]}</p>
            <p className={`display font-bold ${big ? 'text-5xl mt-3' : 'text-2xl'} ${spinning ? 'opacity-60 blur-[1px]' : ''}`}>{text}</p>
          </div>
        );
      })}
    </div>
  );
}

export function SceneImage({ id, className = '' }: { id: string; className?: string }) {
  return <img src={sceneUrl(id, 'full')} alt="The scene to recreate" className={`rounded-2xl ${className}`} />;
}

/** Thin progress bar that empties as time runs out. */
export function TimeBar({ msLeft, totalMs, color = 'bg-sub-g' }: { msLeft: number; totalMs: number; color?: string }) {
  return (
    <div className="h-2 w-full rounded-full bg-panel overflow-hidden">
      <div className={`h-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, (msLeft / Math.max(1, totalMs)) * 100))}%` }} />
    </div>
  );
}
