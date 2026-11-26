import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { SceneImage } from '../components/show';
import { Notice, ScoreBreakdown, Shell, Wordmark } from '../components/ui';
import { api } from '../lib';

interface Item {
  id: string; team: string; score: number; prompt: string | null; feedback: string | null; criteria: Record<string, number>;
  imageUrl: string; thumbUrl: string; turnId: string; roundNo: 1 | 2; seq: number; title: string; sceneId: string | null; concepts: string[];
}

/** Pixel Gallery: every revealed spin — the original scene (or mashup) and every team's image. */
export function Gallery() {
  const code = (useParams().code ?? '').toUpperCase();
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  useEffect(() => { api<Item[]>(`/api/events/${code}/gallery`).then(setItems).catch((e) => setErr(e.message)); }, [code]);

  const turns = new Map<string, Item[]>();
  for (const it of items ?? []) turns.set(it.turnId, [...(turns.get(it.turnId) ?? []), it]);

  return (
    <Shell wide>
      <Link to={`/e/${code}/play`}><Wordmark size="sm" /></Link>
      <h1 className="mt-10 text-5xl font-extrabold">Pixel Gallery</h1>
      {err && <div className="mt-6"><Notice kind="error">{err}</Notice></div>}
      {items && !items.length && <p className="mt-6 text-muted">Images appear here once the host reveals the scores.</p>}
      {[...turns.values()].map((list) => {
        const t = list[0];
        return (
          <section key={t.turnId} className="mt-10 grid gap-4">
            <h2 className="text-3xl font-extrabold">{t.roundNo === 1 ? `Scene ${t.seq}: ${t.title}` : `${t.title}: ${t.concepts.join(' + ')}`}</h2>
            <ul className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {t.sceneId && <li><SceneImage id={t.sceneId} className="w-full aspect-square object-cover ring-2 ring-paper" /><p className="mt-2 font-bold">The original</p></li>}
              {list.map((it, i) => (
                <li key={it.id}>
                  <button onClick={() => setOpen(it)} className="block w-full text-left">
                    <img src={it.thumbUrl} alt={`Image by ${it.team}`} loading="lazy" className="w-full aspect-square object-cover rounded-xl bg-panel" />
                    <span className="mt-2 flex items-baseline justify-between gap-2"><span className="font-bold truncate">{i + 1}. {it.team}</span><span className="display font-extrabold tabular-nums">{it.score.toFixed(0)}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {open && (
        <div role="dialog" aria-modal="true" aria-label={`Image by ${open.team}`} className="fixed inset-0 z-50 bg-dusk/95 overflow-y-auto p-5" onClick={() => setOpen(null)}>
          <div className="mx-auto max-w-4xl grid gap-6 md:grid-cols-[1.4fr_1fr]" onClick={(e) => e.stopPropagation()}>
            <img src={open.imageUrl} alt={`Image by ${open.team}`} className="w-full rounded-2xl" />
            <div className="grid content-start gap-4">
              <div className="flex items-baseline justify-between"><h2 className="text-3xl font-extrabold">{open.team}</h2><span className="display text-4xl font-extrabold rgb-split">{open.score.toFixed(0)}</span></div>
              {open.prompt && <p><span className="text-muted">Prompt: </span>{open.prompt}</p>}
              {open.criteria && <ScoreBreakdown roundNo={open.roundNo} criteria={open.criteria} />}
              {open.feedback && <blockquote className="border-l-4 border-sub-b pl-4 text-muted">{open.feedback}</blockquote>}
              <button className="btn btn-ghost" onClick={() => setOpen(null)} autoFocus>Close</button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
