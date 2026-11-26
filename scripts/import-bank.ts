/**
 * Builds the Round 1 wheel images from originals in bank-src/{id}.webp (any size, square preferred).
 * Output → public/bank/{id}.webp (1024, shown to players), {id}-judge.jpg (512, what the AI compares
 * against) and {id}-thumb.webp (256, on the wheel). Add a scene: drop the file in bank-src/,
 * add it to ROUND1_SCENES in src/shared/bank.ts, run `npm run bank:import`.
 */
import sharp from 'sharp';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { ROUND1_SCENES } from '../src/shared/bank';

rmSync('public/bank', { recursive: true, force: true });
mkdirSync('public/bank', { recursive: true });
for (const s of ROUND1_SCENES) {
  const src = readdirSync('bank-src').find((f) => f.startsWith(`${s.id}.`));
  if (!src || !existsSync(`bank-src/${src}`)) throw new Error(`missing bank-src/${s.id}.*`);
  const img = sharp(`bank-src/${src}`).resize(1024, 1024, { fit: 'cover' });
  await img.clone().webp({ quality: 84 }).toFile(`public/bank/${s.id}.webp`);
  await img.clone().resize(512, 512).jpeg({ quality: 84 }).toFile(`public/bank/${s.id}-judge.jpg`);
  await img.clone().resize(256, 256).webp({ quality: 76 }).toFile(`public/bank/${s.id}-thumb.webp`);
  console.log('scene', s.id);
}
