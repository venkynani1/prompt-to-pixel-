import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Notice, Shell, Wordmark } from '../components/ui';
import { api, useEventState } from '../lib';

interface Slot { no: number; taken: boolean; name: string | null }

/**
 * BID WARS-style join: scan → see which team numbers are free → tap one → name it + make up a PIN.
 * Taken numbers show the team name; tapping one asks for that team's PIN (for teammates or a new phone).
 */
export function Join() {
  const code = (useParams().code ?? '').toUpperCase();
  const nav = useNavigate();
  const { state, error } = useEventState(code);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [pick, setPick] = useState<Slot | null>(null);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { if (state?.me) nav(`/e/${code}/play`, { replace: true }); }, [state?.me, code, nav]);
  useEffect(() => {
    let alive = true;
    const load = () => api(`/api/events/${code}/slots`).then((r) => alive && setSlots(r.slots)).catch(() => {});
    load();
    const t = setInterval(() => { if (!document.hidden && !pick) load(); }, 6000);
    return () => { alive = false; clearInterval(t); };
  }, [code, pick]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pick) return;
    setBusy(true); setMsg(null);
    try {
      if (pick.taken) await api(`/api/events/${code}/join`, { method: 'POST', json: { teamNo: pick.no, pin } });
      else await api(`/api/events/${code}/claim`, { method: 'POST', json: { teamNo: pick.no, pin, name } });
      nav(`/e/${code}/play`);
    } catch (err) {
      setMsg((err as Error).message);
      if (/taken|just took/i.test((err as Error).message)) { setPick(null); api(`/api/events/${code}/slots`).then((r) => setSlots(r.slots)); }
    } finally { setBusy(false); }
  }

  if (error && !state) return <Shell><Wordmark size="sm" /><div className="mt-16"><Notice kind="error">{error === 'Event not found' ? 'This game has ended. Scan the QR code on the big screen again.' : error}</Notice></div></Shell>;

  const free = slots?.filter((s) => !s.taken).length ?? 0;
  return (
    <Shell>
      <Wordmark size="sm" />
      {!pick ? (
        <div className="mt-10 grid gap-6">
          <div>
            <p className="text-muted">{state?.event.name ?? 'Loading…'}</p>
            <h1 className="text-5xl font-extrabold mt-1">Pick your team number</h1>
            <p className="text-muted mt-2">{slots ? `${free} free. Grey ones are taken — tap yours if your team already joined.` : 'Loading teams…'}</p>
          </div>
          {msg && <Notice kind="error">{msg}</Notice>}
          <ul className="grid grid-cols-4 gap-3">
            {slots?.map((s) => (
              <li key={s.no}>
                <button onClick={() => { setPick(s); setMsg(null); setPin(''); setPin2(''); setName(''); }}
                  className={`w-full aspect-square rounded-2xl grid place-items-center content-center gap-1 p-1 ${s.taken ? 'bg-panel text-muted' : 'bg-sub-g text-dusk active:scale-95'}`}>
                  <span className="display text-3xl font-extrabold">{s.no}</span>
                  <span className="text-[11px] leading-tight truncate max-w-full px-1">{s.taken ? s.name : 'free'}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-10 grid gap-5">
          <button type="button" className="text-left text-muted underline underline-offset-4" onClick={() => setPick(null)}>Back to team numbers</button>
          <h1 className="text-5xl font-extrabold">Team {pick.no}{pick.taken && pick.name ? `: ${pick.name}` : ''}</h1>
          {!pick.taken && (
            <label className="grid gap-2"><span className="font-bold">Team name</span>
              <input className="field text-xl" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. The Avengers" autoFocus required /></label>
          )}
          <label className="grid gap-2"><span className="font-bold">{pick.taken ? 'Your team PIN' : 'Make up a 4-digit PIN'}</span>
            <input className="field display text-3xl tracking-[0.4em]" inputMode="numeric" maxLength={4} autoComplete="off" required
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" autoFocus={pick.taken} />
            {!pick.taken && <span className="text-sm text-muted">Share it with your teammates so they can join on their phones too.</span>}
          </label>
          {!pick.taken && (
            <label className="grid gap-2"><span className="font-bold">Type the PIN again</span>
              <input className="field display text-3xl tracking-[0.4em]" inputMode="numeric" maxLength={4} autoComplete="off" required
                value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} placeholder="••••" /></label>
          )}
          {!pick.taken && pin2.length === 4 && pin !== pin2 && <Notice kind="error">The two PINs don't match.</Notice>}
          {msg && <Notice kind="error">{msg}</Notice>}
          <button className="btn text-lg" disabled={busy || pin.length !== 4 || (!pick.taken && (pin !== pin2 || name.trim().length < 2))}>
            {busy ? 'Joining…' : pick.taken ? 'Log in' : `Take team ${pick.no}`}
          </button>
        </form>
      )}
    </Shell>
  );
}
