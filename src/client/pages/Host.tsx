import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { MODELS_LABEL } from '../../shared/models-label';
import type { Phase, StateResponse } from '../../shared/types';
import { stageOf } from '../components/show';
import { Notice, Shell, StatusPill, Wordmark } from '../components/ui';
import { api, ApiError, fmtClock, useEventState, useNow } from '../lib';

// ───────────────────────── login / first-time setup ─────────────────────────

export function HostLogin() {
  const nav = useNavigate();
  const [status, setStatus] = useState<{ hasEvent: boolean; name: string | null; code: string | null; loggedIn: boolean } | null>(null);
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState({ name: 'Hexaware Prompt to Pixel', password: '', teams: 20 });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/host/status').then((s) => (s.loggedIn ? nav(`/host/${s.code}`, { replace: true }) : setStatus(s))).catch((e) => setMsg(e.message));
  }, [nav]);

  if (!status) return <Shell><Wordmark size="sm" /><div className="mt-10"><Notice kind={msg ? 'error' : 'info'}>{msg ?? 'Loading…'}</Notice></div></Shell>;

  if (!status.hasEvent) return (
    <Shell>
      <Wordmark size="sm" />
      <form className="mt-12 grid gap-5" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setMsg(null);
        try { const r = await api('/api/host/start', { method: 'POST', json: setup }); nav(`/host/${r.code}`); }
        catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
      }}>
        <h1 className="text-4xl font-extrabold">Set up your game</h1>
        <label className="grid gap-2"><span className="font-bold">Event name</span><input className="field" value={setup.name} onChange={(e) => setSetup({ ...setup, name: e.target.value })} required /></label>
        <label className="grid gap-2"><span className="font-bold">Host password</span><input className="field" type="password" value={setup.password} minLength={6} onChange={(e) => setSetup({ ...setup, password: e.target.value })} required />
          <span className="text-sm text-muted">You'll use this to open this console. At least 6 characters.</span></label>
        <label className="grid gap-2"><span className="font-bold">How many teams?</span><input className="field" type="number" min={1} max={120} value={setup.teams} onChange={(e) => setSetup({ ...setup, teams: Number(e.target.value) })} />
          <span className="text-sm text-muted">Teams pick a free number when they scan the QR code and make up their own PIN. You can add more numbers later.</span></label>
        {msg && <Notice kind="error">{msg}</Notice>}
        <button className="btn text-lg" disabled={busy || setup.password.length < 6}>{busy ? 'Creating…' : 'Create game'}</button>
      </form>
    </Shell>
  );

  return (
    <Shell>
      <Wordmark size="sm" />
      <form className="mt-14 grid gap-5" onSubmit={async (e) => {
        e.preventDefault(); setMsg(null); setBusy(true);
        try { const r = await api('/api/host/login', { method: 'POST', json: { password } }); nav(`/host/${r.code}`); }
        catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
      }}>
        <p className="text-muted">{status.name}</p>
        <h1 className="text-4xl font-extrabold">Host console</h1>
        <label className="grid gap-2"><span className="font-bold">Host password</span><input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></label>
        {msg && <Notice kind="error">{msg}</Notice>}
        <button className="btn text-lg" disabled={!password || busy}>Open console</button>
      </form>
    </Shell>
  );
}

// ───────────────────────── the console ─────────────────────────

type Act = (fn: () => Promise<any>, ok?: string) => Promise<any>;

function useOverview(code: string) {
  const nav = useNavigate();
  const [ov, setOv] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const load = useCallback(async () => {
    window.clearTimeout(timer.current);
    try { setOv(await api(`/api/events/${code}/host/overview`)); setErr(null); }
    catch (e) { if (e instanceof ApiError && e.status === 401) { nav('/host'); return; } setErr((e as Error).message); }
    if (!document.hidden) timer.current = window.setTimeout(load, 4000);
  }, [code, nav]);
  useEffect(() => {
    load();
    const v = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', v);
    return () => { window.clearTimeout(timer.current); document.removeEventListener('visibilitychange', v); };
  }, [load]);
  return { ov, err, load };
}

