import { useCallback, useEffect, useRef, useState } from 'react';
import type { StateResponse } from '../shared/types';

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(init.json); }
  const res = await fetch(path, { ...init, body, headers, credentials: 'same-origin' });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

/**
 * Adaptive polling with ETag/304, server-directed intervals, a clock offset for local countdowns,
 * an extra poll just after the local deadline, and pausing while the tab is hidden.
 */
export function useEventState(code: string, opts: { pk?: string; keepAliveHidden?: boolean } = {}) {
  const [state, setState] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0); // serverNow - clientNow
  const etag = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const deadlineTimer = useRef<number | undefined>(undefined);
  const failures = useRef(0);
  const best = useRef({ rtt: Infinity, at: 0 });
  const stopped = useRef(false);

  const poll = useCallback(async () => {
    window.clearTimeout(timer.current);
    let next = 10_000;
    try {
      const t0 = Date.now();
      const res = await fetch(`/api/events/${code}/state${opts.pk ? `?pk=${encodeURIComponent(opts.pk)}` : ''}`, {
        credentials: 'same-origin', headers: etag.current ? { 'if-none-match': etag.current } : {},
      });
      next = Number(res.headers.get('x-poll-ms')) || next;
      if (res.status === 304) { failures.current = 0; }
      else if (res.ok) {
        const s: StateResponse = await res.json();
        etag.current = res.headers.get('etag');
        // NTP-style: trust the sample with the smallest round trip (least asymmetric delay)
        const rtt = Date.now() - t0;
        const sample = new Date(s.serverNow).getTime() - (t0 + rtt / 2);
        if (rtt <= best.current.rtt || Date.now() - best.current.at > 120_000) {
          best.current = { rtt, at: Date.now() };
          setOffset(sample);
        }
        setState(s);
        setError(null);
        failures.current = 0;
      } else {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Server returned ${res.status}`);
      }
    } catch {
      failures.current++;
      setError('Connection lost — retrying');
      next = Math.min(30_000, 3000 * 2 ** failures.current);
    }
    if (stopped.current) return;
    if (document.hidden && !opts.keepAliveHidden) return; // resumes on visibilitychange
    timer.current = window.setTimeout(poll, next * (0.9 + Math.random() * 0.2));
  }, [code, opts.pk, opts.keepAliveHidden]);

  useEffect(() => {
    stopped.current = false;
    poll();
    const onVis = () => { if (!document.hidden) poll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stopped.current = true; window.clearTimeout(timer.current); document.removeEventListener('visibilitychange', onVis); };
  }, [poll]);

  // poll right after the server deadline so the phase flips without waiting a full interval
  useEffect(() => {
    window.clearTimeout(deadlineTimer.current);
    const d = state?.round?.deadlineAt;
    if (!d || !state?.event.phase.endsWith('_open')) return;
    const ms = new Date(d).getTime() - (Date.now() + offset) + 6500 + Math.random() * 2000;
    if (ms > 0 && ms < 3 * 3600_000) deadlineTimer.current = window.setTimeout(poll, ms);
    return () => window.clearTimeout(deadlineTimer.current);
  }, [state?.round?.deadlineAt, state?.event.phase, offset, poll]);

  const refresh = useCallback(() => { etag.current = null; return poll(); }, [poll]);
  return { state, error, offset, refresh };
}

export function useNow(intervalMs = 250) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

export function remainingMs(deadlineAt: string | null | undefined, offset: number, now: number) {
  if (!deadlineAt) return null;
  return Math.max(0, new Date(deadlineAt).getTime() - (now + offset));
}

export function fmtClock(ms: number) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ───────────── image preparation (all pixel work happens in the browser, not the Worker) ─────────────

async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' } as any); }
  catch { return await createImageBitmap(file); }
}

function canvasFor(bmp: ImageBitmap, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  return c;
}

const toBlob = (c: HTMLCanvasElement, type: string, q: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), type, q));

async function encode(c: HTMLCanvasElement, q: number) {
  const webp = await toBlob(c, 'image/webp', q);
  return webp.type === 'image/webp' ? webp : toBlob(c, 'image/jpeg', q); // older Safari can't encode WebP
}

/** 64-bit difference hash (9×8 greyscale) used for duplicate / copy detection. */
export function dHash(bmp: ImageBitmap): string {
  const c = document.createElement('canvas');
  c.width = 9; c.height = 8;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0, 9, 8);
  const px = g.getImageData(0, 0, 9, 8).data;
  const lum = (i: number) => px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let nib = 0;
    for (let x = 0; x < 8; x++) {
      const bit = lum((y * 9 + x) * 4) > lum((y * 9 + x + 1) * 4) ? 1 : 0;
      nib = (nib << 1) | bit;
      if (x % 4 === 3) { hex += nib.toString(16); nib = 0; }
    }
  }
  return hex;
}

export interface PreparedImage { full: Blob; judge: Blob; thumb: Blob; dhash: string; width: number; height: number; previewUrl: string }

/** Compress to ~300–500 KB (quality first, then size), plus a 512px judge copy and a thumbnail. */
export async function prepareImage(file: File, targetBytes = 480_000): Promise<PreparedImage> {
  if (!/^image\//.test(file.type)) throw new Error('Choose an image file');
  const bmp = await loadBitmap(file);
  const hash = dHash(bmp);
  let side = 1600, q = 0.88, full: Blob, c: HTMLCanvasElement;
  for (;;) {
    c = canvasFor(bmp, side);
    full = await encode(c, q);
    if (full.size <= targetBytes) break;
    if (q > 0.66) q -= 0.08; else if (side > 800) { side = Math.round(side * 0.8); q = 0.82; } else break;
  }
  const judge = await toBlob(canvasFor(bmp, 512), 'image/jpeg', 0.82);
  const thumb = await encode(canvasFor(bmp, 360), 0.72);
  const out = { full, judge, thumb, dhash: hash, width: c.width, height: c.height, previewUrl: URL.createObjectURL(full) };
  bmp.close();
  return out;
}

export function kb(n: number) { return `${Math.round(n / 1000)} KB`; }
