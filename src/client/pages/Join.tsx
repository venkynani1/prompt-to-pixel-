import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Notice, Shell, Wordmark } from '../components/ui';
import { api, useEventState } from '../lib';

export function Join() {
  const code = (useParams().code ?? '').toUpperCase();
  const nav = useNavigate();
  const { state, error } = useEventState(code);
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [teamName, setTeamName] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { if (state?.me) nav(`/e/${code}/play`, { replace: true }); }, [state?.me, code, nav]);
  useEffect(() => { if (state && !state.event.registrationOpen) setMode('login'); }, [state?.event.registrationOpen]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await api(`/api/events/${code}/${mode}`, { method: 'POST', json: { teamName, pin } });
      nav(`/e/${code}/play`);
    } catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
  }

  if (error && !state) return <Shell><Wordmark size="sm" /><div className="mt-16"><Notice kind="error">{error === 'Event not found' ? `No event with code ${code}. Check the code on the big screen.` : error}</Notice></div></Shell>;

  return (
    <Shell>
      <Wordmark size="sm" />
      <div className="mt-12 grid gap-8">
        <div>
          <p className="text-muted">{state?.event.name ?? 'Loading event…'}</p>
          <h1 className="text-4xl font-extrabold mt-1">{mode === 'register' ? 'Register your team' : 'Log back in'}</h1>
        </div>
        <div role="tablist" className="grid grid-cols-2 gap-1 rounded-xl bg-panel p-1">
          {(['register', 'login'] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} disabled={m === 'register' && state?.event.registrationOpen === false}
              onClick={() => setMode(m)} className={`min-h-11 rounded-lg font-bold ${mode === m ? 'bg-paper text-dusk' : 'text-muted'} disabled:opacity-40`}>
              {m === 'register' ? 'New team' : 'Existing team'}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="grid gap-5">
          <div className="grid gap-2">
            <label htmlFor="team" className="font-bold">Team name</label>
            <input id="team" className="field" maxLength={32} autoComplete="off" value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="e.g. Render Rangers" required />
          </div>
          <div className="grid gap-2">
            <label htmlFor="pin" className="font-bold">Team PIN</label>
            <input id="pin" className="field tracking-[0.4em] text-xl" inputMode="numeric" pattern="\d{4,8}" maxLength={8} autoComplete="off"
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} required />
            <p className="text-sm text-muted">{mode === 'register' ? '4–8 digits. Share it with your teammates so anyone can log in on their phone.' : 'The PIN your team chose at registration. The host can reset it.'}</p>
          </div>
          {msg && <Notice kind="error">{msg}</Notice>}
          <button className="btn" disabled={busy || teamName.trim().length < 2 || pin.length < 4}>{busy ? 'Please wait…' : mode === 'register' ? 'Register team' : 'Log in'}</button>
          <p className="text-sm text-muted">We only store your team name and a hashed PIN. No personal details.</p>
        </form>
      </div>
    </Shell>
  );
}
