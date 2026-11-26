import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PHASE_LABEL, PHASE_ORDER, type Phase } from '../../shared/types';
import { Countdown, Notice, Shell, StatusPill, Wordmark } from '../components/ui';
import { api, ApiError, kb, prepareImage, remainingMs, useNow } from '../lib';
import { useQr } from './Projector';

export function HostLogin() {
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (
    <Shell>
      <Wordmark size="sm" />
      <form className="mt-14 grid gap-5" onSubmit={async (e) => {
        e.preventDefault(); setMsg(null);
        try { await api(`/api/events/${c}/host/login`, { method: 'POST', json: { password } }); nav(`/host/${c}`); }
        catch (err) { setMsg((err as Error).message); }
      }}>
        <h1 className="text-4xl font-extrabold">Host console</h1>
        <div className="grid gap-2"><label htmlFor="hc" className="font-bold">Event code</label><input id="hc" className="field uppercase" value={c} onChange={(e) => setCode(e.target.value)} /></div>
        <div className="grid gap-2"><label htmlFor="hp" className="font-bold">Host password</label><input id="hp" type="password" className="field" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {msg && <Notice kind="error">{msg}</Notice>}
        <button className="btn" disabled={c.length < 4 || !password}>Log in</button>
        <a href="/setup" className="btn btn-ghost">Create a new event</a>
      </form>
    </Shell>
  );
}

const NEXT_LABEL: Partial<Record<Phase, string>> = {
  lobby: 'Show Round 1 brief', r1_brief: 'Start Round 1', r1_open: 'End Round 1 now', r1_judging: 'Reveal Round 1 results',
  r1_results: 'Show Round 2 brief', r2_brief: 'Start Round 2', r2_open: 'End Round 2 now', r2_judging: 'Reveal Round 2 results',
  r2_results: 'Show final standings', final: 'Close event',
};

export function HostDashboard() {
  const code = (useParams().code ?? '').toUpperCase();
  const nav = useNavigate();
  const [ov, setOv] = useState<any>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [offset, setOffset] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const now = useNow(500);

  const load = useCallback(async () => {
    window.clearTimeout(timer.current);
    try {
      setOv(await api(`/api/events/${code}/host/overview`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { nav('/host'); return; }
      setMsg({ kind: 'error', text: (e as Error).message });
    }
    if (!document.hidden) timer.current = window.setTimeout(load, 4000);
  }, [code, nav]);

  useEffect(() => {
    load();
    const v = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', v);
    // one-off clock sync for the countdown
    fetch(`/api/events/${code}/state`, { credentials: 'same-origin' }).then((r) => r.json()).then((s) => setOffset(new Date(s.serverNow).getTime() - Date.now())).catch(() => {});
    return () => { window.clearTimeout(timer.current); document.removeEventListener('visibilitychange', v); };
  }, [load, code]);

  const act = async (fn: () => Promise<any>, ok?: string) => {
    setMsg(null);
    try { const r = await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); await load(); return r; }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  };

  if (!ov) return <Shell><Wordmark size="sm" /><div className="mt-10"><Notice kind={msg ? 'error' : 'info'}>{msg?.text ?? 'Loading console…'}</Notice></div></Shell>;
  const phase: Phase = ov.event.phase;
  const i = PHASE_ORDER.indexOf(phase);
  const next = PHASE_ORDER[i + 1] as Phase | undefined;
  const prev = PHASE_ORDER[i - 1] as Phase | undefined;
  const openRound = ov.rounds.find((r: any) => (phase === 'r1_open' && r.round_no === 1) || (phase === 'r2_open' && r.round_no === 2));
  const setPhase = (to: Phase) => act(() => api(`/api/events/${code}/host/phase`, { method: 'POST', json: { to } }));

  return (
    <Shell wide>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Wordmark size="sm" />
        <span className="text-muted">{ov.event.name} <b className="text-paper tracking-widest">{ov.event.code}</b></span>
      </header>

      {/* ── phase control ── */}
      <section className="mt-6 grid gap-4 rounded-2xl bg-panel p-5 lg:grid-cols-[1fr_auto] items-center sticky top-2 z-20 shadow-[0_10px_30px_rgba(10,6,30,.6)]">
        <div className="grid gap-1">
          <p className="text-muted text-sm">Now showing</p>
          <h1 className="text-4xl font-extrabold">{PHASE_LABEL[phase]}</h1>
          {openRound && <Countdown ms={remainingMs(openRound.deadline_at, offset, now)} />}
        </div>
        <div className="flex flex-wrap gap-2">
          {prev && phase !== 'closed' && <button className="btn btn-ghost" onClick={() => setPhase(prev)}>Back to {PHASE_LABEL[prev]}</button>}
          {next && <button className="btn" onClick={() => setPhase(next)}>{NEXT_LABEL[phase] ?? `Go to ${PHASE_LABEL[next]}`}</button>}
        </div>
        {msg && <div className="lg:col-span-2"><Notice kind={msg.kind}>{msg.text}</Notice></div>}
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.35fr_1fr] items-start">
        <div className="grid gap-6">
          <Submissions ov={ov} code={code} act={act} />
          <RoundOne ov={ov} code={code} act={act} />
          <RoundTwo ov={ov} code={code} act={act} />
          <Teams ov={ov} code={code} act={act} />
        </div>
        <div className="grid gap-6">
          <Screens ov={ov} code={code} act={act} />
          <Usage ov={ov} />
          <Judge ov={ov} code={code} act={act} />
          <Audit ov={ov} />
        </div>
      </div>
    </Shell>
  );
}

