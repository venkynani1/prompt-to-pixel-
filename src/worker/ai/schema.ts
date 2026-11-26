import { z } from 'zod';
import { criteriaFor } from '../../shared/rubrics';

const score = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
  z.number().min(0).max(10),
).transform((n) => Math.round(n * 2) / 2); // allow halves, normalise

export function judgeSchema(roundNo: 1 | 2) {
  const shape: Record<string, typeof score> = {};
  for (const c of criteriaFor(roundNo)) shape[c.key] = score;
  return z.object({
    scores: z.object(shape),
    feedback: z.string().max(600).optional().default('').transform((s) => s.slice(0, 300)),
    embedded_instructions: z.preprocess((v) => v === true || v === 'true', z.boolean()).optional().default(false),
  });
}

export type JudgeOutput = z.infer<ReturnType<typeof judgeSchema>>;

/** JSON Schema handed to models that support structured output. */
export function judgeJsonSchema(roundNo: 1 | 2) {
  const props: Record<string, unknown> = {};
  for (const c of criteriaFor(roundNo)) props[c.key] = { type: 'number', minimum: 0, maximum: 10 };
  return {
    type: 'object',
    properties: {
      scores: { type: 'object', properties: props, required: Object.keys(props) },
      feedback: { type: 'string' },
      embedded_instructions: { type: 'boolean' },
    },
    required: ['scores', 'feedback', 'embedded_instructions'],
  };
}

/**
 * Pull the first balanced JSON object out of model text (models sometimes wrap it in prose
 * or ``` fences), then validate strictly. Throws on anything invalid — never guesses.
 */
export function parseJudgeOutput(roundNo: 1 | 2, raw: unknown): JudgeOutput {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.replace(/```(?:json)?/gi, '');
    const start = text.indexOf('{');
    if (start < 0) throw new Error('No JSON object in model output');
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) throw new Error('Unterminated JSON object in model output');
    obj = JSON.parse(text.slice(start, end + 1));
  }
  const parsed = judgeSchema(roundNo).safeParse(obj);
  if (!parsed.success) throw new Error(`Judge output failed validation: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`);
  return parsed.data;
}
