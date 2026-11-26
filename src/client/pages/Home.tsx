import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Shell, Wordmark } from '../components/ui';

export function Home() {
  const [code, setCode] = useState('');
  const nav = useNavigate();
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return (
    <Shell>
      <div className="min-h-[85vh] flex flex-col justify-center gap-10">
        <div className="grid gap-4">
          <Wordmark size="md" />
          <h1 className="text-5xl font-extrabold">Turn words into the picture on the screen.</h1>
          <p className="text-muted max-w-[38ch]">Two rounds. Write prompts in any AI image generator, upload your best result, and an AI judge scores every entry blind.</p>
        </div>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (clean.length >= 4) nav(`/e/${clean}`); }}>
          <label htmlFor="code" className="font-bold">Event code</label>
          <input id="code" className="field display text-2xl tracking-[0.2em] uppercase" autoComplete="off" autoCapitalize="characters"
            placeholder="PIXEL1" value={clean} onChange={(e) => setCode(e.target.value)} />
          <button className="btn" disabled={clean.length < 4}>Join event</button>
          <p className="text-sm text-muted">Or scan the QR code on the big screen.</p>
        </form>
        <Link to="/host" className="text-sm text-muted underline underline-offset-4 self-start">Host console</Link>
      </div>
    </Shell>
  );
}