type Act = (fn: () => Promise<any>, ok?: string) => Promise<any>;
function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-2xl bg-panel p-5 grid gap-4 content-start">
      <div className="flex items-center justify-between gap-3"><h2 className="text-2xl font-extrabold">{title}</h2>{aside}</div>
      {children}
    </section>
  );
}

function Screens({ ov, code, act }: { ov: any; code: string; act: Act }) {
  const join = `${location.origin}/e/${code}`;
  const screen = `${location.origin}/e/${code}/screen?pk=${ov.event.projectorKey}`;
  const qr = useQr(join);
  return (
    <Panel title="Screens & registration">
      <div className="grid grid-cols-[7rem_1fr] gap-4 items-center">
        {qr && <img src={qr} alt="Registration QR code" className="w-28 rounded-lg" />}
        <div className="grid gap-2 text-sm min-w-0">
          <a className="underline underline-offset-4 break-all" href={join} target="_blank" rel="noreferrer">Participant link: {join}</a>
          <a className="underline underline-offset-4 break-all" href={screen} target="_blank" rel="noreferrer">Open projector screen</a>
          <button className="text-left text-muted underline underline-offset-4" onClick={() => navigator.clipboard?.writeText(screen)}>Copy projector link (keep private)</button>
        </div>
      </div>
      <label className="flex items-center justify-between gap-3">
        <span>Registration is {ov.event.registrationOpen ? 'open' : 'closed'}</span>
        <button className="btn btn-ghost" onClick={() => act(() => api(`/api/events/${code}/host/registration`, { method: 'POST', json: { open: !ov.event.registrationOpen } }))}>
          {ov.event.registrationOpen ? 'Close registration' : 'Reopen registration'}
        </button>
      </label>
    </Panel>
  );
}

