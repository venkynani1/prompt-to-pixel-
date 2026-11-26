/**
 * Draws the built-in Round 1 scene bank: 12 ORIGINAL flat "movie still" illustrations, one per genre.
 * No real films, characters, logos or posters are depicted. Output → public/bank/{id}.webp (1024),
 * {id}-judge.jpg (512, what the AI compares against) and {id}-thumb.webp (256, used on the wheel).
 */
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const S = 1024;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const svg = (body: string, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><defs>${defs}</defs>${body}</svg>`;
const lin = (id: string, stops: [number, string][], vertical = true) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>`;
const rad = (id: string, inner: string, outer: string) => `<radialGradient id="${id}"><stop offset="0" stop-color="${inner}"/><stop offset="1" stop-color="${outer}" stop-opacity="0"/></radialGradient>`;
const stars = (n: number, maxY: number, op = 0.9) => Array.from({ length: n }, () => `<circle cx="${(rnd() * S).toFixed(0)}" cy="${(rnd() * maxY).toFixed(0)}" r="${(rnd() * 2.2 + 0.6).toFixed(1)}" fill="#fff" opacity="${(op * (0.4 + rnd() * 0.6)).toFixed(2)}"/>`).join('');
const person = (x: number, y: number, h: number, fill: string, extra = '') => {
  const w = h * 0.28;
  return `<g fill="${fill}">
    <circle cx="${x}" cy="${y - h + w * 0.45}" r="${w * 0.42}"/>
    <rect x="${x - w / 2}" y="${y - h + w * 0.85}" width="${w}" height="${h * 0.48}" rx="${w * 0.3}"/>
    <rect x="${x - w / 2}" y="${y - h * 0.32}" width="${w * 0.4}" height="${h * 0.32}" rx="${w * 0.15}"/>
    <rect x="${x + w * 0.1}" y="${y - h * 0.32}" width="${w * 0.4}" height="${h * 0.32}" rx="${w * 0.15}"/>${extra}</g>`;
};

const scenes: Record<string, () => string> = {
  'desert-showdown': () => svg(`
    <rect width="${S}" height="${S}" fill="url(#sky)"/>
    <circle cx="512" cy="560" r="170" fill="#ffd36b"/>
    <path d="M0 600 L120 600 L140 470 L330 470 L350 600 L640 600 L660 520 L760 520 L790 600 L1024 600 V1024 H0Z" fill="#9c3d2e"/>
    <rect y="640" width="${S}" height="384" fill="url(#sand)"/>
    <g fill="#2f4a2b"><rect x="120" y="660" width="34" height="200" rx="16"/><rect x="74" y="700" width="30" height="90" rx="14"/><rect x="74" y="760" width="70" height="30" rx="14"/><rect x="160" y="720" width="30" height="70" rx="14"/><rect x="140" y="770" width="50" height="28" rx="14"/></g>
    ${person(512, 900, 300, '#2a1410', `<ellipse cx="512" cy="${900 - 300 + 30}" rx="95" ry="18"/><rect x="472" y="${900 - 300 - 15}" width="80" height="45" rx="10"/>`)}
    <ellipse cx="512" cy="905" rx="150" ry="16" fill="#000" opacity="0.25"/>
    <circle cx="840" cy="880" r="38" fill="none" stroke="#7a4a2a" stroke-width="6" stroke-dasharray="14 8"/>`,
    lin('sky', [[0, '#3b1f5c'], [0.45, '#e2553b'], [0.75, '#ff9f45']]) + lin('sand', [[0, '#e8a35e'], [1, '#b86a35']])),

  'neon-rain': () => svg(`
    <rect width="${S}" height="${S}" fill="url(#sky)"/>
    ${[[0, 260, 380], [190, 200, 520], [360, 180, 300], [520, 230, 600], [730, 160, 420], [870, 154, 520]].map(([x, w, h]) =>
      `<rect x="${x}" y="${720 - h}" width="${w}" height="${h}" fill="#141a33"/>` +
      Array.from({ length: 18 }, () => `<rect x="${x + 14 + rnd() * (w - 40)}" y="${720 - h + 20 + rnd() * (h - 60)}" width="14" height="20" fill="${rnd() > 0.5 ? '#ffd86b' : '#5ad1ff'}" opacity="${(0.4 + rnd() * 0.6).toFixed(2)}"/>`).join('')).join('')}
    <rect x="230" y="380" width="120" height="44" rx="10" fill="none" stroke="#ff3ea5" stroke-width="10"/>
    <rect x="600" y="300" width="60" height="180" rx="10" fill="none" stroke="#2ef2ff" stroke-width="10"/>
    <rect y="720" width="${S}" height="304" fill="#0b0f22"/>
    <rect y="720" width="${S}" height="304" fill="url(#refl)" opacity="0.5"/>
    ${person(700, 940, 260, '#05060d', `<path d="M600 ${940 - 230} Q700 ${940 - 330} 800 ${940 - 230}Z"/><rect x="697" y="${940 - 240}" width="6" height="120"/>`)}
    ${Array.from({ length: 140 }, () => { const x = rnd() * S, y = rnd() * S; return `<line x1="${x}" y1="${y}" x2="${x - 14}" y2="${y + 46}" stroke="#9fd8ff" stroke-width="2" opacity="0.35"/>`; }).join('')}`,
    lin('sky', [[0, '#090b1c'], [1, '#3a1c5c']]) + lin('refl', [[0, '#ff3ea5'], [0.5, '#2ef2ff'], [1, '#0b0f22']])),

  'twin-moons': () => svg(`
    <rect width="${S}" height="${S}" fill="url(#sky)"/>${stars(160, 600)}
    <circle cx="300" cy="260" r="130" fill="#f4d9ff"/><circle cx="340" cy="230" r="130" fill="url(#sky)" opacity="0.35"/>
    <circle cx="760" cy="180" r="70" fill="#9ee7ff"/>
    <path d="M0 720 Q200 600 420 700 T820 660 T1024 690 V1024 H0Z" fill="#3b1d63"/>
    <path d="M0 820 Q260 740 520 820 T1024 800 V1024 H0Z" fill="#22113f"/>
    <g transform="translate(520 470) rotate(-12)"><ellipse rx="190" ry="44" fill="#c9d2e6"/><ellipse cy="-26" rx="80" ry="46" fill="#7fe8ff" opacity="0.9"/><ellipse rx="190" ry="44" fill="none" stroke="#5d6a85" stroke-width="6"/>
      ${[-120, -60, 0, 60, 120].map((x) => `<circle cx="${x}" cy="14" r="9" fill="#ffe66b"/>`).join('')}</g>
    <polygon points="430,520 610,520 700,900 340,900" fill="#9ee7ff" opacity="0.18"/>`,
    lin('sky', [[0, '#120a2e'], [0.6, '#4b2a86'], [1, '#c2527a']])),

  'haunted-hill': () => svg(`
    <rect width="${S}" height="${S}" fill="url(#sky)"/>
    <circle cx="760" cy="230" r="140" fill="#f2f0c9"/><circle cx="760" cy="230" r="230" fill="url(#glow)"/>
    <path d="M0 780 Q300 560 620 640 T1024 600 V1024 H0Z" fill="#1d2a22"/>
    <g fill="#0d1210"><rect x="330" y="420" width="300" height="260"/><polygon points="310,430 480,300 650,430"/><rect x="560" y="330" width="40" height="110"/><rect x="250" y="500" width="110" height="180"/><polygon points="240,510 305,440 370,510"/></g>
    ${[[380, 480], [450, 480], [520, 480], [380, 570], [520, 570], [280, 560]].map(([x, y]) => `<rect x="${x}" y="${y}" width="40" height="55" fill="#ffcf4a" opacity="0.85"/>`).join('')}
    <path d="M110 1024 L130 700 Q100 640 60 610 M130 700 Q170 640 220 620 M126 760 Q90 720 40 720" stroke="#0d1210" stroke-width="22" fill="none" stroke-linecap="round"/>
    ${[[640, 160], [700, 120], [860, 330]].map(([x, y]) => `<path d="M${x} ${y} q15 -18 30 0 q15 -18 30 0 q-15 8 -30 20 q-15 -12 -30 -20Z" fill="#0d1210"/>`).join('')}`,
    lin('sky', [[0, '#1c2b3a'], [1, '#5d7d6b']]) + rad('glow', '#f2f0c9', '#f2f0c9')),

  'storm-ship': () => svg(`
    <rect width="${S}" height="${S}" fill="url(#sky)"/>
    <polyline points="760,0 700,190 760,200 660,420" fill="none" stroke="#fff6b0" stroke-width="12"/>
    <g transform="translate(470 560) rotate(-8)">
      <path d="M-260 0 L260 0 L200 110 L-200 110Z" fill="#4a2a17"/>
      <rect x="-12" y="-400" width="14" height="400" fill="#3a2010"/><rect x="-170" y="-300" width="12" height="300" fill="#3a2010"/>
      <path d="M-5 -380 Q120 -300 -5 -160Z" fill="#efe6cf"/><path d="M-5 -150 Q140 -90 -5 -20Z" fill="#efe6cf"/>
      <path d="M-164 -280 Q-60 -220 -164 -120Z" fill="#e2d7bc"/>
      <rect x="-12" y="-420" width="60" height="30" fill="#111"/></g>
    <path d="M0 640 Q120 560 240 640 T480 640 T720 640 T960 640 T1200 640 V1024 H0Z" fill="#1d4d6b"/>
    <path d="M0 720 Q140 650 280 720 T560 720 T840 720 T1120 720 V1024 H0Z" fill="#163a52"/>
    <path d="M0 820 Q160 760 320 820 T640 820 T960 820 T1280 820 V1024 H0Z" fill="#0f2a3d"/>
    ${Array.from({ length: 40 }, () => `<circle cx="${rnd() * S}" cy="${620 + rnd() * 260}" r="${4 + rnd() * 8}" fill="#e8f6ff" opacity="0.5"/>`).join('')}`,
    lin('sky', [[0, '#1c2230'], [1, '#55677a']])),

  'lost-temple': () => svg(`
    <rect width="${S}" height="${S}" fill="url(#sky)"/>
    <g fill="#7b6a4a">${[0, 1, 2, 3, 4].map((i) => `<rect x="${262 + i * 50}" y="${640 - i * 90}" width="${500 - i * 100}" height="92"/>`).join('')}<rect x="462" y="190" width="100" height="90"/></g>
    <rect x="482" y="560" width="60" height="80" fill="#2a1f12"/>
    <polygon points="512,170 470,200 554,200" fill="#d9b24a"/>
    <rect y="0" width="${S}" height="${S}" fill="url(#mist)"/>
    ${[[0, '#1f5a2e'], [1, '#2f7a3a']].map(([o, c]) => `<path d="M0 ${740 + Number(o) * 80} Q150 ${640 + Number(o) * 60} 300 ${740 + Number(o) * 80} T600 ${740 + Number(o) * 80} T1024 ${730 + Number(o) * 80} V1024 H0Z" fill="${c}"/>`).join('')}
    ${[60, 180, 860, 960].map((x) => `<path d="M${x} 0 Q${x + 30} 200 ${x - 10} 420" stroke="#174a22" stroke-width="14" fill="none"/><ellipse cx="${x}" cy="40" rx="140" ry="70" fill="#1b5228"/>`).join('')}`,
    lin('sky', [[0, '#9fd4b0'], [1, '#e9f3d8']]) + lin('mist', [[0, '#ffffff00'], [0.6, '#ffffff55'], [1, '#ffffff00']])),

  'monsoon-love': () => svg(`
    <rect width="${S}" height="${S}" fill="url(#sky)"/>
    <rect x="160" y="180" width="18" height="620" fill="#2b2b3a"/><circle cx="210" cy="190" r="34" fill="#ffd36b"/><circle cx="210" cy="190" r="160" fill="url(#lamp)"/>
    <rect y="800" width="${S}" height="224" fill="#2c3550"/>
    ${person(520, 880, 300, '#1a1530')}${person(660, 880, 280, '#1a1530')}
    <path d="M400 ${880 - 280} A130 110 0 0 1 660 ${880 - 280}Z" fill="#e5364b"/>
    <rect x="528" y="${880 - 280}" width="6" height="110" fill="#1a1530"/>
    <ellipse cx="590" cy="960" rx="260" ry="30" fill="#ffd36b" opacity="0.18"/>
    ${Array.from({ length: 160 }, () => { const x = rnd() * S, y = rnd() * S; return `<line x1="${x}" y1="${y}" x2="${x - 8}" y2="${y + 40}" stroke="#cde3ff" stroke-width="2" opacity="0.45"/>`; }).join('')}`,
    lin('sky', [[0, '#2a3a63'], [1, '#6a7fa8']]) + rad('lamp', '#ffd36b', '#ffd36b')),

  'rooftop-hero': () => svg(`
    <rect width="${S}" height="${S}" fill="url(#sky)"/>
    <circle cx="512" cy="430" r="200" fill="#ffb347" opacity="0.9"/>
    ${[[0, 120, 420], [130, 90, 520], [230, 140, 360], [700, 130, 480], [840, 90, 400], [940, 84, 560]].map(([x, w, h]) => `<rect x="${x}" y="${S - h}" width="${w}" height="${h}" fill="#2c1838"/>`).join('')}
    <rect x="360" y="700" width="320" height="324" fill="#1a0e22"/>
    <path d="M512 330 L420 690 L604 690Z" fill="#c4122f"/>
    ${person(512, 700, 360, '#120818')}
    <path d="M470 ${700 - 230} L420 ${700 - 170} M554 ${700 - 230} L604 ${700 - 170}" stroke="#120818" stroke-width="26" stroke-linecap="round"/>`,
    lin('sky', [[0, '#3a0f4d'], [0.5, '#d1495b'], [1, '#ffb347']])),

  'deep-kingdom': () => svg(`
    <rect width="${S}" height="${S}" fill="url(#sea)"/>
    ${[120, 360, 640, 880].map((x) => `<polygon points="${x - 40},0 ${x + 40},0 ${x + 160},1024 ${x - 160},1024" fill="#bff3ff" opacity="0.08"/>`).join('')}
    <g fill="#1d5a7a"><rect x="380" y="460" width="260" height="360"/><rect x="330" y="380" width="80" height="440"/><rect x="610" y="380" width="80" height="440"/><rect x="472" y="300" width="80" height="520"/></g>
    <g fill="#3fb6c9">${[[370, 380], [650, 380], [512, 300]].map(([x, y]) => `<polygon points="${x - 50},${y} ${x + 50},${y} ${x},${y - 110}"/>`).join('')}</g>
    <path d="M480 820 V700 A32 32 0 0 1 544 700 V820Z" fill="#ffe28a"/>
    <path d="M0 860 Q200 800 400 870 T800 860 T1024 850 V1024 H0Z" fill="#c9a26b"/>
    ${[[160, 860, '#ff6b81'], [250, 880, '#ffb347'], [820, 870, '#ff6b81'], [900, 890, '#b388ff']].map(([x, y, c]) => `<path d="M${x} ${y} q-20 -80 0 -140 q20 60 0 140 q30 -60 50 -110 q-10 70 -50 110" fill="${c}"/>`).join('')}
    ${[[220, 300, '#ffd166'], [780, 240, '#ff8fab'], [860, 520, '#ffd166'], [150, 560, '#8ae8ff']].map(([x, y, c]) => `<g fill="${c}"><ellipse cx="${x}" cy="${y}" rx="44" ry="24"/><polygon points="${Number(x) + 40},${y} ${Number(x) + 80},${Number(y) - 22} ${Number(x) + 80},${Number(y) + 22}"/></g>`).join('')}
    ${Array.from({ length: 30 }, () => `<circle cx="${rnd() * S}" cy="${rnd() * 800}" r="${3 + rnd() * 8}" fill="none" stroke="#e0fbff" stroke-width="2" opacity="0.6"/>`).join('')}`,
    lin('sea', [[0, '#2bb3c9'], [1, '#08304a']])),

  'midnight-chase': () => svg(`
    <rect width="${S}" height="${S}" fill="url(#sky)"/>${stars(60, 300, 0.6)}
    ${Array.from({ length: 14 }, (_, i) => `<rect x="${i * 76}" y="${330 - (i % 3) * 40}" width="70" height="${120 + (i % 3) * 40}" fill="#1c1f3d"/>`).join('')}
    <polygon points="0,1024 1024,1024 600,450 424,450" fill="#22243a"/>
    ${[0, 1, 2, 3, 4].map((i) => `<polygon points="${505 - i * 4},${470 + i * 120} ${519 + i * 4},${470 + i * 120} ${521 + i * 8},${530 + i * 140} ${503 - i * 8},${530 + i * 140}" fill="#ffd36b"/>`).join('')}
    <g transform="translate(512 820)">
      <polygon points="-230,0 -290,180 -110,180" fill="#fff6c0" opacity="0.0"/>
      <path d="M-230 40 Q-220 -70 -120 -90 L120 -90 Q220 -70 230 40 L230 110 L-230 110Z" fill="#c4122f"/>
      <path d="M-150 -80 L-110 -170 L110 -170 L150 -80Z" fill="#7a0b1d"/><path d="M-120 -90 L-90 -155 L90 -155 L120 -90Z" fill="#1b2a44"/>
      <rect x="-210" y="20" width="70" height="26" rx="8" fill="#ff3b3b"/><rect x="140" y="20" width="70" height="26" rx="8" fill="#ff3b3b"/>
      <circle cx="-170" cy="115" r="42" fill="#0b0b12"/><circle cx="170" cy="115" r="42" fill="#0b0b12"/></g>
    ${Array.from({ length: 24 }, () => { const y = 600 + rnd() * 400; return `<line x1="${rnd() * 200}" y1="${y}" x2="${rnd() * 200 + 120}" y2="${y}" stroke="#ffffff" stroke-width="3" opacity="0.25"/>`; }).join('')}`,
    lin('sky', [[0, '#05061a'], [1, '#33296b']])),

  'dragon-peak': () => svg(`
    <rect width="${S}" height="${S}" fill="url(#sky)"/>
    <circle cx="260" cy="260" r="110" fill="#ffe1a8"/>
    <polygon points="0,1024 0,700 260,380 460,640 640,300 900,620 1024,520 1024,1024" fill="#4a3f6b"/>
    <polygon points="640,300 590,370 610,380 640,350 670,390 690,370" fill="#f4f1ff"/><polygon points="260,380 225,430 245,440 262,415 285,440 295,425" fill="#f4f1ff"/>
    <polygon points="0,1024 0,860 300,700 560,860 820,720 1024,820 1024,1024" fill="#2b2547"/>
    <g transform="translate(640 330)" fill="#140f24">
      <path d="M-160 0 Q-60 -40 0 0 Q60 40 150 10 Q190 0 220 -30 Q205 10 170 30 Q80 70 0 40 Q-80 30 -160 0Z"/>
      <path d="M-40 0 L-150 -170 L-100 -60 L-200 -120 L-110 -10Z"/><path d="M40 10 L150 -160 L110 -50 L230 -100 L120 20Z"/>
      <path d="M-160 0 Q-220 30 -280 10 Q-240 40 -170 30Z"/><circle cx="200" cy="-18" r="5" fill="#ff7b2e"/></g>
    <path d="M860 335 Q900 320 930 345 Q900 330 865 350Z" fill="#ff7b2e"/>`,
    lin('sky', [[0, '#ff9a5a'], [0.5, '#c25b8a'], [1, '#4a3f6b']])),

  'lonely-astronaut': () => svg(`
    <rect width="${S}" height="${S}" fill="#050714"/>${stars(220, 1024)}
    <circle cx="512" cy="1180" r="560" fill="url(#planet)"/>
    <path d="M60 860 Q512 700 964 860" stroke="#7fd3ff" stroke-width="6" fill="none" opacity="0.5"/>
    <g transform="translate(560 420) rotate(-18)">
      <rect x="-70" y="-10" width="140" height="170" rx="50" fill="#e9edf5"/><rect x="-95" y="0" width="34" height="130" rx="12" fill="#b9c2d3"/>
      <circle cy="-60" r="78" fill="#e9edf5"/><ellipse cx="8" cy="-60" rx="54" ry="44" fill="#ffb347"/><ellipse cx="22" cy="-74" rx="16" ry="10" fill="#fff" opacity="0.7"/>
      <rect x="64" y="20" width="34" height="110" rx="17" fill="#e9edf5" transform="rotate(-35 80 20)"/><rect x="-100" y="20" width="34" height="110" rx="17" fill="#e9edf5" transform="rotate(25 -84 20)"/>
      <rect x="-60" y="150" width="44" height="120" rx="20" fill="#e9edf5"/><rect x="16" y="150" width="44" height="110" rx="20" fill="#e9edf5" transform="rotate(-20 38 150)"/>
      <rect x="-40" y="30" width="80" height="40" rx="8" fill="#5d6a85"/></g>
    <path d="M470 520 Q300 620 360 800 T300 1024" stroke="#e9edf5" stroke-width="5" fill="none" opacity="0.7"/>`,
    `<radialGradient id="planet" cx="0.5" cy="0.25" r="0.7"><stop offset="0" stop-color="#3fa7e0"/><stop offset="0.6" stop-color="#1d5f8f"/><stop offset="1" stop-color="#0b2540"/></radialGradient>`),
};

mkdirSync('public/bank', { recursive: true });
for (const [id, make] of Object.entries(scenes)) {
  seed = id.length * 977 + 13;
  const img = sharp(Buffer.from(make()));
  await img.clone().webp({ quality: 86 }).toFile(`public/bank/${id}.webp`);
  await img.clone().resize(512).jpeg({ quality: 84 }).toFile(`public/bank/${id}-judge.jpg`);
  await img.clone().resize(256).webp({ quality: 78 }).toFile(`public/bank/${id}-thumb.webp`);
  console.log('scene', id);
}