export function HostDashboard() {
  const code = (useParams().code ?? '').toUpperCase();
  const { ov, err, load } = useOverview(code);
  const { state, offset, refresh } = useEventState(code);
  const now = useNow(250) + offset;
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const act: Act = async (fn, ok) => {
    setMsg(null); setBusy(true);
    try { const r = await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); await Promise.all([load(), refresh()]); return r; }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const go = (action: string, extra: object = {}) => act(() => api(`/api/events/${code}/host/action`, { method: 'POST', json: { action, ...extra } }));
  const [mysteryForm, setMysteryForm] = useState<string | null>(null);

  if (!ov || !state) return <Shell><Wordmark size="sm" /><div className="mt-10"><Notice kind={err ? 'error' : 'info'}>{err ?? 'Loading console…'}</Notice></div></Shell>;

  const phase: Phase = state.event.phase;
  const round = state.round;
  const st = round && phase.endsWith('_open') ? stageOf(round, now) : null;
  const p = state.progress;
  const joined = ov.teams.filter((t: any) => t.joined_at).length;
  const screenUrl = `${location.origin}/e/${code}/screen?pk=${ov.event.projectorKey}`;

  // one big button + a couple of small ones, depending on where the show is
  let title = '', detail: ReactNode = null;
  let primary: { label: string; run: () => void; danger?: boolean } | null = null;
  const secondary: { label: string; run: () => void }[] = [];
  if (phase === 'lobby') {
    title = 'Registration';
    detail = <>{joined} of {ov.teams.length} team numbers taken. Put the big screen up — teams scan the QR code, pick a free number and make up their own PIN.</>;
    primary = { label: 'Start Round 1: spin the wheel', run: () => go('spin1') };
  } else if (st && round) {
    title = round.roundNo === 1 ? `Round 1, scene ${round.seq}` : `Round 2, mashup ${round.seq}`;
    detail = st.stage === 'spin' ? 'The wheel is spinning…'
      : st.stage === 'preview' ? (round.roundNo === 1 ? `Showing "${round.title}" — ${Math.ceil(st.msLeft / 1000)} s left to memorise` : 'Showing the movie mashup')
      : st.stage === 'open' ? <><b className="display text-4xl tabular-nums">{fmtClock(st.msLeft)}</b> left. {p?.submitted ?? 0} of {joined} teams dropped an image, {p?.scored ?? 0} judged.</>
      : 'Time is up — closing…';
    primary = { label: 'End now', run: () => go('end'), danger: true };
  } else if (phase.endsWith('_judging') && round?.judgeMode === 'host') {
    title = 'Your turn to judge';
    const left = (p?.submitted ?? 0) - (p?.scored ?? 0);
    detail = <>You've scored {p?.scored ?? 0} of {p?.submitted ?? 0} images. {left > 0 ? `Give the other ${left} a score below, then show the scores.` : 'All scored. Show the scores when ready.'}</>;
    primary = { label: 'Show the scores', run: () => go('reveal') };
  } else if (phase.endsWith('_judging')) {
    title = 'Judging';
    detail = <>{p?.scored ?? 0} of {p?.submitted ?? 0} images judged{p?.pending ? `, ${p.pending} still with the AI` : ''}{p?.failed ? `, ${p.failed} failed (retry below)` : ''}.</>;
    primary = { label: 'Show the scores', run: () => go('reveal') };
  } else if (phase.endsWith('_results')) {
    const r1 = phase.startsWith('r1');
    title = 'Scores on screen';
    detail = r1 ? 'Spin another scene, or move on to Round 2.' : 'Spin another mashup, or show the final standings.';
    primary = r1 ? { label: 'Spin the next scene', run: () => go('spin1') } : { label: 'Show final standings', run: () => go('final') };
    if (r1) secondary.push({ label: 'Go to Round 2: Movie Mashup', run: () => go('spin2') });
    else secondary.push({ label: 'Spin another mashup', run: () => go('spin2') });
    if (r1) secondary.push({ label: 'Finish the game', run: () => go('final') });
  } else if (phase === 'final' || phase === 'closed') {
    title = 'Final standings are on screen';
    detail = 'The game is over. Start a fresh game from Settings below when you need one.';
  }

  const mystery = state.mystery;
  const canMystery = !mystery && !phase.endsWith('_open') && phase !== 'closed';
  const nextHost = !!ov.settings.host_judges_next;
  const turnSubs = round ? ov.submissions.filter((s: any) => s.turn_id === round.turnId) : [];
  const attention = ov.submissions.filter((s: any) => ['needs_review', 'failed', 'paused_quota'].includes(s.status));

  return (
    <Shell wide>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Wordmark size="sm" />
        <div className="flex flex-wrap gap-2">
          <a className="btn btn-ghost" href={screenUrl} target="_blank" rel="noreferrer">Open big screen</a>
        </div>
      </header>

      {mystery ? (
        <MysteryPanel code={code} name={ov.event.name} mystery={mystery} teams={ov.teams} act={act} busy={busy} msg={msg} onFinish={() => go('mystery_end')} />
      ) : (
      <section className="mt-6 rounded-3xl bg-panel p-6 grid gap-4 sticky top-2 z-20 shadow-[0_10px_30px_rgba(10,6,30,.6)]">
        <p className="text-muted">{ov.event.name}</p>
        <h1 className="text-5xl font-extrabold">{title}</h1>
        <p className="text-xl">{detail}</p>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        <div className="flex flex-wrap gap-3">
          {primary && <button className={`btn text-xl min-h-16 px-8 ${primary.danger ? 'btn-danger' : ''}`} disabled={busy} onClick={primary.run}>{primary.label}</button>}
          {secondary.map((s) => <button key={s.label} className="btn btn-ghost min-h-16" disabled={busy} onClick={s.run}>{s.label}</button>)}
          {canMystery && mysteryForm === null && <button className="btn btn-ghost min-h-16 ml-auto" disabled={busy} onClick={() => setMysteryForm('')}>Start Mystery round</button>}
        </div>
        {canMystery && mysteryForm !== null && (
          <form className="flex flex-wrap items-end gap-3 rounded-2xl bg-panel-2 p-4" onSubmit={(e) => { e.preventDefault(); go('mystery_start', { title: mysteryForm }).then(() => setMysteryForm(null)); }}>
            <label className="grid gap-1 grow text-sm">What's the mystery? Shown on the big screen (optional)
              <input className="field" maxLength={60} value={mysteryForm} onChange={(e) => setMysteryForm(e.target.value)} placeholder="e.g. Guess the movie from the emoji" autoFocus /></label>
            <button className="btn min-h-12" disabled={busy}>Start it</button>
            <button type="button" className="btn btn-ghost min-h-12" onClick={() => setMysteryForm(null)}>Cancel</button>
          </form>
        )}
        {phase !== 'final' && phase !== 'closed' && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm border-t border-panel-2 pt-3">
            <span className="flex items-center gap-2">Who judges the next spin?
              <span className="inline-flex rounded-full bg-panel-2 p-1">
                {[false, true].map((v) => (
                  <button key={String(v)} className={`rounded-full px-4 py-1.5 font-bold ${nextHost === v ? 'bg-paper text-dusk' : 'text-muted'}`} disabled={busy}
                    onClick={() => nextHost !== v && act(() => api(`/api/events/${code}/host/settings`, { method: 'PUT', json: { host_judges_next: v } }))}>
                    {v ? 'Me' : 'AI'}</button>
                ))}
              </span>
            </span>
            {round && !round.revealed && (
              <span className="flex items-center gap-2">This spin is judged by {round.judgeMode === 'host' ? 'you' : 'the AI'}.
                <button className="underline" disabled={busy} onClick={() => go(round.judgeMode === 'host' ? 'judge_ai' : 'judge_host')}>
                  {round.judgeMode === 'host' ? 'Let the AI judge it' : 'Judge it myself'}</button>
              </span>
            )}
          </div>
        )}
      </section>
      )}

      {attention.length > 0 && (
        <Panel title="Needs your attention">
          <EntryList subs={attention} code={code} act={act} />
        </Panel>
      )}

      {round && (
        <Panel title={round.roundNo === 1 ? `Images for scene ${round.seq}: ${round.title}` : `Images for ${round.title}`}>
          {round.judgeMode === 'host' && <p className="text-muted">Tap an image to see it full size, then type a score out of 100. You can change a score until you show the scores.</p>}
          {round.roundNo === 1 && round.sceneId && round.judgeMode === 'host' && (
            <figure className="flex items-center gap-3"><img src={`/bank/${round.sceneId}-thumb.webp`} alt="The original scene" className="w-28 rounded-lg" /><figcaption className="text-sm text-muted">The original scene</figcaption></figure>)}
          {round.roundNo === 2 && round.judgeMode === 'host' && <p className="font-bold">The movie: {round.concepts.join(' + ')}</p>}
          {turnSubs.length ? <EntryList subs={turnSubs} code={code} act={act} scoring /> : <p className="text-muted">No images yet.</p>}
        </Panel>
      )}

      <Teams ov={ov} code={code} act={act} />
      <Settings ov={ov} code={code} act={act} />
    </Shell>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mt-6 rounded-2xl bg-panel p-5 grid gap-4"><h2 className="text-2xl font-extrabold">{title}</h2>{children}</section>;
}

