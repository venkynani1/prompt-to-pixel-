/**
 * Candidate vision models on Workers AI. Neuron rates copied from
 * https://developers.cloudflare.com/workers-ai/platform/pricing/ (checked 2026-11-26).
 * `multiImage` / `jsonMode` are EXPECTED capabilities; scripts/benchmark.ts verifies them
 * against the live API before a model is chosen — trust the benchmark report over this table.
 */
export interface ModelInfo {
  id: string;
  label: string;
  multiImage: boolean;
  jsonMode: boolean;
  neuronsPerMIn: number;
  neuronsPerMOut: number;
  imageTokenEstimate: number; // conservative fallback when the API returns no usage
}

export const MODELS: ModelInfo[] = [
  { id: '@cf/meta/llama-3.2-11b-vision-instruct', label: 'Llama 3.2 11B Vision', multiImage: false, jsonMode: false, neuronsPerMIn: 4410, neuronsPerMOut: 61493, imageTokenEstimate: 1700 },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B', multiImage: true, jsonMode: true, neuronsPerMIn: 24545, neuronsPerMOut: 77273, imageTokenEstimate: 1200 },
  { id: '@cf/google/gemma-3-12b-it', label: 'Gemma 3 12B', multiImage: true, jsonMode: false, neuronsPerMIn: 31371, neuronsPerMOut: 50560, imageTokenEstimate: 300 },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1 24B', multiImage: true, jsonMode: false, neuronsPerMIn: 31876, neuronsPerMOut: 50488, imageTokenEstimate: 1100 },
];

export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? {
    id, label: id, multiImage: false, jsonMode: false, neuronsPerMIn: 50000, neuronsPerMOut: 100000, imageTokenEstimate: 2000,
  };
}

export function estimateNeurons(model: string, inTokens: number, outTokens: number): number {
  const m = modelInfo(model);
  return Math.round(((inTokens * m.neuronsPerMIn + outTokens * m.neuronsPerMOut) / 1e6) * 100) / 100;
}
