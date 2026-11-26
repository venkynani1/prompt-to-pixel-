import { describe, expect, it } from 'vitest';
import { computeTotal, WEIGHT_SUM } from '../src/shared/rubrics';
import { parseJudgeOutput } from '../src/worker/ai/schema';
import { backoffSeconds } from '../src/worker/evaluation';
import { pollInterval } from '../src/worker/state';
import { hammingHex, hashSecret, verifySecret, detectImageType } from '../src/worker/crypto';
import { resolveR1Mode } from '../src/worker/ai/judge';
import { estimateNeurons } from '../src/worker/ai/models';

describe('scoring', () => {
  it('weights sum to 100 per round', () => { expect(WEIGHT_SUM).toEqual({ 1: 100, 2: 100 }); });
  it('computes totals on the backend', () => {
    expect(computeTotal(1, { composition: 10, subject: 8, colour: 6, style: 4, detail: 2 })).toBe(25 + 20 + 12 + 6 + 3);
    expect(() => computeTotal(1, { composition: 10 })).toThrow(/subject/);
    expect(() => computeTotal(2, { concept_a: 11, concept_b: 1, concept_c: 1, fusion: 1, creativity: 1, quality: 1 })).toThrow();
  });
});

describe('judge output parsing (strict Zod)', () => {
  const ok = { scores: { composition: 7, subject: '8', colour: 6.5, style: 5, detail: 4 }, feedback: 'ok', embedded_instructions: 'false' };
  it('accepts fenced / prose-wrapped JSON and coerces numeric strings', () => {
    const p = parseJudgeOutput(1, 'Here you go:\n```json\n' + JSON.stringify(ok) + '\n``` hope it helps {not json}');
    expect(p.scores).toEqual({ composition: 7, subject: 8, colour: 6.5, style: 5, detail: 4 });
    expect(p.embedded_instructions).toBe(false);
  });
  it('handles braces inside strings', () => {
    const p = parseJudgeOutput(1, JSON.stringify({ ...ok, feedback: 'uses {curly} text' }));
    expect(p.feedback).toBe('uses {curly} text');
  });
  it('rejects out-of-range, missing and non-JSON output', () => {
    expect(() => parseJudgeOutput(1, JSON.stringify({ ...ok, scores: { ...ok.scores, detail: 42 } }))).toThrow(/validation/);
    expect(() => parseJudgeOutput(1, JSON.stringify({ scores: { composition: 5 } }))).toThrow();
    expect(() => parseJudgeOutput(1, 'I give this a 10/10!')).toThrow(/No JSON/);
  });
  it('accepts already-parsed objects (JSON mode)', () => {
    expect(parseJudgeOutput(1, ok).scores.subject).toBe(8);
  });
});

describe('helpers', () => {
  it('backoff grows exponentially with a cap', () => {
    expect(backoffSeconds(1, 0.5)).toBe(5);
    expect(backoffSeconds(3, 0.5)).toBe(20);
    expect(backoffSeconds(20, 0.5)).toBe(300);
  });
  it('adaptive polling: slow while live, faster for screens, backs off under budget pressure', () => {
    expect(pollInterval('r1_open', 'team', false, 0, 85000)).toBe(15000);
    expect(pollInterval('r1_open', 'projector', false, 0, 85000)).toBe(2500);
    expect(pollInterval('lobby', 'team', false, 0, 85000)).toBe(8000);
    expect(pollInterval('r1_open', 'team', false, 80000, 85000)).toBe(60000);
  });
  it('PIN hashing round-trips', async () => {
    const h = await hashSecret('4826', 1000);
    expect(await verifySecret('4826', h)).toBe(true);
    expect(await verifySecret('4827', h)).toBe(false);
  });
  it('dHash hamming distance and magic-byte sniffing', () => {
    expect(hammingHex('0000000000000000', '000000000000000f')).toBe(4);
    expect(hammingHex('zz', '00')).toBe(64);
    expect(detectImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectImageType(new TextEncoder().encode('<svg>'))).toBeNull();
  });
  it('round-1 mode selection', () => {
    expect(resolveR1Mode('auto', '@cf/meta/llama-3.2-11b-vision-instruct', false)).toBe('reference-description');
    expect(resolveR1Mode('auto', '@cf/meta/llama-3.2-11b-vision-instruct', true)).toBe('composite');
    expect(resolveR1Mode('auto', '@cf/meta/llama-4-scout-17b-16e-instruct', false)).toBe('multi-image');
  });
  it('neuron estimate matches published rates', () => {
    // 2,000 input + 150 output tokens on Llama 3.2 11B Vision
    expect(estimateNeurons('@cf/meta/llama-3.2-11b-vision-instruct', 2000, 150)).toBeCloseTo(8.82 + 9.22, 1);
  });
});
