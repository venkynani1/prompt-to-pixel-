import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Notice, Shell, Wordmark } from '../components/ui';
import { api } from '../lib';

/** The bare link takes players straight to the running event — nobody types a code. */
export function Home() {
  const nav = useNavigate();
  const [none, setNone] = useState(false);
  useEffect(() => {
    api<{ code: string | null }>('/api/active').then((r) => (r.code ? nav(`/e/${r.code}`, { replace: true }) : setNone(true))).catch(() => setNone(true));
  }, [nav]);
  return (
    <Shell>
      <div className="min-h-[80vh] flex flex-col justify-center gap-8">
        <Wordmark size="md" />
        {none ? (
          <>
            <h1 className="text-4xl font-extrabold">No game is running yet.</h1>
            <p className="text-muted">Scan the QR code on the big screen when the host opens registration.</p>
            <Link to="/host" className="btn btn-ghost self-start">I'm the host</Link>
          </>
        ) : <Notice>Finding the game…</Notice>}
      </div>
    </Shell>
  );
}
