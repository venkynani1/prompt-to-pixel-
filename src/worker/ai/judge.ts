import { computeTotal } from '../../shared/rubrics';
import type { ImageStore, StoredImage } from '../storage';
import { estimateNeurons, modelInfo } from './models';
import {
  SYSTEM_PROMPT, describeReferencePrompt, round1CompositePrompt, round1DescriptionPrompt,
  round1MultiImagePrompt, round2Prompt,
} from './prompts';
import type { JudgeProvider, VisionImage } from './providers';
import { judgeJsonSchema, parseJudgeOutput } from './schema';

export type R1Mode = 'multi-image' | 'composite' | 'reference-description';

export function resolveR1Mode(setting: string, model: string, hasImagesBinding: boolean): R1Mode {
  if (setting === 'multi-image' || setting === 'composite' || setting === 'reference-description') return setting;
  if (modelInfo(model).multiImage) return 'multi-image';
  if (hasImagesBinding) return 'composite';
  return 'reference-description';
}

export interface RoundForJudge {
  round_no: 1 | 2;
  locked_mode: string | null;
  reference_judge_image_id: string | null;
  reference_description: string | null;
  concepts: string[];
}

export interface JudgeResult {
  criteria: Record<string, number>;
  total: number;
  feedback: string;
  embeddedInstructions: boolean;
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  neurons: number;
  latencyMs: number;
  mode: string;
}

export type CompositeFn = (reference: StoredImage, attempt: StoredImage) => Promise<VisionImage>;

/** Server-side side-by-side panel via the Cloudflare Images binding (no Worker CPU spent on pixels). */
export function imagesBindingComposite(images: any, base: () => Promise<ReadableStream>): CompositeFn {
  return async (reference, attempt) => {
    const stream = (b: Uint8Array) => new Response(b).body!;
    const out = await images.input(await base())
      .draw(images.input(stream(reference.bytes)).transform({ width: 480, height: 480, fit: 'contain', background: '#ffffff' }), { left: 20, top: 60 })
      .draw(images.input(stream(attempt.bytes)).transform({ width: 480, height: 480, fit: 'contain', background: '#ffffff' }), { right: 20, top: 60 })
      .output({ format: 'image/jpeg', quality: 85 });
    const bytes = new Uint8Array(await out.response().arrayBuffer());
    return { bytes, contentType: 'image/jpeg' };
  };
}

export async function judgeSubmission(opts: {
  provider: JudgeProvider;
  images: ImageStore;
  round: RoundForJudge;
  judgeImageId: string;
  composite?: CompositeFn;
}): Promise<JudgeResult> {
  const { provider, images, round } = opts;
  const attempt = await images.get(opts.judgeImageId);
  if (!attempt) throw new Error('Submission image missing from storage');

  let prompt: string;
  let visionImages: VisionImage[];
  let mode = round.round_no === 2 ? 'single' : (round.locked_mode ?? 'reference-description');

  if (round.round_no === 2) {
    if (round.concepts.length !== 3) throw new Error('Round 2 needs exactly three concepts');
    prompt = round2Prompt(round.concepts);
    visionImages = [attempt];
  } else if (mode === 'multi-image' || mode === 'composite') {
    const ref = round.reference_judge_image_id ? await images.get(round.reference_judge_image_id) : null;
    if (!ref) throw new Error('Reference image missing');
    if (mode === 'multi-image') {
      prompt = round1MultiImagePrompt();
      visionImages = [ref, attempt];
    } else {
      if (!opts.composite) throw new Error('Composite mode needs the IMAGES binding');
      prompt = round1CompositePrompt();
      visionImages = [await opts.composite(ref, attempt)];
    }
  } else {
    if (!round.reference_description) throw new Error('Reference description has not been generated');
    mode = 'reference-description';
    prompt = round1DescriptionPrompt(round.reference_description);
    visionImages = [attempt];
  }

  const res = await provider.run({
    system: SYSTEM_PROMPT,
    prompt,
    images: visionImages,
    maxTokens: 350,
    jsonSchema: judgeJsonSchema(round.round_no),
  });
  const parsed = parseJudgeOutput(round.round_no, res.raw);
  const info = modelInfo(provider.model);
  const inTok = res.inputTokens ?? Math.ceil((SYSTEM_PROMPT.length + prompt.length) / 4) + visionImages.length * info.imageTokenEstimate;
  const outTok = res.outputTokens ?? Math.ceil(res.text.length / 3);
  return {
    criteria: parsed.scores as Record<string, number>,
    total: computeTotal(round.round_no, parsed.scores as Record<string, number>),
    feedback: parsed.feedback,
    embeddedInstructions: parsed.embedded_instructions,
    rawText: res.text.slice(0, 4000),
    inputTokens: inTok,
    outputTokens: outTok,
    neurons: provider.id === 'workers-ai' ? estimateNeurons(provider.model, inTok, outTok) : 0,
    latencyMs: res.latencyMs,
    mode,
  };
}

export async function describeReference(provider: JudgeProvider, ref: StoredImage) {
  const res = await provider.run({ system: SYSTEM_PROMPT.replace('Reply with ONE JSON object and nothing else.', ''), prompt: describeReferencePrompt(), images: [ref], maxTokens: 320 });
  const info = modelInfo(provider.model);
  const inTok = res.inputTokens ?? 300 + info.imageTokenEstimate;
  const outTok = res.outputTokens ?? Math.ceil(res.text.length / 3);
  return { text: res.text.trim().slice(0, 2500), neurons: provider.id === 'workers-ai' ? estimateNeurons(provider.model, inTok, outTok) : 0 };
}
