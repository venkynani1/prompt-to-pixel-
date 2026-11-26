/**
 * Load-test engine shared by loadtest-local.ts (in-process stack, simulated judge) and
 * loadtest-remote.ts (your deployed workers.dev URL, REAL Workers AI).
 * Simulates N team devices: registration burst, adaptive polling with ETags, countdown sync,
 * a simultaneous upload burst, judging completion time, and leaderboard propagation.
 */
import sharp from 'sharp';

export interface LoadOptions {
  base: string; adminToken: string; teams: number; submitters: number; code: string;
  hostPassword: string; judgeTimeoutSec: number; referenceDescription?: string; log?: (s: string) => void;
}

class Jar {
  c = new Map<string, string>();
  constructor(private base: string) {}
  async raw(path: string, init: any = {}) {
    const headers: any = { ...(init.headers ?? {}) };
    if (this.c.size) headers.cookie = [...this.c].map(([k, v]) => `${k}=${v}`).join('; ');
    if (init.json) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(init.json); }
    const r = await fetch(this.base + path, { ...init, headers });
    for (const s of r.headers.getSetCookie()) { const [kv] = s.split(';'); const [k, v] = kv.split('='); this.c.set(k, v); }
    return r;
  }
  async call(path: string, init: any = {}) {
    const r = await this.raw(path, init);
    const t = await r.text();
    if (!r.ok) throw new Error(`${path} → ${r.status} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  }
}

const stats = (xs: number[]) => {
  if (!xs.length) return { n: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(s.at(-1)!), mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
};

async function timed<T>(fn: () => Promise<T>): Promise<[number, T | Error]> {
  const t = performance.now();
  try { const r = await fn(); return [performance.now() - t, r]; } catch (e) { return [performance.now() - t, e as Error]; }
}

/** ~400 KB WebP with unique noise so every team's file is different (like real AI art). */
async function teamImage(i: number) {
  const w = 1024, h = 1024, px = Buffer.alloc(w * h * 3);
  let seed = 1234 + i * 7919;
  for (let p = 0; p < px.length; p += 3) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = seed & 127, y = Math.floor(p / 3 / w);
    px[p] = (y / 4 + i * 20 + n) & 255; px[p + 1] = (120 + n) & 255; px[p + 2] = (200 - y / 6 + n) & 255;
  }
  const img = sharp(px, { raw: { width: w, height: h, channels: 3 } });
  const full = await img.clone().webp({ quality: 90 }).toBuffer();
  const judge = await img.clone().resize(512).jpeg({ quality: 82 }).toBuffer();
  const thumb = await img.clone().resize(360).webp({ quality: 72 }).toBuffer();
  return { full, judge, thumb };
}

export async function runLoad(o: LoadOptions) {
  const log = o.log ?? console.log;
  const report: any = { startedAt: new Date().toISOString(), base: o.base, teams: o.teams, submitters: o.submitters };
  const admin = new Jar(o.base);
  await admin.call('/api/admin/events', { method: 'POST', headers: { authorization: `Bearer ${o.adminToken}` }, json: { code: o.code, name: `Load test ${o.code}`, hostPassword: o.hostPassword } });
  const host = new Jar(o.base);
  await host.call(`/api/events/${o.code}/host/login`, { method: 'POST', json: { password: o.hostPassword } });
  const ref = await teamImage(999);
  const fd = new FormData(); fd.set('full', new Blob([ref.full]), 'r.webp'); fd.set('judge', new Blob([ref.judge]), 'j.jpg');
  await host.call(`/api/events/${o.code}/host/rounds/1/reference`, { method: 'POST', body: fd });
  await host.call(`/api/events/${o.code}/host/settings`, { method: 'PUT', json: { eval_concurrency: 4 } });
  if (o.referenceDescription) await host.call(`/api/events/${o.code}/host/rounds/1`, { method: 'PUT', json: { reference_description: o.referenceDescription } });
  else await host.call(`/api/events/${o.code}/host/rounds/1/describe`, { method: 'POST' });
  log('event ready — preparing images');
  const imgs = await Promise.all(Array.from({ length: o.submitters }, (_, i) => teamImage(i)));

  // 1. registration burst
  const jars = Array.from({ length: o.teams }, () => new Jar(o.base));
  const reg = await Promise.all(jars.map((j, i) => timed(() => j.call(`/api/events/${o.code}/register`, { method: 'POST', json: { teamName: `Load Team ${String(i + 1).padStart(3, '0')}`, pin: '4826' } }))));
  report.registration = { latencyMs: stats(reg.map((r) => r[0])), errors: reg.filter((r) => r[1] instanceof Error).map((r) => String((r[1] as Error).message)).slice(0, 5), errorCount: reg.filter((r) => r[1] instanceof Error).length };
  log(`registered ${o.teams - report.registration.errorCount}/${o.teams}`);

  // 2. polling devices (adaptive, ETag) — run in background for the rest of the test
  const poll = { requests: 0, notModified: 0, errors: 0, latency: [] as number[], offsets: [] as number[], deadlines: new Map<number, number>(), sawPhase: new Map<string, number[]>() };
  let stop = false;
  const bestRtt = new Map<number, { rtt: number; offset: number }>();
  const devices = jars.map(async (j, i) => {
    let etag: string | null = null, wait = Math.random() * 3000;
    while (!stop) {
      await new Promise((r) => setTimeout(r, wait));
      if (stop) break;
      const t0 = Date.now();
      try {
        const r = await j.raw(`/api/events/${o.code}/state`, { headers: etag ? { 'if-none-match': etag } : {} });
        const t1 = Date.now();
        poll.requests++; poll.latency.push(t1 - t0);
        wait = (Number(r.headers.get('x-poll-ms')) || 10000) * (0.9 + Math.random() * 0.2);
        if (r.status === 304) { poll.notModified++; await r.arrayBuffer(); continue; }
        if (!r.ok) { poll.errors++; await r.arrayBuffer(); continue; }
        etag = r.headers.get('etag');
        const s: any = await r.json();
        const rtt = t1 - t0;
        const b = bestRtt.get(i) ?? { rtt: Infinity, offset: 0 };
        if (rtt <= b.rtt) bestRtt.set(i, { rtt, offset: new Date(s.serverNow).getTime() - (t0 + rtt / 2) });
        const offset = bestRtt.get(i)!.offset; // same min-RTT rule the browser client uses
        if (s.round?.deadlineAt && s.event.phase.endsWith('_open')) poll.deadlines.set(i, new Date(s.round.deadlineAt).getTime() - offset); // local-clock deadline
        const arr = poll.sawPhase.get(s.event.phase) ?? []; arr.push(Date.now()); poll.sawPhase.set(s.event.phase, arr);
      } catch { poll.errors++; wait = 5000; }
    }
  });

  // 3. open round 1, upload burst
  await host.call(`/api/events/${o.code}/host/phase`, { method: 'POST', json: { to: 'r1_brief' } });
  await host.call(`/api/events/${o.code}/host/phase`, { method: 'POST', json: { to: 'r1_open' } });
  const openedAt = Date.now();
  log('round 1 open');
  report.imageBytes = stats(imgs.map((x) => x.full.length + x.judge.length + x.thumb.length));
  await new Promise((r) => setTimeout(r, 16_000)); // let every device see the open phase
  log(`upload burst: ${o.submitters} simultaneous uploads`);
  const burstAt = Date.now();
  const up = await Promise.all(imgs.map((img, i) => timed(() => {
    const f = new FormData();
    f.set('full', new Blob([img.full]), 'f.webp'); f.set('judge', new Blob([img.judge]), 'j.jpg'); f.set('thumb', new Blob([img.thumb]), 't.webp');
    f.set('prompt', `load test prompt ${i}`);
    return jars[i].call(`/api/events/${o.code}/submit`, { method: 'POST', body: f });
  })));
  report.uploads = { latencyMs: stats(up.map((r) => r[0])), errorCount: up.filter((r) => r[1] instanceof Error).length, errors: up.filter((r) => r[1] instanceof Error).map((r) => String((r[1] as Error).message)).slice(0, 5), burstDurationMs: Date.now() - burstAt };
  log(`uploads ok ${o.submitters - report.uploads.errorCount}/${o.submitters}, p95 ${report.uploads.latencyMs.p95} ms`);

  // countdown sync: spread of each device's computed local deadline
  const dl = [...poll.deadlines.values()];
  report.countdownSync = { devices: dl.length, spreadMs: dl.length ? Math.max(...dl) - Math.min(...dl) : null };

  // 4. close & wait for judging
  await host.call(`/api/events/${o.code}/host/phase`, { method: 'POST', json: { to: 'r1_judging' } });
  const closedAt = Date.now();
  let ov: any;
  for (;;) {
    ov = await host.call(`/api/events/${o.code}/host/overview`);
    const subs = ov.submissions.filter((s: any) => s.round_no === 1);
    const done = subs.filter((s: any) => ['scored', 'failed', 'needs_review', 'rejected'].includes(s.status)).length;
    const paused = subs.filter((s: any) => s.status === 'paused_quota').length;
    if (done + paused >= subs.length || Date.now() - closedAt > o.judgeTimeoutSec * 1000) {
      report.judging = {
        submissions: subs.length, scored: subs.filter((s: any) => s.status === 'scored').length,
        failed: subs.filter((s: any) => s.status === 'failed').length, paused,
        held: subs.filter((s: any) => s.status === 'needs_review').length,
        msFromBurstToAllDone: Date.now() - burstAt, msFromCloseToAllDone: Date.now() - closedAt,
        timedOut: Date.now() - closedAt > o.judgeTimeoutSec * 1000,
        neuronsUsedToday: ov.usage.today.ai_neurons ?? 0, aiCallsToday: ov.usage.today.ai_calls ?? 0,
        perEvalLatencyMs: stats(subs.map((s: any) => s.latency_ms).filter(Boolean)),
        perEvalNeurons: stats(subs.map((s: any) => Number(s.neurons_est)).filter((n: number) => n > 0)),
      };
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  log(`judging: ${report.judging.scored}/${report.judging.submissions} scored in ${(report.judging.msFromBurstToAllDone / 1000).toFixed(1)} s after the upload burst`);

  // 5. leaderboard propagation
  await host.call(`/api/events/${o.code}/host/phase`, { method: 'POST', json: { to: 'r1_results' } });
  const revealAt = Date.now();
  await new Promise((r) => setTimeout(r, 25_000));
  const seen = (poll.sawPhase.get('r1_results') ?? []).map((t) => t - revealAt).filter((x) => x >= 0);
  report.leaderboardPropagation = { devicesSeenWithin25s: new Set(seen).size >= 0 ? seen.length : 0, msToReach: stats(seen) };
  stop = true;
  await Promise.all(devices);
  report.polling = {
    requests: poll.requests, notModified: poll.notModified, errors: poll.errors, latencyMs: stats(poll.latency),
    requestsPerDevicePerMinute: +(poll.requests / o.teams / ((Date.now() - openedAt) / 60000)).toFixed(2),
  };
  report.finishedAt = new Date().toISOString();
  return report;
}

export function toMarkdown(r: any, title: string, notes: string[]) {
  const row = (k: string, s: any) => `| ${k} | ${s.n} | ${s.p50} | ${s.p95} | ${s.max} |`;
  return `# ${title}

Run: ${r.startedAt} → ${r.finishedAt}
Target: \`${r.base}\` · ${r.teams} team sessions · ${r.submitters} simultaneous uploads

${notes.map((n) => `> ${n}`).join('\n')}

## Latency (ms)

| Operation | Count | p50 | p95 | Max |
|---|---|---|---|---|
${row('Registration (burst)', r.registration.latencyMs)}
${row('Upload + submit (burst)', r.uploads.latencyMs)}
${row('State poll', r.polling.latencyMs)}

## Results

- Registration errors: **${r.registration.errorCount}** of ${r.teams}
- Upload errors: **${r.uploads.errorCount}** of ${r.submitters}${r.uploads.errors.length ? ` (${r.uploads.errors.join('; ')})` : ''}
- Upload size per submission (full + judge + thumb): p50 ${Math.round(r.imageBytes.p50 / 1000)} KB, max ${Math.round(r.imageBytes.max / 1000)} KB
- Countdown sync: ${r.countdownSync.devices} devices, spread of locally computed deadlines **${r.countdownSync.spreadMs} ms**
- Judging: **${r.judging.scored}/${r.judging.submissions}** scored, ${r.judging.failed} failed, ${r.judging.paused} paused for quota, ${r.judging.held} held for review${r.judging.timedOut ? ' — **TIMED OUT**' : ''}
- Time from upload burst to all judged: **${(r.judging.msFromBurstToAllDone / 1000).toFixed(1)} s**; from round close: **${(r.judging.msFromCloseToAllDone / 1000).toFixed(1)} s** (target ≤ 300 s)
- Per-evaluation latency: p50 ${r.judging.perEvalLatencyMs.p50} ms, p95 ${r.judging.perEvalLatencyMs.p95} ms
- AI neurons used today (estimate): ${Number(r.judging.neuronsUsedToday).toFixed(0)} across ${r.judging.aiCallsToday} calls (per eval p50 ${r.judging.perEvalNeurons.p50})
- Leaderboard reveal reached ${r.leaderboardPropagation.devicesSeenWithin25s} devices within 25 s (p50 ${r.leaderboardPropagation.msToReach.p50} ms, p95 ${r.leaderboardPropagation.msToReach.p95} ms)
- Polling: ${r.polling.requests} requests, ${r.polling.notModified} were 304 Not Modified, ${r.polling.errors} errors, **${r.polling.requestsPerDevicePerMinute} requests per device per minute**
`;
}
