import QRCode from 'qrcode';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { criteriaFor } from '../../shared/rubrics';
import { phaseRound, type LeaderRow } from '../../shared/types';
import { Countdown, Leaderboard, Notice, Wordmark } from '../components/ui';
import { remainingMs, useEventState, useNow } from '../lib';
import { Concepts, Progress } from './Play';

export function useQr(text: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { QRCode.toDataURL(text, { margin: 1, width: 640, color: { dark: '#15112E', light: '#F3F0FF' } }).then(setUrl); }, [text]);
  return url;
}

export function Projector() {
  const code = (useParams().code ?? '').toUpperCase();
  const pk = useSearchParams()[0].get('pk') ?? undefined;
  const { state, error, offset } = useEventState(code, { pk, keepAliveHidden: true });
  const now = useNow(200);
  const joinUrl = `${location.origin}/e/${code}`;
  const qr = useQr(joinUrl);

  if (!state) return <div className="p-16"><Notice kind={error ? 'error' : 'info'}>{error ?? 'Connecting…'}</Notice></div>;
  const { event, round } = state;
  const left = remainingMs(round?.deadlineAt, offset, now);
  const rn = phaseRound(event.phase);

  return (
    <main className="min-h-screen px-[5vw] py-[4vh] flex flex-col">
      <header className="flex items-center justify-between">
        <Wordmark size="md" />
        <span className="text-2xl text-muted">{event.name}</span>
      </header>
      <AnimatePresence mode="wait">
        <motion.section key={event.phase} className="flex-1 flex flex-col justify-center py-[4vh]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }}>

          {event.phase === 'lobby' && (
            <div className="grid md:grid-cols-[1fr_auto] items-center gap-[6vw]">
              <div className="grid gap-6">
                <h1 className="text-[clamp(3rem,7vw,7rem)] font-extrabold">Scan to register your team.</h1>
                <p className="text-3xl text-muted">or go to <b className="text-paper">{joinUrl.replace(/^https?:\/\//, '')}</b></p>
                <p className="display text-[clamp(4rem,10vw,9rem)] font-extrabold rgb-split tabular-nums">{event.teamCount} <span className="font-body text-4xl font-normal tracking-normal text-muted" style={{ textShadow: "none" }}>teams registered</span></p>
              </div>
              {qr && <img src={qr} alt={`QR code for ${joinUrl}`} className="w-[min(32vw,520px)] rounded-3xl" />}
            </div>
          )}

          {(event.phase === 'r1_brief' || event.phase === 'r2_brief') && round && (
            <div className="grid gap-10 max-w-6xl">
              <p className="text-3xl text-muted">Round {round.roundNo}</p>
              <h1 className="text-[clamp(5rem,13vw,12rem)] font-extrabold rgb-split">{round.title}</h1>
              <p className="text-4xl max-w-[34ch]">{round.brief}</p>
              <ul className="flex flex-wrap gap-x-10 gap-y-3 text-2xl text-muted">
                {criteriaFor(round.roundNo).map((c) => <li key={c.key}><b className="text-paper tabular-nums">{c.weight}</b> {c.label}</li>)}
              </ul>
            </div>
          )}

          {(event.phase === 'r1_open' || event.phase === 'r2_open') && round && (
            <div className={`grid items-center gap-[5vw] ${round.roundNo === 1 ? 'lg:grid-cols-[1fr_1fr]' : ''}`}>
              <div className="grid gap-4 text-center lg:text-left">
                <p className="text-3xl text-muted">{round.title}</p>
                <Countdown ms={left} big />
                {state.progress && <p className="text-3xl text-muted tabular-nums">{state.progress.submitted} of {event.teamCount} teams submitted</p>}
              </div>
              {round.roundNo === 1 && round.referenceImageUrl && <img src={round.referenceImageUrl} alt="Reference image" className="max-h-[70vh] w-full object-contain rounded-2xl" />}
              {round.roundNo === 2 && <Concepts concepts={round.concepts} big />}
            </div>
          )}

          {(event.phase === 'r1_judging' || event.phase === 'r2_judging') && state.progress && (
            <div className="grid gap-12 max-w-5xl">
              <h1 className="text-[clamp(4rem,10vw,10rem)] font-extrabold">The judge is looking.</h1>
              <Progress p={state.progress} big />
            </div>
          )}

          {(event.phase === 'r1_results' || event.phase === 'r2_results') && state.leaderboard && (
            <div className="grid lg:grid-cols-[1.1fr_1fr] gap-[4vw] items-start">
              <div className="grid gap-6">
                <h1 className="text-6xl font-extrabold">Round {rn} standings</h1>
                <Leaderboard rows={state.leaderboard} limit={10} big />
              </div>
              <GalleryReel code={code} pk={pk} roundNo={rn as 1 | 2} />
            </div>
          )}

          {(event.phase === 'final' || event.phase === 'closed') && state.leaderboard && <Podium rows={state.leaderboard} />}
        </motion.section>
      </AnimatePresence>
      {error && <Notice kind="error">{error}</Notice>}
    </main>
  );
}

function GalleryReel({ code, pk, roundNo }: { code: string; pk?: string; roundNo: 1 | 2 }) {
  const [items, setItems] = useState<any[]>([]);
  const [i, setI] = useState(0);
  useEffect(() => {
    fetch(`/api/events/${code}/gallery?round=${roundNo}${pk ? `&pk=${encodeURIComponent(pk)}` : ''}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : [])).then((x) => setItems(x.slice(0, 12)));
  }, [code, pk, roundNo]);
  useEffect(() => { if (items.length < 2) return; const t = setInterval(() => setI((n) => (n + 1) % items.length), 7000); return () => clearInterval(t); }, [items.length]);
  const it = items[i];
  if (!it) return null;
  return (
    <AnimatePresence mode="wait">
      <motion.figure key={it.id} className="grid gap-4" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.6 }}>
        <img src={it.imageUrl} alt={`Entry by ${it.team}`} className="max-h-[58vh] w-full object-contain rounded-2xl bg-panel" />
        <figcaption className="flex items-baseline justify-between gap-6">
          <span className="text-3xl font-bold">{it.team}</span>
          <span className="display text-5xl font-extrabold rgb-split tabular-nums">{it.score.toFixed(1)}</span>
        </figcaption>
        {it.prompt && <p className="text-xl text-muted line-clamp-2">“{it.prompt}”</p>}
      </motion.figure>
    </AnimatePresence>
  );
}

function Podium({ rows }: { rows: LeaderRow[] }) {
  const top = rows.slice(0, 3);
  const order = [top[1], top[0], top[2]].filter(Boolean);
  const heights: Record<number, string> = { 1: 'h-[40vh]', 2: 'h-[30vh]', 3: 'h-[22vh]' };
  const colors: Record<number, string> = { 1: 'bg-sub-g', 2: 'bg-sub-b', 3: 'bg-sub-r' };
  return (
    <div className="grid gap-10">
      <h1 className="text-center text-7xl font-extrabold rgb-split">Final standings</h1>
      <div className="flex items-end justify-center gap-[3vw]">
        {order.map((r, i) => (
          <motion.div key={r.teamId} className="flex flex-col items-center gap-4 w-[22vw]"
            initial={{ opacity: 0, y: 60 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: [1.2, 2.4, 0][i], duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}>
            <span className="text-4xl font-bold text-center">{r.name}</span>
            <span className="display text-5xl font-extrabold tabular-nums">{r.total.toFixed(1)}</span>
            <div className={`w-full rounded-t-2xl ${heights[r.rank] ?? 'h-[18vh]'} ${colors[r.rank] ?? 'bg-panel'} flex items-start justify-center pt-6`}>
              <span className="display text-8xl font-extrabold text-dusk">{r.rank}</span>
            </div>
          </motion.div>
        ))}
      </div>
      {rows.length > 3 && <div className="max-w-4xl w-full mx-auto"><Leaderboard rows={rows.slice(3)} limit={7} /></div>}
    </div>
  );
}
