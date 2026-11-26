import { bytesToBase64 } from '../db';
import type { Env } from '../env';
import { modelInfo } from './models';

export interface VisionImage { bytes: Uint8Array; contentType: string }
export interface VisionRequest {
  system: string;
  prompt: string;
  images: VisionImage[];
  maxTokens: number;
  jsonSchema?: object;
}
export interface VisionResult {
  raw: unknown;           // parsed object (JSON mode) or text
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export interface JudgeProvider {
  id: 'workers-ai' | 'ollama' | 'fake';
  model: string;
  run(req: VisionRequest): Promise<VisionResult>;
}

/** Thrown when the free allocation is exhausted → job is paused, not failed. */
export class AiQuotaError extends Error {}

const dataUrl = (img: VisionImage) => `data:${img.contentType};base64,${bytesToBase64(img.bytes)}`;

export function workersAiProvider(env: Env, model: string): JudgeProvider {
  const info = modelInfo(model);
  return {
    id: 'workers-ai',
    model,
    async run(req) {
      const started = Date.now();
      const input: Record<string, unknown> = { max_tokens: req.maxTokens, temperature: 0.1 };
      if (req.images.length > 1 && !info.multiImage) throw new Error(`${model} accepts one image per request`);
      if (info.multiImage) {
        input.messages = [
          { role: 'system', content: req.system },
          { role: 'user', content: [
              { type: 'text', text: req.prompt },
              ...req.images.map((img) => ({ type: 'image_url', image_url: { url: dataUrl(img) } })),
            ] },
        ];
      } else {
        input.messages = [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }];
        if (req.images[0]) input.image = dataUrl(req.images[0]);
      }
      if (req.jsonSchema && info.jsonMode) input.response_format = { type: 'json_schema', json_schema: req.jsonSchema };
      let out: any;
      try {
        out = await env.AI.run(model as any, input as any);
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (/3036|daily|allocation|neuron|quota|exceeded your|rate limit|429/i.test(msg)) throw new AiQuotaError(msg);
        throw err;
      }
      const resp = out?.response ?? out?.result?.response ?? out;
      return {
        raw: resp,
        text: typeof resp === 'string' ? resp : JSON.stringify(resp),
        inputTokens: out?.usage?.prompt_tokens ?? null,
        outputTokens: out?.usage?.completion_tokens ?? null,
        latencyMs: Date.now() - started,
      };
    },
  };
}

/** Emergency fallback: an Ollama server the host exposes over HTTPS (e.g. a tunnel). Not used unless explicitly selected. */
export function ollamaProvider(env: Env, model: string): JudgeProvider {
  return {
    id: 'ollama',
    model,
    async run(req) {
      if (!env.OLLAMA_URL) throw new Error('OLLAMA_URL is not configured');
      const started = Date.now();
      const res = await fetch(`${env.OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(env.OLLAMA_TOKEN ? { authorization: `Bearer ${env.OLLAMA_TOKEN}` } : {}) },
        body: JSON.stringify({
          model, stream: false, format: req.jsonSchema ?? 'json', options: { temperature: 0.1, num_predict: req.maxTokens },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.prompt, images: req.images.map((i) => bytesToBase64(i.bytes)) },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j: any = await res.json();
      return {
        raw: j?.message?.content ?? '',
        text: j?.message?.content ?? '',
        inputTokens: j?.prompt_eval_count ?? null,
        outputTokens: j?.eval_count ?? null,
        latencyMs: Date.now() - started,
      };
    },
  };
}

export type ProviderFactory = (provider: string, model: string) => JudgeProvider;

export function defaultProviderFactory(env: Env): ProviderFactory {
  return (provider, model) => (provider === 'ollama' ? ollamaProvider(env, model) : workersAiProvider(env, model));
}