function Bar({ label, used, cap, unit = '' }: { label: string; used: number; cap: number; unit?: string }) {
  const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
  return (
    <div className="grid gap-1">
      <div className="flex justify-between text-sm"><span>{label}</span><span className="tabular-nums text-muted">{Math.round(used).toLocaleString()}{unit} of {Math.round(cap).toLocaleString()}{unit}</span></div>
      <div className="h-2 rounded-full bg-panel-2 overflow-hidden"><div className={`h-full ${pct > 85 ? 'bg-sub-r' : pct > 60 ? 'bg-warn' : 'bg-sub-g'}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function Usage({ ov }: { ov: any }) {
  const u = ov.usage, t = u.today;
  const s3 = u.storage.find((x: any) => x.backend === 'neon-s3');
  const db = u.storage.find((x: any) => x.backend === 'bytea');
  return (
    <Panel title="Free-tier usage today" aside={<span className="text-sm text-muted">resets 05:30 IST</span>}>
      <Bar label="Workers AI neurons (your cap)" used={t.ai_neurons ?? 0} cap={ov.settings.ai_neuron_daily_cap} />
      <Bar label="Worker requests (estimate)" used={t.worker_requests ?? 0} cap={ov.settings.request_daily_cap} />
      <Bar label="Postgres storage" used={u.dbBytes / 1e6} cap={u.limits.neonDbBytes / 1e6} unit=" MB" />
      <Bar label="Object storage" used={Number(s3?.bytes ?? 0) / 1e6} cap={u.limits.neonObjectBytes / 1e6} unit=" MB" />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">AI calls</dt><dd className="tabular-nums">{t.ai_calls ?? 0}</dd>
        <dt className="text-muted">AI failures</dt><dd className="tabular-nums">{t.ai_failures ?? 0}</dd>
        <dt className="text-muted">Next call estimate</dt><dd className="tabular-nums">{u.budget.next.toFixed(1)} neurons</dd>
        <dt className="text-muted">Evaluations left today</dt><dd className="tabular-nums">{u.budget.next ? Math.max(0, Math.floor((u.budget.cap - u.budget.used) / u.budget.next)) : '–'}</dd>
        <dt className="text-muted">Queue operations</dt><dd className="tabular-nums">{Math.round(t.queue_ops ?? 0).toLocaleString()} of 10,000</dd>
        <dt className="text-muted">Uploads</dt><dd className="tabular-nums">{t.uploads ?? 0}, {kb(t.upload_bytes ?? 0)}</dd>
        <dt className="text-muted">Image storage</dt><dd>{ov.storageBackend === 'neon-s3' ? 'Neon Object Storage' : 'Postgres fallback'}{db ? `, ${db.n} in Postgres` : ''}</dd>
      </dl>
      <p className="text-xs text-muted">If a quota runs out, judging pauses and every entry is kept. Judging resumes automatically when quota is available.</p>
    </Panel>
  );
}

function Judge({ ov, code, act }: { ov: any; code: string; act: Act }) {
  const [s, setS] = useState(ov.settings);
  const [rejudge, setRejudge] = useState({ round: 1, confirm: '' });
  useEffect(() => setS(ov.settings), [ov.settings.updated_at]);
  const locks = ov.rounds.filter((r: any) => r.locked_at);
  return (
    <Panel title="AI judge">
      {locks.map((r: any) => <p key={r.id} className="text-sm"><b>Round {r.round_no} locked</b> to {r.locked_model.replace('@cf/', '')} ({r.locked_mode}).</p>)}
      <div className="grid gap-3 text-sm">
        <label className="grid gap-1">Provider
          <select className="field" value={s.judge_provider} onChange={(e) => setS({ ...s, judge_provider: e.target.value })}>
            <option value="workers-ai">Cloudflare Workers AI</option>
            <option value="ollama" disabled={!ov.capabilities.ollama}>Local Ollama (emergency{ov.capabilities.ollama ? '' : ', not configured'})</option>
          </select>
        </label>
        <label className="grid gap-1">Model
          {s.judge_provider === 'workers-ai'
            ? <select className="field" value={s.judge_model} onChange={(e) => setS({ ...s, judge_model: e.target.value })}>
                {ov.models.map((m: any) => <option key={m.id} value={m.id}>{m.label}{m.multiImage ? ' (multi-image)' : ''}</option>)}
              </select>
            : <input className="field" value={s.judge_model} onChange={(e) => setS({ ...s, judge_model: e.target.value })} placeholder="llama3.2-vision" />}
        </label>
        <label className="grid gap-1">Round 1 comparison
          <select className="field" value={s.r1_mode} onChange={(e) => setS({ ...s, r1_mode: e.target.value })}>
            <option value="auto">Automatic (now: {ov.effectiveR1Mode})</option>
            <option value="multi-image">Both images in one request</option>
            <option value="composite" disabled={!ov.capabilities.imagesBinding}>Side-by-side composite{ov.capabilities.imagesBinding ? '' : ' (needs Images binding)'}</option>
            <option value="reference-description">Written reference description</option>
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1">Parallel evaluations<input type="number" min={1} max={10} className="field" value={s.eval_concurrency} onChange={(e) => setS({ ...s, eval_concurrency: Number(e.target.value) })} /></label>
          <label className="grid gap-1">Attempts per entry<input type="number" min={1} max={10} className="field" value={s.max_attempts} onChange={(e) => setS({ ...s, max_attempts: Number(e.target.value) })} /></label>
          <label className="grid gap-1">Daily neuron cap<input type="number" min={0} max={10000} className="field" value={s.ai_neuron_daily_cap} onChange={(e) => setS({ ...s, ai_neuron_daily_cap: Number(e.target.value) })} /></label>
          <label className="grid gap-1">Uploads per team per round<input type="number" min={1} max={5} className="field" value={s.max_submissions_per_round} onChange={(e) => setS({ ...s, max_submissions_per_round: Number(e.target.value) })} /></label>
        </div>
        <button className="btn" onClick={() => act(() => api(`/api/events/${code}/host/settings`, { method: 'PUT', json: {
          judge_provider: s.judge_provider, judge_model: s.judge_model, r1_mode: s.r1_mode, eval_concurrency: s.eval_concurrency,
          max_attempts: s.max_attempts, ai_neuron_daily_cap: s.ai_neuron_daily_cap, max_submissions_per_round: s.max_submissions_per_round } }), 'Judge settings saved. They apply to rounds that have not started.')}>Save judge settings</button>
      </div>
      {locks.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Re-judge a whole round with the model above</summary>
          <div className="mt-3 grid gap-2">
            <p className="text-muted">Discards that round's scores and judges every entry again. Use only if the locked model is failing.</p>
            <select className="field" value={rejudge.round} onChange={(e) => setRejudge({ ...rejudge, round: Number(e.target.value) })}>
              {locks.map((r: any) => <option key={r.round_no} value={r.round_no}>Round {r.round_no}</option>)}
            </select>
            <input className="field" placeholder="Type REJUDGE to confirm" value={rejudge.confirm} onChange={(e) => setRejudge({ ...rejudge, confirm: e.target.value })} />
            <button className="btn btn-danger" disabled={rejudge.confirm !== 'REJUDGE'} onClick={() => act(() => api(`/api/events/${code}/host/rounds/${rejudge.round}/rejudge`, { method: 'POST', json: { provider: s.judge_provider, model: s.judge_model, mode: s.r1_mode, confirm: 'REJUDGE' } }), 'Round re-queued for judging.')}>Re-judge round</button>
          </div>
        </details>
      )}
    </Panel>
  );
}

function Calibration({ cal }: { cal: any }) {
  if (!cal) return <p className="text-sm text-muted">Not calibrated yet. Run it once before the round to check the judge.</p>;
  return (
    <div className="text-sm grid gap-1">
      <p className={cal.pass ? 'text-sub-g font-bold' : 'text-sub-r font-bold'}>{cal.pass ? 'Calibration passed' : 'Calibration failed — check the model before starting'}</p>
      {cal.results.map((r: any) => <p key={r.name} className="text-muted">{r.name}: {r.total ?? 'error'} ({r.expect === 'high' ? 'needs 75+' : 'needs 35 or less'}){r.error ? `, ${r.error}` : ''}{r.latencyMs ? `, ${(r.latencyMs / 1000).toFixed(1)} s` : ''}</p>)}
    </div>
  );
}

function RoundFields({ r, code, act }: { r: any; code: string; act: Act }) {
  const [f, setF] = useState({ title: r.title, brief: r.brief, minutes: Math.round(r.duration_sec / 60) });
  useEffect(() => setF({ title: r.title, brief: r.brief, minutes: Math.round(r.duration_sec / 60) }), [r.title, r.brief, r.duration_sec]);
  return (
    <div className="grid gap-3 text-sm">
      <div className="grid grid-cols-[1fr_7rem] gap-3">
        <label className="grid gap-1">Title<input className="field" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="grid gap-1">Minutes<input type="number" min={1} max={120} className="field" value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) })} /></label>
      </div>
      <label className="grid gap-1">Brief shown to teams<textarea className="field min-h-20" value={f.brief} onChange={(e) => setF({ ...f, brief: e.target.value })} /></label>
      <button className="btn btn-ghost justify-self-start" onClick={() => act(() => api(`/api/events/${code}/host/rounds/${r.round_no}`, { method: 'PUT', json: { title: f.title, brief: f.brief, duration_sec: f.minutes * 60 } }), 'Round saved.')}>Save round</button>
    </div>
  );
}

function RoundOne({ ov, code, act }: { ov: any; code: string; act: Act }) {
  const r = ov.rounds.find((x: any) => x.round_no === 1);
  const [busy, setBusy] = useState<string | null>(null);
  const [desc, setDesc] = useState(r.reference_description ?? '');
  useEffect(() => setDesc(r.reference_description ?? ''), [r.reference_description]);
  const input = useRef<HTMLInputElement>(null);
  const mode = r.locked_mode ?? ov.effectiveR1Mode;
  async function upload(file?: File) {
    if (!file) return;
    setBusy('upload');
    const p = await prepareImage(file);
    const fd = new FormData();
    fd.set('full', p.full, 'reference'); fd.set('judge', p.judge, 'judge.jpg'); fd.set('dhash', p.dhash);
    await act(() => api(`/api/events/${code}/host/rounds/1/reference`, { method: 'POST', body: fd }), 'Reference uploaded.');
    setBusy(null);
  }
  return (
    <Panel title={`Round 1: ${r.title}`} aside={r.locked_at ? <span className="text-sm text-muted">Locked</span> : null}>
      <RoundFields r={r} code={code} act={act} />
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr] items-start">
        {r.reference_image_url ? <img src={r.reference_image_url} alt="Reference" className="w-40 rounded-lg" /> : <div className="w-40 aspect-square rounded-lg bg-panel-2 grid place-items-center text-sm text-muted">No reference</div>}
        <div className="grid gap-2 text-sm">
          <input ref={input} type="file" accept="image/*" className="sr-only" onChange={(e) => upload(e.target.files?.[0])} />
          <button className="btn btn-ghost justify-self-start" disabled={!!r.locked_at || !!busy} onClick={() => input.current?.click()}>{busy === 'upload' ? 'Uploading…' : r.reference_image_url ? 'Replace reference' : 'Upload reference image'}</button>
          <p className="text-muted">Comparison mode: <b className="text-paper">{mode}</b></p>
        </div>
      </div>
      {mode === 'reference-description' && (
        <div className="grid gap-2 text-sm">
          <label htmlFor="desc" className="font-bold">Reference description the judge compares against</label>
          <textarea id="desc" className="field min-h-28" value={desc} disabled={!!r.locked_at} onChange={(e) => setDesc(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost" disabled={!r.reference_image_id || !!r.locked_at || !!busy} onClick={async () => { setBusy('desc'); await act(() => api(`/api/events/${code}/host/rounds/1/describe`, { method: 'POST' }), 'Description generated — read it and fix anything wrong.'); setBusy(null); }}>{busy === 'desc' ? 'Generating…' : 'Generate with AI'}</button>
            <button className="btn btn-ghost" disabled={!!r.locked_at} onClick={() => act(() => api(`/api/events/${code}/host/rounds/1`, { method: 'PUT', json: { reference_description: desc } }), 'Description saved.')}>Save description</button>
          </div>
        </div>
      )}
      <div className="grid gap-2">
        <button className="btn btn-ghost justify-self-start" disabled={!r.reference_image_id || !!busy} onClick={async () => { setBusy('cal'); await act(() => api(`/api/events/${code}/host/rounds/1/calibrate`, { method: 'POST' })); setBusy(null); }}>{busy === 'cal' ? 'Calibrating…' : 'Run calibration (2 AI calls)'}</button>
        <Calibration cal={r.calibration} />
      </div>
    </Panel>
  );
}

function RoundTwo({ ov, code, act }: { ov: any; code: string; act: Act }) {
  const r = ov.rounds.find((x: any) => x.round_no === 2);
  const [concepts, setConcepts] = useState<string[]>(r.concepts?.length === 3 ? r.concepts : ['', '', '']);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (r.concepts?.length === 3) setConcepts(r.concepts); }, [JSON.stringify(r.concepts)]);
  return (
    <Panel title={`Round 2: ${r.title}`} aside={r.locked_at ? <span className="text-sm text-muted">Locked</span> : null}>
      <RoundFields r={r} code={code} act={act} />
      <div className="grid gap-2 sm:grid-cols-3 text-sm">
        {concepts.map((c, i) => (
          <label key={i} className="grid gap-1">Concept {'ABC'[i]}
            <input className="field" value={c} disabled={!!r.locked_at} maxLength={80} onChange={(e) => setConcepts(concepts.map((x, j) => (j === i ? e.target.value : x)))} />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-ghost" disabled={!!r.locked_at || concepts.some((c) => !c.trim())} onClick={() => act(() => api(`/api/events/${code}/host/rounds/2`, { method: 'PUT', json: { concepts } }), 'Concepts saved.')}>Save concepts</button>
        <button className="btn btn-ghost" disabled={r.concepts?.length !== 3 || busy} onClick={async () => { setBusy(true); await act(() => api(`/api/events/${code}/host/rounds/2/calibrate`, { method: 'POST' })); setBusy(false); }}>{busy ? 'Calibrating…' : 'Run calibration (1 AI call)'}</button>
      </div>
      <Calibration cal={r.calibration} />
    </Panel>
  );
}

const FLAG_LABEL: Record<string, string> = {
  reference_copy: 'Looks like the reference itself', duplicate_exact: 'Identical to another team', near_duplicate: 'Very similar to another team',
  embedded_text: 'Contains text aimed at the judge', host_cleared: 'Cleared by host',
};

function Submissions({ ov, code, act }: { ov: any; code: string; act: Act }) {
  const [round, setRound] = useState<number>(ov.event.phase.startsWith('r2') || ov.event.phase === 'final' ? 2 : 1);
  const rows = ov.submissions.filter((s: any) => s.round_no === round);
  const held = rows.filter((s: any) => s.status === 'needs_review').length;
  const failed = rows.filter((s: any) => s.status === 'failed').length;
  return (
    <Panel title="Entries" aside={
      <div role="tablist" className="flex gap-1 rounded-xl bg-panel-2 p-1 text-sm">
        {[1, 2].map((n) => <button key={n} role="tab" aria-selected={round === n} onClick={() => setRound(n)} className={`px-3 min-h-9 rounded-lg font-bold ${round === n ? 'bg-paper text-dusk' : 'text-muted'}`}>Round {n}</button>)}
      </div>}>
      <p className="text-sm text-muted">{rows.length} entries, {rows.filter((s: any) => s.status === 'scored').length} scored{held ? `, ${held} held for review` : ''}{failed ? `, ${failed} failed` : ''}.</p>
      {!rows.length && <p className="text-muted">No entries yet.</p>}
      <ul className="grid gap-2">
        {rows.map((s: any) => (
          <li key={s.id} className={`grid grid-cols-[4rem_1fr_auto] gap-3 items-center rounded-xl p-2 ${s.status === 'needs_review' ? 'bg-warn/10 ring-1 ring-warn' : s.status === 'failed' ? 'bg-sub-r/10 ring-1 ring-sub-r' : 'bg-panel-2'}`}>
            <a href={s.image_url} target="_blank" rel="noreferrer"><img src={s.thumb_url} alt={`Entry by ${s.team}`} className="w-16 aspect-square rounded-lg object-cover" loading="lazy" /></a>
            <div className="min-w-0 text-sm">
              <p className="font-bold truncate">{s.team}</p>
              <StatusPill status={s.status} />
              {s.flags?.length > 0 && <p className="text-warn">{s.flags.map((f: string) => FLAG_LABEL[f] ?? f).join('; ')}</p>}
              {s.status === 'failed' && s.last_error && <p className="text-sub-r truncate" title={s.last_error}>{s.last_error}</p>}
              {s.job_status === 'retry' && <p className="text-muted">Retrying (attempt {s.attempts})</p>}
              {s.feedback && <p className="text-muted truncate" title={s.feedback}>{s.feedback}</p>}
            </div>
            <div className="grid justify-items-end gap-1">
              <span className="display text-2xl font-extrabold tabular-nums">{s.score_total != null ? Number(s.score_total).toFixed(1) : '–'}</span>
              <div className="flex gap-1">
                {s.status === 'needs_review' && <>
                  <button className="btn btn-ghost min-h-9 px-3 text-sm" onClick={() => act(() => api(`/api/events/${code}/host/submissions/${s.id}/approve`, { method: 'POST' }))}>Approve</button>
                  <button className="btn btn-danger min-h-9 px-3 text-sm" onClick={() => act(() => api(`/api/events/${code}/host/submissions/${s.id}/reject`, { method: 'POST' }))}>Reject</button>
                </>}
                {['failed', 'paused_quota', 'scored'].includes(s.status) && <button className="btn btn-ghost min-h-9 px-3 text-sm" onClick={() => act(() => api(`/api/events/${code}/host/submissions/${s.id}/requeue`, { method: 'POST' }), 'Sent back to the judge.')}>{s.status === 'scored' ? 'Re-score' : 'Retry'}</button>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Teams({ ov, code, act }: { ov: any; code: string; act: Act }) {
  const [reset, setReset] = useState<{ id: string; pin: string } | null>(null);
  return (
    <Panel title={`Teams (${ov.teams.length})`}>
      <ul className="grid gap-1 sm:grid-cols-2">
        {ov.teams.map((t: any) => (
          <li key={t.id} className={`rounded-lg px-3 py-2 bg-panel-2 text-sm ${t.disabled ? 'opacity-50' : ''}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold truncate">{t.name}</span>
              <span className="flex gap-2">
                <button className="underline underline-offset-2 text-muted" onClick={() => setReset({ id: t.id, pin: '' })}>Reset PIN</button>
                <button className="underline underline-offset-2 text-muted" onClick={() => act(() => api(`/api/events/${code}/host/teams/${t.id}/${t.disabled ? 'enable' : 'disable'}`, { method: 'POST' }))}>{t.disabled ? 'Enable' : 'Remove'}</button>
              </span>
            </div>
            <p className="text-muted">{t.sessions} device{t.sessions === 1 ? '' : 's'} logged in{t.locked_until && new Date(t.locked_until) > new Date() ? ', locked after wrong PINs' : ''}</p>
            {reset?.id === t.id && (
              <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); const pin = reset?.pin ?? ''; act(() => api(`/api/events/${code}/host/teams/${t.id}/reset-pin`, { method: 'POST', json: { pin } }), `New PIN set for ${t.name}.`); setReset(null); }}>
                <input className="field min-h-10" inputMode="numeric" placeholder="New PIN" value={reset?.pin ?? ''} onChange={(e) => setReset({ id: t.id, pin: e.target.value.replace(/\D/g, '') })} autoFocus />
                <button className="btn min-h-10">Set</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Audit({ ov }: { ov: any }) {
  return (
    <Panel title="Activity log">
      <ul className="grid gap-1 text-sm max-h-80 overflow-y-auto">
        {ov.audit.map((a: any, i: number) => (
          <li key={i} className="grid grid-cols-[6.5rem_1fr] gap-2">
            <span className="text-muted tabular-nums">{new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span className="truncate" title={JSON.stringify(a.detail)}>{a.action.replace(/_/g, ' ')}{a.detail?.to ? `: ${a.detail.to}` : ''}{a.detail?.msg ? `: ${a.detail.msg}` : ''}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
