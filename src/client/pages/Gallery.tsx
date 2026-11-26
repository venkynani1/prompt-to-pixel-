import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Notice, ScoreBreakdown, Shell, Wordmark } from '../components/ui';
import { api } from '../lib';

interface Item { id: string; team: string; score: number; prompt: string | null; feedback: string | null; criteria: Record<string, number>; imageUrl: string; thumbUrl: string }

export function Gallery() {
  const code = (useParams().code ?? '').toUpperCase();
  const [params, setParams] = useSearchParams();
  const roundNo = params.get('round') === '2' ? 2 : 1;
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Item | null>(null);

  useEffect(() => {
    setItems(null); setErr(null);
    api<Item[]>(`/api/events/${code}/gallery?round=${roundNo}`).then(setItems).catch((e) => setErr(e.message));
  }, [code, roundNo]);

  return (
    <Shell wide>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Link to={`/e/${code}/play`}><Wordmark size="sm" /></Link>
        <div role="tablist" className="flex gap-1 rounded-xl bg-panel p-1">
          {[1, 2].map((n) => (
            <button key={n} role="tab" aria-selected={roundNo === n} onClick={() => setParams({ round: String(n) })}
              className={`min-h-11 px-4 rounded-lg font-bold ${roundNo === n ? 'bg-paper text-dusk' : 'text-muted'}`}>Round {n}</button>
          ))}
        </div>
      </header>
      <h1 className="mt-10 text-5xl font-extrabold">Pixel Gallery</h1>
      {err && <div className="mt-6"><Notice kind="error">{err}</Notice></div>}
      {items && !items.length && <p className="mt-6 text-muted">No judged entries for this round yet.</p>}
      <ul className="mt-8 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {items?.map((it, i) => (
          <li key={it.id}>
            <button onClick={() => setOpen(it)} className="block w-full text-left">
              <img src={it.thumbUrl} alt={`Entry by ${it.team}`} loading="lazy" className="w-full aspect-square object-cover rounded-xl bg-panel" />
              <span className="mt-2 flex items-baseline justify-between gap-2">
                <span className="font-bold truncate">{i + 1}. {it.team}</span>
                <span className="display font-extrabold tabular-nums">{it.score.toFixed(1)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <div role="dialog" aria-modal="true" aria-label={`Entry by ${open.team}`} className="fixed inset-0 z-50 bg-dusk/95 overflow-y-auto p-5" onClick={() => setOpen(null)}>
          <div className="mx-auto max-w-4xl grid gap-6 md:grid-cols-[1.4fr_1fr]" onClick={(e) => e.stopPropagation()}>
            <img src={open.imageUrl} alt={`Entry by ${open.team}`} className="w-full rounded-2xl" />
            <div className="grid content-start gap-4">
              <div className="flex items-baseline justify-between"><h2 className="text-3xl font-extrabold">{open.team}</h2><span className="display text-4xl font-extrabold rgb-split">{open.score.toFixed(1)}</span></div>
              {open.prompt && <p><span className="text-muted">Prompt: </span>{open.prompt}</p>}
              {open.criteria && <ScoreBreakdown roundNo={roundNo} criteria={open.criteria} />}
              {open.feedback && <blockquote className="border-l-4 border-sub-b pl-4 text-muted">{open.feedback}</blockquote>}
              <button className="btn btn-ghost" onClick={() => setOpen(null)} autoFocus>Close</button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
