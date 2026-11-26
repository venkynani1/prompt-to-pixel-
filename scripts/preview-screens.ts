/** Drives a full local game and screenshots each screen (used to review the UI). */
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { startLocal } from './local-server';

const OUT = process.env.SHOTS ?? 'docs/screens';
mkdirSync(OUT, { recursive: true });

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

async function art(seed: number, w = 768, h = 768) {
  const hue = (seed * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,20%)"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${w * 0.7}" cy="${h * 0.3}" r="${w * 0.12}" fill="hsl(${(hue + 180) % 360},90%,70%)"/>
    <path d="M0 ${h * 0.75} Q ${w * 0.3} ${h * (0.5 + (seed % 5) / 20)} ${w * 0.6} ${h * 0.72} T ${w} ${h * 0.68} V ${h} H 0 Z" fill="hsl(${(hue + 30) % 360},40%,12%)"/>
    <rect x="${w * 0.2}" y="${h * 0.48}" width="${w * 0.08}" height="${h * 0.3}" fill="hsl(${hue},20%,8%)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 82 }).toBuffer();
}

async function main() {
  const srv = await startLocal({ port: 0, judgeLatencyMs: 300, quiet: true });
  const base = `http://localhost:${srv.port}`;
  const code = 'DEMO26';
  const admin = new Jar(base);
  await admin.call('/api/admin/events', { method: 'POST', headers: { authorization: 'Bearer local-admin-token' }, json: { code, name: 'Hexaware Innovation Day', hostPassword: 'host-password-1' } });
  const host = new Jar(base);
  await host.call(`/api/events/${code}/host/login`, { method: 'POST', json: { password: 'host-password-1' } });
  const ov = await host.call(`/api/events/${code}/host/overview`);
  const pk = ov.event.projectorKey;
  const ref = await art(3);
  const fd = new FormData(); fd.set('full', new Blob([ref]), 'r.webp'); fd.set('judge', new Blob([ref]), 'j.webp'); fd.set('dhash', 'ffffffffffffffff');
  await host.call(`/api/events/${code}/host/rounds/1/reference`, { method: 'POST', body: fd });
  await host.call(`/api/events/${code}/host/rounds/2`, { method: 'PUT', json: { concepts: ['Chennai auto-rickshaw', 'Samurai armour', 'Deep-sea bioluminescence'] } });

  const names = ['Render Rangers', 'Prompt Pirates', 'Latent Legends', 'Diffusion Divas', 'Token Titans', 'Neural Nomads', 'Seed Squad', 'Pixel Pushers', 'CFG Crew', 'Noise Ninjas', 'Upscale United', 'Byte Me'];
  const teams: Jar[] = [];
  for (const n of names) { const j = new Jar(base); await j.call(`/api/events/${code}/register`, { method: 'POST', json: { teamName: n, pin: '4826' } }); teams.push(j); }

  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--force-color-profile=srgb'] });
  const phone = async () => { const p = await browser.newPage(); await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); return p; };
  const shot = async (p: any, name: string, full = false) => { await p.bringToFront(); await new Promise((r) => setTimeout(r, 1800)); await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full }); console.log('shot', name); };

  const home = await phone(); await home.goto(base, { waitUntil: 'networkidle0' }); await shot(home, '01-home');
  const me = await phone(); await me.goto(`${base}/e/${code}`, { waitUntil: 'networkidle0' });
  await me.type('#team', 'Glitch Gurus'); await me.type('#pin', '5937'); await shot(me, '02-register');
  await me.click('button.btn'); await me.waitForNavigation({ waitUntil: 'networkidle0' }); await shot(me, '03-lobby');

  const screen = await browser.newPage(); await screen.setViewport({ width: 1920, height: 1080 });
  await screen.goto(`${base}/e/${code}/screen?pk=${pk}`, { waitUntil: 'networkidle0' }); await shot(screen, '10-projector-lobby');

  const phase = (to: string) => host.call(`/api/events/${code}/host/phase`, { method: 'POST', json: { to } });
  await host.call(`/api/events/${code}/host/rounds/1/describe`, { method: 'POST' });
  await phase('r1_brief'); await screen.reload({ waitUntil: 'networkidle0' }); await shot(screen, '11-projector-brief');
  await me.reload({ waitUntil: 'networkidle0' }); await shot(me, '04-brief', true);
  await phase('r1_open');
  await me.reload({ waitUntil: 'networkidle0' }); await shot(me, '05-round1-live', true);
  for (let i = 0; i < 8; i++) { const f = new FormData(); const a = await art(10 + i); for (const k of ['full', 'judge', 'thumb']) f.set(k, new Blob([a]), 'a.webp'); f.set('prompt', `cinematic dusk landscape, glowing moon, variant ${i}`); await teams[i].call(`/api/events/${code}/submit`, { method: 'POST', body: f }); }
  await screen.reload({ waitUntil: 'networkidle0' }); await shot(screen, '12-projector-round1-live');

  const hostPage = await browser.newPage(); await hostPage.setViewport({ width: 1440, height: 1000 });
  await hostPage.goto(`${base}/host`, { waitUntil: 'networkidle0' });
  await hostPage.type('#hc', code); await hostPage.type('#hp', 'host-password-1');
  await Promise.all([hostPage.waitForNavigation({ waitUntil: 'networkidle0' }), hostPage.click('button.btn')]);
  await new Promise((r) => setTimeout(r, 2500));
  await shot(hostPage, '20-host-console', true);

  await phase('r1_judging'); await screen.reload({ waitUntil: 'networkidle0' }); await shot(screen, '13-projector-judging');
  await new Promise((r) => setTimeout(r, 2500));
  await phase('r1_results');
  await screen.reload({ waitUntil: 'networkidle0' }); await shot(screen, '14-projector-results');
  await teams[0].call('/api/logout', { method: 'POST' });
  await me.reload({ waitUntil: 'networkidle0' }); await shot(me, '06-results', true);
  await me.goto(`${base}/e/${code}/gallery?round=1`, { waitUntil: 'networkidle0' }); await shot(me, '07-gallery');

  await phase('r2_brief'); await phase('r2_open');
  await screen.reload({ waitUntil: 'networkidle0' }); await shot(screen, '15-projector-round2-live');
  for (let i = 1; i < 10; i++) { const f = new FormData(); const a = await art(40 + i); for (const k of ['full', 'judge', 'thumb']) f.set(k, new Blob([a]), 'a.webp'); await teams[i].call(`/api/events/${code}/submit`, { method: 'POST', body: f }).catch(() => {}); }
  await new Promise((r) => setTimeout(r, 3000));
  await phase('r2_judging'); await phase('r2_results'); await phase('final');
  await screen.reload({ waitUntil: 'networkidle0' }); await new Promise((r) => setTimeout(r, 3000)); await shot(screen, '16-projector-final');
  await browser.close();
  srv.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
