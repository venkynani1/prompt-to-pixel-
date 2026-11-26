import QRCode from 'qrcode';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { LeaderRow, StateResponse } from '../../shared/types';
import { MashupReels, SceneImage, SceneWheel, stageOf, TimeBar, useFrameNow } from '../components/show';
import { Countdown, Leaderboard, Notice, Wordmark } from '../components/ui';
import { useEventState } from '../lib';
import { Progress } from './Play';

export function useQr(text: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { QRCode.toDataURL(text, { margin: 1, width: 720, color: { dark: '#15112E', light: '#F3F0FF' } }).then(setUrl); }, [text]);
  return url;
}

export function Projector() {
  const code = (useParams().code ?? '').toUpperCase();
  const pk = useSearchParams()[0].get('pk') ?? undefined;
  const { state, error, offset } = useEventState(code, { pk, keepAliveHidden: true });
  const round = state?.round;
  const live = !!round && !!state && state.event.phase.endsWith('_open');
  const now = useFrameNow(offset, live);
  const joinUrl = `${location.origin}/e/${code}`;
  const qr = useQr(joinUrl);

  if (!state) return <div className="p-16"><Notice kind={error ? 'error' : 'info'}>{error ?? 'Connecting…'}</Notice></div>;
  const { event } = state;
  const st = round ? stageOf(round, now) : null;
  const mystery = state.mystery;
  const sceneKey = mystery ? 'mystery' : `${event.phase}-${round?.turnId ?? ''}-${live ? st?.stage : ''}`;

  return (
    <main className="min-h-screen px-[4vw] py-[3vh] flex flex-col">
      <header className="flex items-center justify-between">
        <Wordmark size="md" />
        <span className="text-2xl text-muted">{event.name}</span>
      </header>
      <AnimatePresence mode="wait">
        <motion.section key={sceneKey} className="flex-1 flex flex-col justify-center py-[3vh]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>

          {mystery && <MysteryScreen mystery={mystery} board={state.leaderboard} />}

          {!mystery && event.phase === 'lobby' && (
            <div className="grid lg:grid-cols-[auto_1fr] items-center gap-[5vw]">
              <div className="grid justify-items-center gap-4">
                {qr && <img src={qr} alt={`QR code to join: ${joinUrl}`} className="w-[min(30vw,480px)] rounded-3xl" />}
                <p className="text-2xl text-muted">Scan, pick a free team number, make up a PIN</p>
              </div>
              <div className="grid gap-6">
                <h1 className="text-[clamp(3rem,6vw,6rem)] font-extrabold">Join the game</h1>
                <p className="display text-7xl font-extrabold rgb-split tabular-nums">{event.teamCount}<span className="font-body text-3xl font-normal text-muted" style={{ textShadow: 'none' }}> teams in</span></p>
                <ul className="flex flex-wrap gap-3">
                  {(state.teams ?? []).map((t, i) => (
                    <li key={i} className={`rounded-xl px-4 py-2 text-xl font-bold transition-colors duration-500 ${t.joined ? 'bg-sub-g text-dusk' : 'bg-panel text-muted'}`}>
                      {t.no ? <span className="tabular-nums mr-2 opacity-70">{t.no}</span> : null}{t.joined ? t.name : 'free'}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {!mystery && live && round && st && (
            <>
              {st.stage === 'spin' && (
                <div className="grid gap-6 justify-items-center">
                  <p className="text-4xl text-muted">{now < new Date(round.spinAt).getTime() ? 'Get ready…' : round.roundNo === 1 ? `Round 1, scene ${round.seq}` : 'Round 2, Movie Mashup'}</p>
                  {round.roundNo === 1 ? <SceneWheel round={round} now={now} size={Math.min(window.innerHeight * 0.68, 720)} /> : <div className="w-full max-w-6xl"><MashupReels round={round} now={now} big /></div>}
                </div>
              )}
              {st.stage === 'preview' && round.roundNo === 1 && (
                <div className="grid gap-4 justify-items-center">
                  <h1 className="text-6xl font-extrabold">{round.title}. Memorise it! <span className="tabular-nums text-sub-r">{Math.ceil(st.msLeft / 1000)}</span></h1>
                  <SceneImage id={round.sceneId!} className="h-[66vh] w-auto shadow-2xl" />
                  <div className="w-[66vh]"><TimeBar msLeft={st.msLeft} totalMs={new Date(round.previewUntil).getTime() - new Date(round.previewFrom).getTime()} color="bg-sub-r" /></div>
                </div>
              )}
              {st.stage === 'preview' && round.roundNo === 2 && (
                <div className="grid gap-8 w-full max-w-6xl mx-auto">
                  <h1 className="text-6xl font-extrabold">Design the poster for this movie</h1>
                  <MashupReels round={round} now={now} big />
                </div>
              )}
              {(st.stage === 'open' || st.stage === 'closed') && (
                <div className="grid gap-8 justify-items-center text-center">
                  <p className="text-4xl text-muted">{round.roundNo === 1 ? 'Recreate it from memory' : 'Design the poster'}</p>
                  <Countdown ms={st.msLeft} big />
                  {round.roundNo === 2 && <div className="w-full max-w-6xl"><MashupReels round={round} now={now} big /></div>}
                  {state.progress && <p className="text-4xl tabular-nums"><b className="display text-6xl">{state.progress.submitted}</b><span className="text-muted"> of {event.teamCount} teams dropped an image</span></p>}
                </div>
              )}
            </>
          )}

          {!mystery && event.phase.endsWith('_judging') && state.progress && (
            <div className="grid gap-12 max-w-5xl">
              <h1 className="text-[clamp(4rem,9vw,9rem)] font-extrabold">The judge is looking.</h1>
              <Progress p={state.progress} big />
            </div>
          )}

          {!mystery && event.phase.endsWith('_results') && round && (
            <div className="grid lg:grid-cols-[1fr_1.1fr] gap-[4vw] items-start">
              <div className="grid gap-5">
                <h1 className="text-5xl font-extrabold">Standings</h1>
                {state.leaderboard ? <Leaderboard rows={state.leaderboard} limit={10} big showRounds={false} /> : <p className="text-muted text-2xl">No scores yet.</p>}
              </div>
              <TopEntries code={code} pk={pk} turnId={round.turnId} sceneId={round.sceneId} concepts={round.concepts} />
            </div>
          )}

          {!mystery && (event.phase === 'final' || event.phase === 'closed') && state.leaderboard && <Podium rows={state.leaderboard} />}
        </motion.section>
      </AnimatePresence>
      {error && <Notice kind="error">{error}</Notice>}
    </main>
  );
}

/** Mystery round: spins paused; points roll in as the host gives them. */
function MysteryScreen({ mystery, board }: { mystery: NonNullable<StateResponse['mystery']>; board: LeaderRow[] | null }) {
  return (
    <div className="grid lg:grid-cols-[1.2fr_1fr] gap-[4vw] items-start">
      <div className="grid gap-6">
        <div className="flex items-end gap-6">
          <motion.span aria-hidden className="display font-extrabold text-sub-b leading-none text-[clamp(8rem,16vw,16rem)]"
            initial={{ rotate: -12, scale: 0.6, opacity: 0 }} animate={{ rotate: 0, scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 120, damping: 12 }}>?</motion.span>
          <div className="pb-[2vh]">
            <h1 className="text-[clamp(3.5rem,7vw,7.5rem)] font-extrabold rgb-split leading-none">Mystery round</h1>
            {mystery.title && <p className="mt-4 text-[clamp(1.8rem,3vw,3rem)] font-bold">{mystery.title}</p>}
          </div>
        </div>
        <ul className="grid gap-3">
          <AnimatePresence initial={false}>
            {mystery.awards.slice(0, 7).map((a) => (
              <motion.li key={a.id} layout initial={{ opacity: 0, x: -40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                className="grid grid-cols-[4ch_1fr_auto] items-baseline gap-4 rounded-2xl bg-panel px-6 py-3 text-4xl">
                <span className="display font-extrabold tabular-nums text-muted">{a.teamNo}</span>
                <span className="font-bold truncate">{a.name}</span>
                <span className={`display font-extrabold tabular-nums ${a.points > 0 ? 'text-sub-g' : 'text-sub-r'}`}>{a.points > 0 ? '+' : ''}{a.points}</span>
              </motion.li>
            ))}
          </AnimatePresence>
          {mystery.awards.length === 0 && <li className="text-3xl text-muted">Points appear here as the host gives them.</li>}
        </ul>
      </div>
      <div className="grid gap-5">
        <h2 className="text-4xl font-extrabold">Standings</h2>
        {board ? <Leaderboard rows={board} limit={8} big showRounds={false} /> : <p className="text-muted text-2xl">No scores yet.</p>}
      </div>
    </div>
  );
}

/** Results: the original scene next to the best three images of this spin. */
function TopEntries({ code, pk, turnId, sceneId, concepts }: { code: string; pk?: string; turnId: string; sceneId: string | null; concepts: string[] }) {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    fetch(`/api/events/${code}/gallery?turn=${turnId}${pk ? `&pk=${encodeURIComponent(pk)}` : ''}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : [])).then((x) => setItems(x.slice(0, 3)));
  }, [code, pk, turnId]);
  return (
    <div className="grid gap-5">
      {sceneId ? (
        <div className="grid grid-cols-[1fr_auto] gap-4 items-end">
          <SceneImage id={sceneId} className="w-full max-h-[34vh] object-contain" />
          <p className="text-2xl text-muted">The scene</p>
        </div>
      ) : <p className="text-3xl display font-bold">{concepts.join(' + ')}</p>}
      <div className="grid grid-cols-3 gap-4">
        {items.map((it, i) => (
          <motion.figure key={it.id} className="grid gap-2" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 + (2 - i) * 0.5 }}>
            <img src={it.imageUrl} alt={`Image by ${it.team}`} className="aspect-square w-full object-cover rounded-xl bg-panel" />
            <figcaption className="flex justify-between gap-2 text-xl"><span className="font-bold truncate">{i + 1}. {it.team}</span><span className="display font-extrabold tabular-nums">{it.score.toFixed(0)}</span></figcaption>
          </motion.figure>
        ))}
      </div>
    </div>
  );
}

function Podium({ rows }: { rows: LeaderRow[] }) {
  const top = rows.slice(0, 3);
  const order = [top[1], top[0], top[2]].filter(Boolean);
  const heights: Record<number, string> = { 1: 'h-[38vh]', 2: 'h-[28vh]', 3: 'h-[20vh]' };
  const colors: Record<number, string> = { 1: 'bg-sub-g', 2: 'bg-sub-b', 3: 'bg-sub-r' };
  return (
    <div className="grid gap-10">
      <h1 className="text-center text-7xl font-extrabold rgb-split">Final standings</h1>
      <div className="flex items-end justify-center gap-[3vw]">
        {order.map((r, i) => (
          <motion.div key={r.teamId} className="flex flex-col items-center gap-4 w-[22vw]"
            initial={{ opacity: 0, y: 60 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: [1.2, 2.4, 0][i], duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}>
            <span className="text-4xl font-bold text-center">{r.name}</span>
            <span className="display text-5xl font-extrabold tabular-nums">{r.total.toFixed(0)}</span>
            <div className={`w-full rounded-t-2xl ${heights[i === 1 ? 1 : i === 0 ? 2 : 3]} ${colors[i === 1 ? 1 : i === 0 ? 2 : 3]} flex items-start justify-center pt-6`}>
              <span className="display text-8xl font-extrabold text-dusk">{r.rank}</span>
            </div>
          </motion.div>
        ))}
      </div>
      {rows.length > 3 && <div className="max-w-4xl w-full mx-auto"><Leaderboard rows={rows.slice(3)} limit={7} /></div>}
    </div>
  );
}
