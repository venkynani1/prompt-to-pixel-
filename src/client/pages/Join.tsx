import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Notice, Shell, Wordmark } from '../components/ui';
import { api, useEventState } from '../lib';

/** Scan → team number + PIN (from the slip the host hands out) → in. The phone stays logged in. */
export function Join() {
  const code = (useParams().code ?? '').toUpperCase();
  const nav = useNavigate();
  const { state, error } = useEventState(code);
  const [teamNo, setTeamNo] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { if (state?.me) nav(`/e/${code}/play`, { replace: true }); }, [state?.me, code, nav]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await api(`/api/events/${code}/join`, { method: 'POST', json: { teamNo: Number(teamNo), pin } });
      nav(`/e/${code}/play`);
    } catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
  }

  if (error && !state) return <Shell><Wordmark size="sm" /><div className="mt-16"><Notice kind="error">{error === 'Event not found' ? 'This game has ended. Scan the QR code on the big screen again.' : error}</Notice></div></Shell>;

  return (
    <Shell>
      <Wordmark size="sm" />
      <div className="mt-12 grid gap-8">
        <div>
          <p className="text-muted">{state?.event.name ?? 'Loading…'}</p>
          <h1 className="text-5xl font-extrabold mt-1">Join your team</h1>
        </div>
        <form onSubmit={submit} className="grid gap-5">
          <div className="grid gap-2">
            <label htmlFor="no" className="font-bold">Team number</label>
            <input id="no" className="field display text-3xl" inputMode="numeric" maxLength={3} autoComplete="off" required
              value={teamNo} onChange={(e) => setTeamNo(e.target.value.replace(/\D/g, ''))} placeholder="7" />
          </div>
          <div className="grid gap-2">
            <label htmlFor="pin" className="font-bold">Team PIN</label>
            <input id="pin" className="field display text-3xl tracking-[0.4em]" inputMode="numeric" maxLength={4} autoComplete="off" required
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" />
            <p className="text-sm text-muted">Both are on the slip the host gave your team.</p>
          </div>
          {msg && <Notice kind="error">{msg}</Notice>}
          <button className="btn text-lg" disabled={busy || !teamNo || pin.length !== 4}>{busy ? 'Joining…' : 'Join'}</button>
        </form>
      </div>
    </Shell>
  );
}
