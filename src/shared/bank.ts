// Built-in content: original movie-genre scenes (Round 1) and mashup reels (Round 2).
// Round 1 scenes: AI-generated originals supplied by the organiser (bank-src/), processed by scripts/import-bank.ts.

export interface BankScene { id: string; title: string; genre: string }

export const ROUND1_SCENES: BankScene[] = [
  { id: 'chennai-central-dusk', title: 'Chennai Central at Dusk', genre: 'City life' },
  { id: 'desk-of-ideas', title: 'The Desk of Big Ideas', genre: 'Office drama' },
  { id: 'film-reel-office', title: 'Film Reel at Sunset', genre: 'Behind the scenes' },
  { id: 'desert-camp', title: 'Desert Camp', genre: 'Adventure' },
  { id: 'floating-island', title: 'The Floating Island', genre: 'Fantasy' },
  { id: 'magic-lamp', title: 'The Magic Lamp', genre: 'Fairy tale' },
  { id: 'moon-wolf', title: 'Moon Wolf', genre: 'Wilderness' },
  { id: 'chennai-commute', title: 'The Chennai Commute', genre: 'Office comedy' },
  { id: 'temple-elephant', title: 'The Temple Elephant', genre: 'Epic' },
  { id: 'blossom-summit', title: 'Blossom Summit', genre: 'Journey' },
  { id: 'shore-horse', title: 'Horse on the Shore', genre: 'Drama' },
];

export const sceneUrl = (id: string, kind: 'full' | 'judge' | 'thumb') =>
  kind === 'full' ? `/bank/${id}.webp` : kind === 'judge' ? `/bank/${id}-judge.jpg` : `/bank/${id}-thumb.webp`;

// Round 2 "Movie Mashup": one pick from each reel → teams design that movie's poster.
export const MASHUP_REELS = {
  genre: [
    'Bollywood musical', 'Zombie horror', 'Space opera', 'Heist thriller', 'Superhero origin story',
    'Wildlife documentary', 'Noir detective mystery', 'Animated fairy tale', 'Kung-fu action', 'Time-travel comedy',
  ],
  hero: [
    'a Chennai auto-rickshaw driver', 'a robot chef', 'a grandmother with a skateboard', 'a street cat',
    'a nervous IT intern', 'a cricket captain', 'a retired astronaut', 'a talking coconut tree',
    'a filter-coffee vendor', 'a giant friendly elephant',
  ],
  setting: [
    'on a Chennai Metro train', 'inside a giant biryani pot', 'at Marina Beach at sunset', 'on Mars',
    'in a floating market in the clouds', 'inside a video game', 'at a monsoon-flooded traffic signal',
    'in an underwater temple', 'on a never-ending escalator', 'in a 1970s cinema hall',
  ],
} as const;

export type ReelKey = keyof typeof MASHUP_REELS;
export const REEL_LABEL: Record<ReelKey, string> = { genre: 'Genre', hero: 'Hero', setting: 'Setting' };
