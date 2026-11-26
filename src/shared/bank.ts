// Built-in content: original movie-genre scenes (Round 1) and mashup reels (Round 2).
// Every scene is drawn from scratch by scripts/make-bank.ts — no real films, characters or posters.

export interface BankScene { id: string; title: string; genre: string }

export const ROUND1_SCENES: BankScene[] = [
  { id: 'desert-showdown', title: 'Desert Showdown', genre: 'Western' },
  { id: 'neon-rain', title: 'Neon Rain', genre: 'Cyberpunk noir' },
  { id: 'twin-moons', title: 'Twin Moons', genre: 'Sci-fi' },
  { id: 'haunted-hill', title: 'Haunted Hill', genre: 'Horror' },
  { id: 'storm-ship', title: 'Storm Ship', genre: 'Pirate adventure' },
  { id: 'lost-temple', title: 'Lost Temple', genre: 'Jungle adventure' },
  { id: 'monsoon-love', title: 'Monsoon Love', genre: 'Romance' },
  { id: 'rooftop-hero', title: 'Rooftop Hero', genre: 'Superhero' },
  { id: 'deep-kingdom', title: 'Deep Kingdom', genre: 'Underwater fantasy' },
  { id: 'midnight-chase', title: 'Midnight Chase', genre: 'Car chase' },
  { id: 'dragon-peak', title: 'Dragon Peak', genre: 'Fantasy' },
  { id: 'lonely-astronaut', title: 'Lonely Astronaut', genre: 'Space drama' },
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
