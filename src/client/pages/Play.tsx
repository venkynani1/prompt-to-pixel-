import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { StateResponse } from '../../shared/types';
import { MashupReels, SceneImage, SceneWheel, stageOf, TimeBar, useFrameNow } from '../components/show';
import { Countdown, Leaderboard, Notice, ScoreBreakdown, Shell, StatusPill, Wordmark } from '../components/ui';
import { api, kb, prepareImage, useEventState, type PreparedImage } from '../lib';

export function Play() {
  const code = (useParams().code ?? '').toUpperCase();
  const nav = useNavigate();
  const { state, error, offset, refresh } = useEventState(code);
  const round = state?.round;
  const animating = !!round && !!state && state.event.phase.endsWith('_open') && Date.now() + offset < new Date(round.previewUntil).getTime() + 500;
  const now = useFrameNow(offset, animating);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 250); return () => clearInterval(t); }, []);

  useEffect(() => { if (state && !state.me) nav(`/e/${code}`, { replace: true }); }, [state, code, nav]);
  if (!state?.me) return <Shell><Wordmark size="sm" /><div className="mt-16"><Notice kind={error ? 'error' : 'info'}>{error ?? 'Loading…'}</Notice></div></Shell>;

  const { event, me } = state;
  const phase = event.phase;
  const clockNow = Date.now() + offset;
  const st = round ? stageOf(round, animating ? now : clockNow) : null;

  return (
    <Shell>
      <header className="flex items-center justify-between gap-3">
        <Wordmark size="sm" />
        <span className="text-sm text-muted truncate">{me.teamNo ? `Team ${me.teamNo}` : ''}{me.named && me.teamNo ? `, ${me.name}` : !me.teamNo ? me.name : ''}</span>
      </header>
      {error && <div className="mt-3"><Notice kind="error">{error}</Notice></div>}

      {!me.named && <NameTeam code={code} teamNo={me.teamNo} onDone={refresh} />}

      {me.named && phase === 'lobby' && (
        <section className="mt-10 grid gap-4">
          <h1 className="text-5xl font-extrabold">You're in, {me.name}.</h1>
          <p className="text-muted">{event.teamCount} teams have joined. Keep this page open — it updates by itself.</p>
          <ol className="grid gap-3 mt-4">
            {['Watch the big screen: a wheel picks a movie scene.', 'It shows for a few seconds — memorise it!', 'Recreate it from memory with any AI image generator.', 'Drop your best image here before the timer ends. The AI judge scores it.'].map((t, i) => (
              <li key={i} className="grid grid-cols-[2rem_1fr] gap-2"><span className="display font-extrabold text-sub-g">{i + 1}</span><span>{t}</span></li>
            ))}
          </ol>
        </section>
      )}

      {me.named && round && phase.endsWith('_open') && st && (
        <section className="mt-8 grid gap-6">
          <p className="text-muted">{round.roundNo === 1 ? `Round 1, scene ${round.seq}` : `Round 2, ${round.title}`}</p>
          {st.stage === 'spin' && (round.roundNo === 1
            ? <><h1 className="text-4xl font-extrabold">{now < new Date(round.spinAt).getTime() ? 'Get ready…' : 'Look at the big screen!'}</h1><SceneWheel round={round} now={now} size={300} /></>
            : <><h1 className="text-4xl font-extrabold">Spinning your movie…</h1><MashupReels round={round} now={now} /></>)}
          {st.stage === 'preview' && round.roundNo === 1 && (
            <>
              <h1 className="text-4xl font-extrabold">Memorise it! <span className="tabular-nums text-sub-r">{Math.ceil(st.msLeft / 1000)}</span></h1>
              <SceneImage id={round.sceneId!} className="w-full" />
              <TimeBar msLeft={st.msLeft} totalMs={new Date(round.previewUntil).getTime() - new Date(round.previewFrom).getTime()} color="bg-sub-r" />
            </>
          )}
          {st.stage === 'preview' && round.roundNo === 2 && <><h1 className="text-4xl font-extrabold">Your movie</h1><MashupReels round={round} now={now} /></>}
          {st.stage === 'open' && (
            <>
              <Countdown ms={st.msLeft} />
              {round.roundNo === 1
                ? <p className="text-muted">Recreate the scene <b className="text-paper">from memory</b> and drop your best image.</p>
                : <><p className="text-muted">Design the poster for this movie:</p><MashupReels round={round} now={clockNow} /></>}
              <Uploader code={code} existing={!!me.current} onDone={refresh} />
              {me.current && <MySubmission s={me.current} />}
            </>
          )}
          {st.stage === 'closed' && <h1 className="text-4xl font-extrabold">Time's up!</h1>}
        </section>
      )}

      {me.named && phase.endsWith('_judging') && (
        <section className="mt-10 grid gap-5">
          <h1 className="text-5xl font-extrabold">The judge is looking.</h1>
          {state.progress && <Progress p={state.progress} />}
          {me.current ? <MySubmission s={me.current} /> : <p className="text-muted">No image from your team this time.</p>}
          <p className="text-muted">Scores appear when the host reveals them.</p>
        </section>
      )}

      {me.named && phase.endsWith('_results') && (
        <section className="mt-10 grid gap-6">
          {me.current?.score != null ? (
            <>
              <div>
                <p className="text-muted">This {round?.roundNo === 1 ? 'scene' : 'mashup'}</p>
                <p className="display text-8xl font-extrabold rgb-split">{me.current.score.toFixed(0)}</p>
              </div>
              {me.current.criteria && <ScoreBreakdown roundNo={me.current.roundNo} criteria={me.current.criteria} />}
              {me.current.feedback && <blockquote className="border-l-4 border-sub-b pl-4 text-muted">{me.current.feedback}</blockquote>}
            </>
          ) : <h1 className="text-4xl font-extrabold">{me.current ? 'Your image is still with the judge.' : 'No image from your team this time.'}</h1>}
          <p className="text-xl">Total <b className="display text-3xl">{me.total.toFixed(0)}</b>{me.rank ? <span className="text-muted">, place #{me.rank}</span> : null}</p>
          {round?.roundNo === 1 && round.sceneId && <figure className="grid gap-2"><figcaption className="text-sm text-muted">The scene was:</figcaption><SceneImage id={round.sceneId} className="w-full" /></figure>}
          <p className="text-muted">Get ready — the next spin can start any moment.</p>
        </section>
      )}

      {me.named && (phase === 'final' || phase === 'closed') && state.leaderboard && (
        <section className="mt-10 grid gap-6">
          <div><p className="text-muted">Final place</p><p className="display text-9xl font-extrabold rgb-split">#{me.rank ?? '–'}</p><p className="text-xl">{me.total.toFixed(0)} points</p></div>
          <Leaderboard rows={state.leaderboard} highlight={me.teamId} limit={10} showRounds={false} />
          <Link to={`/e/${code}/gallery`} className="btn btn-ghost">Open the Pixel Gallery</Link>
        </section>
      )}
    </Shell>
  );
}

function NameTeam({ code, teamNo, onDone }: { code: string; teamNo: number | null; onDone: () => void }) {
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form className="mt-10 grid gap-4" onSubmit={async (e) => {
      e.preventDefault(); setMsg(null);
      try { await api(`/api/events/${code}/team-name`, { method: 'POST', json: { name } }); onDone(); }
      catch (err) { setMsg((err as Error).message); }
    }}>
      <h1 className="text-4xl font-extrabold">Name your team</h1>
      <p className="text-muted">It shows on the big screen and the leaderboard.</p>
      <input className="field text-xl" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. Team ${teamNo ?? ''} Avengers`} autoFocus />
      {msg && <Notice kind="error">{msg}</Notice>}
      <button className="btn" disabled={name.trim().length < 2}>Save name</button>
    </form>
  );
}

function Uploader({ code, existing, onDone }: { code: string; existing: boolean; onDone: () => void }) {
  const [prep, setPrep] = useState<PreparedImage | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<'prep' | 'send' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function choose(f: File | undefined) {
    if (!f) return;
    setBusy('prep'); setMsg(null);
    try { setPrep(await prepareImage(f)); } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); } finally { setBusy(null); }
  }
  async function send() {
    if (!prep) return;
    setBusy('send'); setMsg(null);
    const fd = new FormData();
    const ext = (b: Blob) => (b.type === 'image/webp' ? 'webp' : 'jpg');
    fd.set('full', prep.full, `full.${ext(prep.full)}`);
    fd.set('judge', prep.judge, 'judge.jpg');
    fd.set('thumb', prep.thumb, `thumb.${ext(prep.thumb)}`);
    fd.set('dhash', prep.dhash); fd.set('width', String(prep.width)); fd.set('height', String(prep.height));
    if (prompt.trim()) fd.set('prompt', prompt.trim());
    try {
      await api(`/api/events/${code}/submit`, { method: 'POST', body: fd });
      setMsg({ kind: 'ok', text: 'Dropped! The judge is on it.' });
      setPrep(null); setPrompt('');
      onDone();
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); } finally { setBusy(null); }
  }

  return (
    <div className="grid gap-4 rounded-2xl bg-panel p-4">
      <h2 className="text-xl font-bold">{existing ? 'Replace your image' : 'Drop your image'}</h2>
      <input ref={input} type="file" accept="image/*" className="sr-only" onChange={(e) => choose(e.target.files?.[0])} />
      {prep ? (
        <figure className="grid gap-2">
          <img src={prep.previewUrl} alt="Your chosen image" className="w-full rounded-xl" />
          <figcaption className="text-sm text-muted">Ready to send, {kb(prep.full.size)}</figcaption>
        </figure>
      ) : (
        <button className="btn btn-ghost min-h-32 border-2 border-dashed border-line" onClick={() => input.current?.click()} disabled={!!busy}>
          {busy === 'prep' ? 'Preparing image…' : 'Choose image'}
        </button>
      )}
      <textarea className="field min-h-20" maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Your prompt (optional, shown in the gallery — the judge never sees it)" />
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="grid grid-cols-[auto_1fr] gap-3">
        {prep && <button className="btn btn-ghost" onClick={() => input.current?.click()} disabled={!!busy}>Change</button>}
        <button className="btn col-start-2" onClick={send} disabled={!prep || !!busy}>{busy === 'send' ? 'Sending…' : existing ? 'Replace image' : 'Drop image'}</button>
      </div>
    </div>
  );
}

function MySubmission({ s }: { s: NonNullable<NonNullable<StateResponse['me']>['current']> }) {
  return (
    <div className="grid grid-cols-[5rem_1fr] items-center gap-4 rounded-xl bg-panel p-3">
      <img src={s.thumbUrl} alt="Your image" className="aspect-square w-20 rounded-lg object-cover" />
      <div><p className="font-bold">Your image</p><StatusPill status={s.status} /></div>
    </div>
  );
}

export function Progress({ p, big = false }: { p: NonNullable<StateResponse['progress']>; big?: boolean }) {
  const pct = p.submitted ? Math.round((p.scored / p.submitted) * 100) : 0;
  return (
    <div className="grid gap-2">
      <div className={`${big ? 'h-6' : 'h-3'} rounded-full bg-panel overflow-hidden`}>
        <div className="h-full bg-gradient-to-r from-sub-r via-sub-g to-sub-b transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
      <p className={`${big ? 'text-3xl' : 'text-sm'} text-muted tabular-nums`}>{p.scored} of {p.submitted} images judged{p.failed ? `, ${p.failed} need a retry` : ''}</p>
    </div>
  );
}
