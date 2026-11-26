import { judgeSubmission, resolveR1Mode } from './ai/judge';
import type { AppContext } from './context';
import { audit, generateReferenceDescription, HttpError } from './game';
import { addUsage } from './usage';
import { aiBudgetAvailable } from './evaluation';

/**
 * Sanity-check the judge before a round opens: an identical copy must score high and a blank
 * grey card must score low. Costs 1–2 AI calls. Never touches team scores.
 */
export async function calibrateRound(ctx: AppContext, eventId: string, roundNo: 1 | 2) {
  const [r] = await ctx.db.query<any>(
    `SELECT r.*, coalesce(r.locked_provider, hs.judge_provider) AS provider, coalesce(r.locked_model, hs.judge_model) AS model, hs.r1_mode
     FROM round_configs r JOIN host_settings hs ON hs.event_id=r.event_id WHERE r.event_id=$1 AND r.round_no=$2`, [eventId, roundNo]);
  if (!r) throw new HttpError(404, 'Round not found');
  const budget = await aiBudgetAvailable(ctx, eventId, r.model, r.provider);
  if (!budget.ok) throw new HttpError(429, 'AI daily budget reached — calibration skipped');

  const mode = roundNo === 1 ? (r.locked_mode ?? resolveR1Mode(r.r1_mode, r.model, ctx.capabilities.imagesBinding)) : 'single';
  if (roundNo === 1 && !r.reference_judge_image_id) throw new HttpError(409, 'Upload the reference image first');
  if (roundNo === 2 && (!Array.isArray(r.concepts) || r.concepts.length !== 3)) throw new HttpError(409, 'Set the three concepts first');
  let description = r.reference_description;
  if (roundNo === 1 && mode === 'reference-description' && !description) description = await generateReferenceDescription(ctx, eventId);

  // blank card stored once per event
  let [blank] = await ctx.db.query<{ id: string }>(`SELECT id FROM images WHERE event_id=$1 AND kind='calibration' LIMIT 1`, [eventId]);
  if (!blank) {
    const bytes = ctx.assets ? await ctx.assets('/judge/calibration-blank.png') : null;
    if (!bytes) throw new HttpError(500, 'Calibration asset missing');
    blank = { id: (await ctx.images.put({ eventId, kind: 'calibration', bytes, contentType: 'image/png' })).id };
  }

  const cases: { name: string; imageId: string; expect: 'high' | 'low' }[] = [];
  if (roundNo === 1) cases.push({ name: 'Identical copy of the reference', imageId: r.reference_judge_image_id, expect: 'high' });
  cases.push({ name: 'Blank grey card', imageId: blank.id, expect: 'low' });

  const provider = ctx.providers(r.provider, r.model);
  const results = [];
  for (const c of cases) {
    try {
      const out = await judgeSubmission({
        provider, images: ctx.images, composite: ctx.composite, judgeImageId: c.imageId,
        round: { round_no: roundNo, locked_mode: mode, reference_judge_image_id: r.reference_judge_image_id, reference_description: description, concepts: r.concepts ?? [] },
      });
      await addUsage(ctx.db, 'ai_neurons', out.neurons);
      await addUsage(ctx.db, 'ai_calls', 1);
      const pass = c.expect === 'high' ? out.total >= 75 : out.total <= 35;
      results.push({ name: c.name, expect: c.expect, total: out.total, criteria: out.criteria, pass, latencyMs: out.latencyMs, neurons: out.neurons });
    } catch (e) {
      results.push({ name: c.name, expect: c.expect, total: null, pass: false, error: String((e as Error).message).slice(0, 300) });
    }
  }
  const calibration = { at: new Date().toISOString(), provider: r.provider, model: r.model, mode, results, pass: results.every((x) => x.pass) };
  await ctx.db.query(`UPDATE round_configs SET calibration=$2::jsonb WHERE id=$1`, [r.id, JSON.stringify(calibration)]);
  await audit(ctx, eventId, 'host', 'calibration', { roundNo, pass: calibration.pass, model: r.model });
  return calibration;
}
