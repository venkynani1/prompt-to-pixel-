import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { criteriaFor } from '../../shared/rubrics';
import { PHASE_LABEL, phaseRound, type StateResponse } from '../../shared/types';
import { Countdown, Leaderboard, Notice, ScoreBreakdown, Shell, StatusPill, Wordmark } from '../components/ui';
import { api, kb, prepareImage, remainingMs, useEventState, useNow, type PreparedImage } from '../lib';

export function Play() {
  const code = (useParams().code ?? '').toUpperCase();
  const nav = useNavigate();
  const { state, error, offset, refresh } = useEventState(code);
  const now = useNow();

  useEffect(() => { if (state && !state.me) nav(`/e/${code}`, { replace: true }); }, [state, code, nav]);
  if (!state?.me) return <Shell><Wordmark size="sm" /><div className="mt-16"><Notice kind={error ? 'error' : 'info'}>{error ?? 'Loading…'}</Notice></div></Shell>;

  const { event, round, me } = state;
  const rn = phaseRound(event.phase);
  const mine = me.submissions.find((s) => s.roundNo === rn);
  const left = remainingMs(round?.deadlineAt, offset, now);

  return (
    <Shell>
      <header className="flex items-center justify-between gap-3">
        <Wordmark size="sm" />
        <span className="text-sm text-muted truncate">{me.name}</span>
      </header>
      {error && <div className="mt-3"><Notice kind="error">{error}</Notice></div>}
      <p className="mt-8 text-muted">{PHASE_LABEL[event.phase]}</p>

      {event.phase === 'lobby' && (
        <section className="mt-2 grid gap-4">
          <h1 className="text-5xl font-extrabold">You're in, {me.name}.</h1>
          <p className="text-muted">{event.teamCount} teams registered. Keep this page open — it updates when the host starts Round 1.</p>
          <HowItWorks />
        </section>
      )}

      {(event.phase === 'r1_brief' || event.phase === 'r2_brief') && round && (
        <section className="mt-2 grid gap-5">
          <h1 className="text-5xl font-extrabold">{round.title}</h1>
          <p>{round.brief}</p>
          <p className="text-muted">You'll have {Math.round(round.durationSec / 60)} minutes once it starts.</p>
          <Rubric roundNo={round.roundNo} />
        </section>
      )}

      {(event.phase === 'r1_open' || event.phase === 'r2_open') && round && (
        <section className="mt-2 grid gap-6">
          <div className="flex items-end justify-between gap-4">
            <h1 className="text-4xl font-extrabold">{round.title}</h1>
          </div>
          <Countdown ms={left} />
          {round.roundNo === 1 && round.referenceImageUrl && (
            <figure className="grid gap-2">
              <img src={round.referenceImageUrl} alt="Reference image to recreate" className="w-full rounded-xl bg-panel" />
              <figcaption className="text-sm text-muted">Recreate this as closely as you can.</figcaption>
            </figure>
          )}
          {round.roundNo === 2 && <Concepts concepts={round.concepts} />}
          <Uploader code={code} state={state} existing={!!mine} onDone={refresh} closed={left === 0} />
          {mine && <MySubmission s={mine} />}
        </section>
      )}

      {(event.phase === 'r1_judging' || event.phase === 'r2_judging') && (
        <section className="mt-2 grid gap-5">
          <h1 className="text-5xl font-extrabold">The judge is looking.</h1>
          {state.progress && <Progress p={state.progress} />}
          {mine ? <MySubmission s={mine} /> : <p className="text-muted">Your team didn't submit this round.</p>}
          <p className="text-muted">Scores are revealed on the big screen.</p>
        </section>
      )}

      {(event.phase === 'r1_results' || event.phase === 'r2_results') && (
        <section className="mt-2 grid gap-6">
          {mine?.score != null ? (
            <>
              <div>
                <p className="text-muted">Your score</p>
                <p className="display text-8xl font-extrabold rgb-split">{mine.score.toFixed(1)}</p>
              </div>
              {mine.criteria && <ScoreBreakdown roundNo={mine.roundNo} criteria={mine.criteria} />}
              {mine.feedback && <blockquote className="border-l-4 border-sub-b pl-4 text-muted">{mine.feedback}</blockquote>}
            </>
          ) : <h1 className="text-4xl font-extrabold">{mine ? 'Your entry is still with the judge.' : 'No entry this round.'}</h1>}
          {state.leaderboard && <Standings state={state} />}
          <Link to={`/e/${code}/gallery?round=${rn}`} className="btn btn-ghost">Open the Pixel Gallery</Link>
        </section>
      )}

      {(event.phase === 'final' || event.phase === 'closed') && state.leaderboard && (
        <section className="mt-2 grid gap-6">
          {(() => {
            const row = state.leaderboard.find((r) => r.teamId === me.teamId);
            return row ? (<div><p className="text-muted">Final place</p><p className="display text-9xl font-extrabold rgb-split">#{row.rank}</p><p className="text-xl">{row.total.toFixed(1)} points</p></div>) : null;
          })()}
          <Standings state={state} />
          <div className="grid grid-cols-2 gap-3">
            <Link to={`/e/${code}/gallery?round=1`} className="btn btn-ghost">Round 1 gallery</Link>
            <Link to={`/e/${code}/gallery?round=2`} className="btn btn-ghost">Round 2 gallery</Link>
          </div>
        </section>
      )}
      <button className="mt-14 text-sm text-muted underline underline-offset-4" onClick={async () => { await api('/api/logout', { method: 'POST' }); nav(`/e/${code}`); }}>Log out on this device</button>
    </Shell>
  );
}

function HowItWorks() {
  return (
    <ol className="grid gap-3 mt-4">
      {['Open any AI image generator you like on your own device.', 'Write prompts until your picture matches the brief.', 'Download your best image and upload it here before the timer runs out.', 'An AI judge scores every entry blind — it never sees team names or your prompt.'].map((t, i) => (
        <li key={i} className="grid grid-cols-[2rem_1fr] gap-2"><span className="display font-extrabold text-sub-g">{i + 1}</span><span>{t}</span></li>
      ))}
    </ol>
  );
}

function Rubric({ roundNo }: { roundNo: 1 | 2 }) {
  return (
    <div className="grid gap-2">
      <h2 className="text-xl font-bold">How it's scored</h2>
      <ul className="grid gap-2">
        {criteriaFor(roundNo).map((c) => (
          <li key={c.key} className="grid grid-cols-[3rem_1fr] gap-2"><span className="display font-extrabold tabular-nums">{c.weight}</span><span><b>{c.label}.</b> <span className="text-muted">{c.guide}</span></span></li>
        ))}
      </ul>
    </div>
  );
}

export function Concepts({ concepts, big = false }: { concepts: string[]; big?: boolean }) {
  const colors = ['text-sub-r', 'text-sub-g', 'text-sub-b'];
  return (
    <ul className={`grid gap-3 ${big ? 'md:grid-cols-3 gap-8' : ''}`}>
      {concepts.map((c, i) => (
        <li key={i} className={`rounded-xl bg-panel ${big ? 'p-8' : 'p-4'}`}>
          <span className={`display font-extrabold ${colors[i]} ${big ? 'text-3xl' : 'text-lg'}`}>{'ABC'[i]}</span>
          <p className={`display font-bold ${big ? 'text-5xl mt-2' : 'text-2xl'}`}>{c}</p>
        </li>
      ))}
    </ul>
  );
}

function Uploader({ code, existing, onDone, closed }: { code: string; state: StateResponse; existing: boolean; onDone: () => void; closed: boolean }) {
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
      setMsg({ kind: 'ok', text: 'Submitted. The judge is on it.' });
      setPrep(null); setPrompt('');
      onDone();
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); } finally { setBusy(null); }
  }

  if (closed) return <Notice>Time is up. Waiting for the host…</Notice>;
  return (
    <div className="grid gap-4 rounded-2xl bg-panel p-4">
      <h2 className="text-xl font-bold">{existing ? 'Replace your entry' : 'Upload your image'}</h2>
      {existing && <p className="text-sm text-muted">A new upload replaces your current entry. Limited replacements per round.</p>}
      <input ref={input} type="file" accept="image/*" className="sr-only" onChange={(e) => choose(e.target.files?.[0])} />
      {prep ? (
        <figure className="grid gap-2">
          <img src={prep.previewUrl} alt="Your chosen image" className="w-full rounded-xl" />
          <figcaption className="text-sm text-muted">Compressed to {kb(prep.full.size)}, {prep.width}×{prep.height} px</figcaption>
        </figure>
      ) : (
        <button className="btn btn-ghost min-h-32 border-2 border-dashed border-line" onClick={() => input.current?.click()} disabled={!!busy}>
          {busy === 'prep' ? 'Preparing image…' : 'Choose image'}
        </button>
      )}
      <div className="grid gap-2">
        <label htmlFor="prompt" className="text-sm font-bold">Your winning prompt (optional)</label>
        <textarea id="prompt" className="field min-h-24" maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Shown in the gallery afterwards. The judge never sees it." />
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="grid grid-cols-[auto_1fr] gap-3">
        {prep && <button className="btn btn-ghost" onClick={() => input.current?.click()} disabled={!!busy}>Change</button>}
        <button className="btn col-start-2" onClick={send} disabled={!prep || !!busy}>{busy === 'send' ? 'Uploading…' : existing ? 'Replace entry' : 'Submit entry'}</button>
      </div>
    </div>
  );
}

