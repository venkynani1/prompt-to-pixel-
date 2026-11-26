// Generates the static images used by the judge pipeline (committed to public/judge).
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
mkdirSync('public/judge', { recursive: true });
const label = (x: number, t: string) => `<text x="${x}" y="40" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700" fill="#111">${t}</text>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="560">
  <rect width="1000" height="560" fill="#ffffff"/>
  <rect x="498" y="0" width="4" height="560" fill="#111"/>
  ${label(20, 'A — ORIGINAL')}${label(520, 'B — ATTEMPT')}
</svg>`;
await sharp(Buffer.from(svg)).png().toFile('public/judge/composite-base.png');
await sharp({ create: { width: 512, height: 512, channels: 3, background: '#808080' } }).png().toFile('public/judge/calibration-blank.png');
console.log('judge assets written');
