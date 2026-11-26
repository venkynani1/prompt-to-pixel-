import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Notice, Shell, Wordmark } from '../components/ui';
import { api } from '../lib';

/** First-run page: creates an event from the browser (needs the ADMIN_TOKEN secret), then logs the host in. */
export function Setup() {
  const nav = useNavigate();
  const [health, setHealth] = useState<'checking' | 'ok' | string>('checking');
  const [f, setF] = useState({ token: '', code: 'PIXEL1', name: 'Hexaware Prompt to Pixel', password: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api('/api/health').then(() => setHealth('ok')).catch((e) => setHealth(e.message));
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const code = f.code.toUpperCase();
    try {
      await api('/api/admin/events', { method: 'POST', headers: { authorization: `Bearer ${f.token.trim()}` }, json: { code, name: f.name, hostPassword: f.password } })
        .catch((err) => { if (!/duplicate|unique|wrong on the server/i.test(err.message)) throw err; }); // already created → just log in
      await api(`/api/events/${code}/host/login`, { method: 'POST', json: { password: f.password } });
      nav(`/host/${code}`);
    } catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
  }

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Shell>
      <Wordmark size="sm" />
      <h1 className="mt-12 text-4xl font-extrabold">Create your event</h1>
      <div className="mt-4">
        {health === 'checking' && <Notice>Checking the server…</Notice>}
        {health === 'ok' && <Notice kind="ok">Server and database are connected.</Notice>}
        {health !== 'ok' && health !== 'checking' && <Notice kind="error">Server problem: {health}. Check the DATABASE_URL secret in Cloudflare.</Notice>}
      </div>
      <form onSubmit={create} className="mt-8 grid gap-5">
        <label className="grid gap-2"><span className="font-bold">Admin token</span>
          <input className="field" type="password" value={f.token} onChange={set('token')} autoComplete="off" required />
          <span className="text-sm text-muted">The ADMIN_TOKEN secret you added in Cloudflare.</span></label>
        <label className="grid gap-2"><span className="font-bold">Event code</span>
          <input className="field uppercase tracking-widest" value={f.code} onChange={set('code')} pattern="[A-Za-z0-9]{4,8}" required />
          <span className="text-sm text-muted">4–8 letters or numbers. Players type this or scan the QR.</span></label>
        <label className="grid gap-2"><span className="font-bold">Event name</span>
          <input className="field" value={f.name} onChange={set('name')} required /></label>
        <label className="grid gap-2"><span className="font-bold">Host password</span>
          <input className="field" type="password" value={f.password} onChange={set('password')} minLength={10} required />
          <span className="text-sm text-muted">At least 10 characters. You'll use it to log in to the host console.</span></label>
        {msg && <Notice kind="error">{msg}</Notice>}
        <button className="btn" disabled={busy || health !== 'ok'}>{busy ? 'Creating…' : 'Create event and open host console'}</button>
      </form>
    </Shell>
  );
}