function MySubmission({ s }: { s: NonNullable<StateResponse['me']>['submissions'][number] }) {
  return (
    <div className="grid grid-cols-[5rem_1fr] items-center gap-4 rounded-xl bg-panel p-3">
      <img src={s.thumbUrl} alt="Your entry" className="aspect-square w-20 rounded-lg object-cover" />
      <div><p className="font-bold">Your entry</p><StatusPill status={s.status} /></div>
    </div>
  );
}

export function Progress({ p, big = false }: { p: NonNullable<StateResponse['progress']>; big?: boolean }) {
  const pct = p.submitted ? Math.round((p.scored / p.submitted) * 100) : 0;
  return (
    <div className="grid gap-2">
      <div className={`h-3 ${big ? 'h-6' : ''} rounded-full bg-panel overflow-hidden`}>
        <div className="h-full bg-gradient-to-r from-sub-r via-sub-g to-sub-b transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
      <p className={`${big ? 'text-3xl' : 'text-sm'} text-muted tabular-nums`}>{p.scored} of {p.submitted} entries judged{p.failed ? `, ${p.failed} need a retry` : ''}</p>
    </div>
  );
}

function Standings({ state }: { state: StateResponse }) {
  return (
    <div className="grid gap-3">
      <h2 className="text-xl font-bold">Standings</h2>
      <Leaderboard rows={state.leaderboard!} highlight={state.me?.teamId} limit={10} showRounds={false} />
    </div>
  );
}
