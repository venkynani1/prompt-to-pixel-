// Scoring rubrics. The AI judge returns 0–10 per criterion; the BACKEND converts to points.
// Weights per round sum to 100, so each round is worth 100 points and the event 200.
// DRAFT rules written from scratch — review with the event organisers before the event.

export type CriterionKey =
  | 'composition' | 'subject' | 'colour' | 'style' | 'detail'
  | 'concept_a' | 'concept_b' | 'concept_c' | 'fusion' | 'creativity' | 'quality';

export interface Criterion {
  key: CriterionKey;
  label: string;
  weight: number;       // points available
  guide: string;        // what the judge looks for (also shown to players)
}

export const ROUND1_CRITERIA: Criterion[] = [
  { key: 'composition', label: 'Composition & layout', weight: 25, guide: 'Same framing, camera angle, placement and scale of the main elements.' },
  { key: 'subject',     label: 'Subject accuracy',     weight: 25, guide: 'Same subjects/objects, count, pose and action.' },
  { key: 'colour',      label: 'Colour & lighting',    weight: 20, guide: 'Palette, light direction, time of day, contrast and mood.' },
  { key: 'style',       label: 'Style & medium',       weight: 15, guide: 'Same artistic style: photo vs illustration, texture, rendering.' },
  { key: 'detail',      label: 'Detail fidelity',      weight: 15, guide: 'Background elements, small props and fine details.' },
];

export const ROUND2_CRITERIA: Criterion[] = [
  { key: 'concept_a',  label: 'Concept A present', weight: 15, guide: 'Concept A is clearly recognisable.' },
  { key: 'concept_b',  label: 'Concept B present', weight: 15, guide: 'Concept B is clearly recognisable.' },
  { key: 'concept_c',  label: 'Concept C present', weight: 15, guide: 'Concept C is clearly recognisable.' },
  { key: 'fusion',     label: 'Crossover fusion',  weight: 20, guide: 'The three concepts are blended into ONE coherent scene, not pasted side by side.' },
  { key: 'creativity', label: 'Creativity',        weight: 15, guide: 'Surprising, witty or original interpretation.' },
  { key: 'quality',    label: 'Visual quality',    weight: 20, guide: 'Clean rendering, few artefacts, good composition.' },
];

export function criteriaFor(roundNo: 1 | 2): Criterion[] {
  return roundNo === 1 ? ROUND1_CRITERIA : ROUND2_CRITERIA;
}

/** Consistent scoring anchors given to the judge for every criterion. */
export const SCORE_ANCHORS = [
  '0 = completely absent or unrelated',
  '2 = barely present / mostly wrong',
  '4 = partially matches, major differences',
  '6 = clearly matches with noticeable differences',
  '8 = strong match, only minor differences',
  '10 = essentially perfect',
];

/** Backend-only total. Never trust a total from the model. Rounds to 2 dp. */
export function computeTotal(roundNo: 1 | 2, scores: Record<string, number>): number {
  let total = 0;
  for (const c of criteriaFor(roundNo)) {
    const s = scores[c.key];
    if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 10) {
      throw new Error(`Missing or invalid score for criterion "${c.key}"`);
    }
    total += (s / 10) * c.weight;
  }
  return Math.round(total * 100) / 100;
}

export const WEIGHT_SUM = {
  1: ROUND1_CRITERIA.reduce((a, c) => a + c.weight, 0),
  2: ROUND2_CRITERIA.reduce((a, c) => a + c.weight, 0),
} as const;