const FLAG_LABEL: Record<string, string> = {
  reference_copy: 'Uploaded the original scene itself', duplicate_exact: 'Same file as another team', near_duplicate: 'Very similar to another team',
  embedded_text: 'Has text aimed at the AI judge', host_cleared: 'Cleared by you',
};

function EntryList({ subs, code, act, scoring = false }: { subs: any[]; code: string; act: Act; scoring?: boolean }) {
  const post = (id: string, a: string) => act(() => api(`/api/events/${code}/host/submissions/${id}/${a}`, { method: 'POST' }));
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {subs.map((s) => (
        <li key={s.id} className="grid grid-cols-[5rem_1fr] gap-3 items-center rounded-xl bg-panel-2 p-2">
          <a href={s.image_url} target="_blank" rel="noreferrer"><img src={s.thumb_url} alt={`Image by ${s.team}`} className="w-20 aspect-square rounded-lg object-cover" loading="lazy" /></a>
          <div className="min-w-0 text-sm grid gap-1">
            <div className="flex justify-between gap-2"><b className="truncate">{s.team}</b><span className="display text-xl font-extrabold tabular-nums">{s.score_total != null ? Number(s.score_total).toFixed(0) : '–'}</span></div>
            <StatusPill status={s.status} />
            {s.flags?.filter((f: string) => f !== 'host_cleared').length > 0 && <p className="text-warn">{s.flags.map((f: string) => FLAG_LABEL[f] ?? f).join('; ')}</p>}
            <div className="flex gap-2">
              {s.status === 'needs_review' && <><button className="underline" onClick={() => post(s.id, 'approve')}>Approve</button><button className="underline text-sub-r" onClick={() => post(s.id, 'reject')}>Reject</button></>}
              {['failed', 'paused_quota'].includes(s.status) && <button className="underline" onClick={() => post(s.id, 'requeue')}>Retry judging</button>}
            </div>
            {scoring && s.status !== 'superseded' && <ScoreInput key={`${s.id}-${s.score_total}`} sub={s} code={code} act={act} />}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ScoreInput({ sub, code, act }: { sub: any; code: string; act: Act }) {
  const [v, setV] = useState(sub.score_total != null && sub.flags?.includes('host_scored') ? String(Number(sub.score_total)) : '');
  const n = Number(v);
  const ok = v.trim() !== '' && n >= 0 && n <= 100;
  return (
    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (ok) act(() => api(`/api/events/${code}/host/submissions/${sub.id}/score`, { method: 'POST', json: { score: n } })); }}>
      <input className="field !min-h-9 !py-1 !w-20 tabular-nums" inputMode="decimal" aria-label={`Your score for ${sub.team}`} placeholder="0–100" value={v} onChange={(e) => setV(e.target.value.replace(/[^\d.]/g, ''))} />
      <button className="underline font-bold" disabled={!ok}>{sub.flags?.includes('host_scored') ? 'Update' : sub.status === 'scored' ? 'Change score' : 'Give score'}</button>
    </form>
  );
}

function MysteryPanel({ code, name, mystery, teams, act, busy, msg, onFinish }: {
  code: string; name: string; mystery: NonNullable<StateResponse['mystery']>; teams: any[]; act: Act; busy: boolean;
  msg: { kind: 'error' | 'ok'; text: string } | null; onFinish: () => void;
}) {
  const [teamNo, setTeamNo] = useState('');
  const [points, setPoints] = useState('10');
  const team = teams.find((t) => String(t.team_no) === teamNo.trim());
  const pts = Number(points);
  const valid = !!team?.joined_at && Number.isInteger(pts) && pts !== 0 && Math.abs(pts) <= 1000;
  const total = mystery.awards.reduce((a, x) => a + x.points, 0);
  return (
    <section className="mt-6 rounded-3xl bg-panel p-6 grid gap-5 sticky top-2 z-20 shadow-[0_10px_30px_rgba(10,6,30,.6)] ring-2 ring-sub-b">
      <p className="text-muted">{name}</p>
      <h1 className="text-5xl font-extrabold">Mystery round{mystery.title ? `: ${mystery.title}` : ''}</h1>
      <p className="text-xl">Spins are paused and the big screen shows the Mystery screen. Give points by team number. Points go straight onto the leaderboard.</p>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <form className="grid gap-3 sm:grid-cols-[8rem_1fr_auto] items-end" onSubmit={(e) => {
        e.preventDefault(); if (!valid) return;
        act(() => api(`/api/events/${code}/host/bonus`, { method: 'POST', json: { teamNo: Number(teamNo), points: pts } }), `${pts > 0 ? '+' : ''}${pts} to ${team.name}`)
          .then((r) => { if (r) setTeamNo(''); });
      }}>
        <label className="grid gap-1 text-sm font-bold">Team number
          <input className="field text-2xl tabular-nums" inputMode="numeric" value={teamNo} onChange={(e) => setTeamNo(e.target.value.replace(/\D/g, '').slice(0, 3))} autoFocus /></label>
        <div className="grid gap-1 text-sm font-bold">Points
          <div className="flex flex-wrap gap-2">
            <input className="field text-2xl !w-28 tabular-nums" inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value.replace(/[^\d-]/g, '').slice(0, 5))} aria-label="Points" />
            {[10, 25, 50, -10].map((q) => <button type="button" key={q} className={`btn btn-ghost !min-h-12 ${pts === q ? 'ring-2 ring-paper' : ''}`} onClick={() => setPoints(String(q))}>{q > 0 ? `+${q}` : q}</button>)}
          </div>
        </div>
        <button className="btn text-xl min-h-14 px-8" disabled={busy || !valid}>Give points</button>
        <p className="text-sm sm:col-span-3 min-h-5">{teamNo ? (team?.joined_at ? <>Team {team.team_no}: <b>{team.name}</b></> : <span className="text-warn">Team {teamNo} hasn't joined</span>) : <span className="text-muted">Type the team number they call out.</span>}</p>
      </form>
      {mystery.awards.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {mystery.awards.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl bg-panel-2 px-4 py-2">
              <span className="truncate"><b className="tabular-nums mr-2">{a.teamNo}</b>{a.name}</span>
              <span className="flex items-center gap-3"><b className={`display text-xl tabular-nums ${a.points > 0 ? 'text-sub-g' : 'text-sub-r'}`}>{a.points > 0 ? '+' : ''}{a.points}</b>
                <button className="underline text-sm text-muted" disabled={busy} onClick={() => act(() => api(`/api/events/${code}/host/bonus/${a.id}`, { method: 'DELETE' }), `Removed ${a.points > 0 ? '+' : ''}${a.points} from ${a.name}`)}>Undo</button></span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <button className="btn text-xl min-h-16 px-8" disabled={busy} onClick={onFinish}>Finish Mystery round and resume</button>
        <span className="text-muted">{mystery.awards.length} awards, {total > 0 ? '+' : ''}{total} points this round</span>
      </div>
    </section>
  );
}

function Teams({ ov, code, act }: { ov: any; code: string; act: Act }) {
  const [count, setCount] = useState(ov.teams.length + 5);
  const joined = ov.teams.filter((t: any) => t.joined_at).length;
  return (
    <Panel title={`Teams: ${joined} joined of ${ov.teams.length}`}>
      <ul className="grid gap-2 grid-cols-2 sm:grid-cols-4 lg:grid-cols-6">
        {ov.teams.map((t: any) => (
          <li key={t.id} className={`rounded-xl p-3 text-sm ${t.joined_at ? 'bg-sub-g/15 ring-1 ring-sub-g' : 'bg-panel-2'} ${t.disabled ? 'opacity-40' : ''}`}>
            <p className="display text-2xl font-extrabold">{t.team_no ?? '–'}</p>
            <p className="font-bold truncate">{t.joined_at ? t.name : 'Free'}</p>
            {t.pin_plain && <p className="text-warn tabular-nums">New PIN {t.pin_plain}</p>}
            {t.joined_at && <button className="underline text-muted" onClick={() => act(() => api(`/api/events/${code}/host/teams/${t.id}/new-pin`, { method: 'POST' }),
              `Team ${t.team_no} has a new PIN — it's shown on its card. Tell the team.`)}>Forgot PIN?</button>}
          </li>
        ))}
      </ul>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); act(() => api(`/api/events/${code}/host/teams`, { method: 'POST', json: { count } }), 'More team numbers are now free to pick.'); }}>
        <label className="grid gap-1 text-sm">Total teams<input type="number" min={1} max={120} className="field !w-32" value={count} onChange={(e) => setCount(Number(e.target.value))} /></label>
        <button className="btn btn-ghost">Add team numbers</button>
      </form>
    </Panel>
  );
}

function Settings({ ov, code, act }: { ov: any; code: string; act: Act }) {
  const nav = useNavigate();
  const s = ov.settings;
  const [f, setF] = useState({ preview: s.r1_preview_sec, r1min: s.r1_duration_sec / 60, r2min: s.r2_duration_sec / 60, uploads: s.max_submissions_per_round, model: s.judge_model });
  const [fresh, setFresh] = useState({ name: ov.event.name, password: '', teams: 20, confirm: '' });
  const u = ov.usage, used = u.today.ai_neurons ?? 0;
  return (
    <details className="mt-6 rounded-2xl bg-panel p-5">
      <summary className="cursor-pointer text-2xl font-extrabold">Settings</summary>
      <div className="mt-5 grid gap-8 lg:grid-cols-3">
        <div className="grid gap-3 content-start text-sm">
          <h3 className="text-lg font-bold">Timings (apply to the next spin)</h3>
          <label className="grid gap-1">Scene shown for (seconds)<input type="number" min={3} max={30} className="field" value={f.preview} onChange={(e) => setF({ ...f, preview: Number(e.target.value) })} /></label>
          <label className="grid gap-1">Round 1 recreate time (minutes)<input type="number" min={1} max={30} step={0.5} className="field" value={f.r1min} onChange={(e) => setF({ ...f, r1min: Number(e.target.value) })} /></label>
          <label className="grid gap-1">Round 2 poster time (minutes)<input type="number" min={1} max={30} step={0.5} className="field" value={f.r2min} onChange={(e) => setF({ ...f, r2min: Number(e.target.value) })} /></label>
          <label className="grid gap-1">Uploads allowed per team per spin<input type="number" min={1} max={5} className="field" value={f.uploads} onChange={(e) => setF({ ...f, uploads: Number(e.target.value) })} /></label>
          <label className="grid gap-1">AI judge<select className="field" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}>
            {Object.entries(MODELS_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <button className="btn" onClick={() => act(() => api(`/api/events/${code}/host/settings`, { method: 'PUT', json: {
            r1_preview_sec: f.preview, r1_duration_sec: Math.round(f.r1min * 60), r2_duration_sec: Math.round(f.r2min * 60), max_submissions_per_round: f.uploads, judge_model: f.model } }), 'Saved. The next spin uses these.')}>Save</button>
        </div>
        <div className="grid gap-2 content-start text-sm">
          <h3 className="text-lg font-bold">Free AI allowance today</h3>
          <div className="h-3 rounded-full bg-panel-2 overflow-hidden"><div className={`h-full ${used / s.ai_neuron_daily_cap > 0.85 ? 'bg-sub-r' : 'bg-sub-g'}`} style={{ width: `${Math.min(100, (used / s.ai_neuron_daily_cap) * 100)}%` }} /></div>
          <p className="text-muted tabular-nums">{Math.round(used).toLocaleString()} of {s.ai_neuron_daily_cap.toLocaleString()} used, enough for about {u.budget.next ? Math.max(0, Math.floor((u.budget.cap - u.budget.used) / u.budget.next)) : '–'} more images. Resets 05:30 IST. If it runs out, images wait safely and are judged after the reset.</p>
          <p className="text-muted">Images judged today: {u.today.ai_calls ?? 0}. Failures: {u.today.ai_failures ?? 0}.</p>
        </div>
        <form className="grid gap-3 content-start text-sm" onSubmit={(e) => {
          e.preventDefault();
          act(async () => { const r = await api('/api/host/start', { method: 'POST', json: { name: fresh.name, password: fresh.password, teams: fresh.teams } }); nav(`/host/${r.code}`); }, 'New game created.');
        }}>
          <h3 className="text-lg font-bold">Start a fresh game</h3>
          <p className="text-muted">Clears the screen for a new group. The current game's results stay in the database.</p>
          <input className="field" value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} placeholder="Event name" />
          <input className="field" type="password" value={fresh.password} onChange={(e) => setFresh({ ...fresh, password: e.target.value })} placeholder="New host password (6+ characters)" />
          <input className="field" type="number" min={1} max={120} value={fresh.teams} onChange={(e) => setFresh({ ...fresh, teams: Number(e.target.value) })} />
          <input className="field" value={fresh.confirm} onChange={(e) => setFresh({ ...fresh, confirm: e.target.value })} placeholder="Type NEW to confirm" />
          <button className="btn btn-danger" disabled={fresh.confirm !== 'NEW' || fresh.password.length < 6}>Start fresh game</button>
        </form>
      </div>
    </details>
  );
}

// ───────────────────────── printable PIN slips ─────────────────────────

export function PinSlips() {
  const code = (useParams().code ?? '').toUpperCase();
  const { ov, err } = useOverview(code);
  const [qr, setQr] = useState<string | null>(null);
  const url = `${location.origin}/e/${code}`;
  useEffect(() => { QRCode.toDataURL(url, { margin: 1, width: 240 }).then(setQr); }, [url]);
  if (!ov) return <div className="p-8"><Notice kind={err ? 'error' : 'info'}>{err ?? 'Loading…'}</Notice></div>;
  return (
    <div className="bg-white text-black min-h-screen p-6 print:p-0">
      <div className="print:hidden mb-6 flex items-center gap-4"><button className="btn" onClick={() => window.print()}>Print</button><span>Cut along the lines and give one slip to each team.</span></div>
      <div className="grid grid-cols-3 gap-0">
        {ov.teams.map((t: any) => (
          <div key={t.id} className="border border-dashed border-gray-400 p-4 grid grid-cols-[1fr_auto] gap-2 items-center break-inside-avoid">
            <div>
              <p className="text-sm">{ov.event.name}</p>
              <p className="text-4xl font-extrabold">Team {t.team_no}</p>
              <p className="text-2xl tracking-[0.3em] font-mono">PIN {t.pin_plain}</p>
              <p className="text-xs mt-1">Scan, then enter your team number and PIN.</p>
            </div>
            {qr && <img src={qr} alt="" className="w-24 h-24" />}
          </div>
        ))}
      </div>
    </div>
  );
}
