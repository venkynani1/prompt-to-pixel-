/** Drives a full local game (simulated AI judge) and screenshots every screen into docs/screens. */
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { startLocal } from './local-server';

const OUT = process.env.SHOTS ?? 'docs/screens';
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Jar {
  c = new Map<string, string>();
  constructor(private base: string) {}
  async call(path: string, init: any = {}) {
    const headers: any = { ...(init.headers ?? {}) };
    if (this.c.size) headers.cookie = [...this.c].map(([k, v]) => `${k}=${v}`).join('; ');
    if (init.json) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(init.json); }
    const r = await fetch(this.base + path, { ...init, headers });
    for (const s of r.headers.getSetCookie()) { const [kv] = s.split(';'); const [k, v] = kv.split('='); this.c.set(k, v); }
    const t = await r.text();
    if (!r.ok) throw new Error(`${path}: ${r.status} ${t}`);
    return t ? JSON.parse(t) : null;
  }
}

async function art(seed: number) {
  const hue = (seed * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768"><rect width="100%" height="100%" fill="hsl(${hue},60%,45%)"/><circle cx="${300 + seed * 20}" cy="260" r="110" fill="hsl(${(hue + 160) % 360},90%,70%)"/><path d="M0 560 Q 300 ${400 + seed * 10} 768 540 V768 H0Z" fill="#1b1b2e"/></svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 82 }).toBuffer();
}

async function main() {
  const srv = await startLocal({ port: 0, judgeLatencyMs: 400, quiet: true });
  const base = `http://localhost:${srv.port}`;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--force-color-profile=srgb'] });
  const page = async (w: number, h: number, mobile = false) => { const p = await browser.newPage(); await p.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile }); return p; };
  const shot = async (p: any, name: string, full = false) => { await p.bringToFront(); await sleep(900); await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full }); console.log('shot', name); };

  // host creates the game in the browser (no codes, no tokens)
  const hostPage = await page(1440, 1000);
  await hostPage.goto(`${base}/host`, { waitUntil: 'networkidle0' });
  await shot(hostPage, '20-host-setup');
  const inputs = await hostPage.$$('input');
  await inputs[1].type('host-pass-1');
  await inputs[2].focus(); await hostPage.keyboard.press('Backspace'); await hostPage.keyboard.press('Backspace'); await inputs[2].type('12');
  await hostPage.click('button.btn'); await hostPage.waitForFunction(() => /^\/host\/[A-Z0-9]+$/.test(location.pathname), { timeout: 20000 });
  await sleep(1500);
  const code = new URL(hostPage.url()).pathname.split('/').pop()!;
  const host = new Jar(base);
  await host.call('/api/host/login', { method: 'POST', json: { password: 'host-pass-1' } });
  const ov = await host.call(`/api/events/${code}/host/overview`);
  const pk = ov.event.projectorKey;

  // phone: bare link → pick a free number → name + own PIN
  const phone = await page(390, 844, true);
  const early = new Jar(base);
  for (const [no, nm] of [[4, 'Byte Me'], [7, 'Pixel Pushers']] as const) await new Jar(base).call(`/api/events/${code}/claim`, { method: 'POST', json: { teamNo: no, pin: '4826', name: nm } });
  void early;
  await phone.goto(base, { waitUntil: 'networkidle0' });
  await sleep(1200);
  await shot(phone, '01-pick-team');
  const free = await phone.$$('ul button');
  await free[0].click(); await sleep(400);
  await phone.type('input', 'Glitch Gurus');
  const pinInputs = await phone.$$('input[inputmode="numeric"]');
  await pinInputs[0].type('5937'); await pinInputs[1].type('5937');
  await shot(phone, '02-claim-team');
  await phone.click('button.btn'); await phone.waitForFunction(() => location.pathname.endsWith('/play'), { timeout: 20000 });
  await sleep(1200);
  const names = ['Render Rangers', 'Prompt Pirates', 'Latent Legends', 'Diffusion Divas', 'Token Titans', 'Neural Nomads', 'Seed Squad'];
  const teams: Jar[] = [];
  for (let i = 0; i < names.length; i++) {
    const j = new Jar(base);
    await j.call(`/api/events/${code}/claim`, { method: 'POST', json: { teamNo: [2, 3, 5, 6, 8, 9, 11][i], pin: '4826', name: names[i] } });
    teams.push(j);
  }
  const screen = await page(1920, 1080);
  await screen.goto(`${base}/e/${code}/screen?pk=${pk}`, { waitUntil: 'networkidle0' });
  await shot(screen, '10-screen-lobby');
  await hostPage.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
  await shot(hostPage, '21-host-lobby', true);

  // Round 1 spin
  await host.call(`/api/events/${code}/host/action`, { method: 'POST', json: { action: 'spin1' } });
  await sleep(6500); await screen.bringToFront(); await sleep(100);
  await screen.screenshot({ path: `${OUT}/11-screen-wheel.png` }); console.log('shot 11-screen-wheel');
  await sleep(4500);
  await screen.screenshot({ path: `${OUT}/12-screen-memorise.png` }); console.log('shot 12-screen-memorise');
  await phone.bringToFront(); await phone.reload({ waitUntil: 'networkidle0' }); await sleep(300);
  await phone.screenshot({ path: `${OUT}/03-phone-memorise.png` }); console.log('shot 03-phone-memorise');
  await sleep(7000);
  for (let i = 0; i < teams.length; i++) { const f = new FormData(); const a = await art(i); for (const k of ['full', 'judge', 'thumb']) f.set(k, new Blob([a]), 'a.webp'); f.set('prompt', `moody cinematic scene, variant ${i}`); await teams[i].call(`/api/events/${code}/submit`, { method: 'POST', body: f }); }
  await sleep(1500);
  await screen.reload({ waitUntil: 'networkidle0' }); await shot(screen, '13-screen-countdown');
  await phone.reload({ waitUntil: 'networkidle0' }); await shot(phone, '04-phone-drop', true);
  await hostPage.reload({ waitUntil: 'networkidle0' }); await sleep(1500); await shot(hostPage, '22-host-live');

  await host.call(`/api/events/${code}/host/action`, { method: 'POST', json: { action: 'end' } });
  await sleep(3000);
  await host.call(`/api/events/${code}/host/action`, { method: 'POST', json: { action: 'reveal' } });
  await screen.reload({ waitUntil: 'networkidle0' }); await sleep(2500); await shot(screen, '14-screen-results');
  await hostPage.reload({ waitUntil: 'networkidle0' }); await sleep(1500); await shot(hostPage, '23-host-results');

  // Mystery round: spins paused, points by team number
  await host.call(`/api/events/${code}/host/action`, { method: 'POST', json: { action: 'mystery_start', title: 'Guess the movie from the emoji' } });
  for (const [no, pts] of [[3, 50], [8, 25], [5, -10], [2, 25]] as const) await host.call(`/api/events/${code}/host/bonus`, { method: 'POST', json: { teamNo: no, points: pts } });
  await screen.reload({ waitUntil: 'networkidle0' }); await sleep(2500); await shot(screen, '18-screen-mystery');
  await hostPage.reload({ waitUntil: 'networkidle0' }); await sleep(1500); await shot(hostPage, '24-host-mystery');
  await phone.reload({ waitUntil: 'networkidle0' }); await shot(phone, '06-phone-mystery');
  await host.call(`/api/events/${code}/host/action`, { method: 'POST', json: { action: 'mystery_end' } });
  // Round 2 is judged by the host
  await host.call(`/api/events/${code}/host/settings`, { method: 'PUT', json: { host_judges_next: true } });

  // Round 2
  await host.call(`/api/events/${code}/host/action`, { method: 'POST', json: { action: 'spin2' } });
  await sleep(6500); await screen.bringToFront(); await screen.screenshot({ path: `${OUT}/15-screen-reels.png` }); console.log('shot 15-screen-reels');
  await sleep(9000);
  await screen.screenshot({ path: `${OUT}/16-screen-r2-countdown.png` }); console.log('shot 16-screen-r2-countdown');
  for (let i = 0; i < teams.length; i++) { const f = new FormData(); const a = await art(30 + i); for (const k of ['full', 'judge', 'thumb']) f.set(k, new Blob([a]), 'a.webp'); await teams[i].call(`/api/events/${code}/submit`, { method: 'POST', body: f }); }
  await sleep(3000);
  await host.call(`/api/events/${code}/host/action`, { method: 'POST', json: { action: 'end' } });
  await hostPage.reload({ waitUntil: 'networkidle0' }); await sleep(1500); await shot(hostPage, '25-host-judging', true);
  const ov2 = await host.call(`/api/events/${code}/host/overview`);
  for (const [i, sub] of ov2.submissions.filter((x: any) => x.status === 'host_judging').entries())
    await host.call(`/api/events/${code}/host/submissions/${sub.id}/score`, { method: 'POST', json: { score: 50 + i * 6 } });
  await host.call(`/api/events/${code}/host/action`, { method: 'POST', json: { action: 'final' } });
  await screen.reload({ waitUntil: 'networkidle0' }); await sleep(3800); await shot(screen, '17-screen-final');
  await phone.reload({ waitUntil: 'networkidle0' }); await shot(phone, '05-phone-final');
  await browser.close(); srv.close(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
