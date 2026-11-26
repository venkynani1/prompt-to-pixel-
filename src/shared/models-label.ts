/** Judge models offered in the host console (labels only; details in src/worker/ai/models.ts). */
export const MODELS_LABEL: Record<string, string> = {
  '@cf/meta/llama-4-scout-17b-16e-instruct': 'Llama 4 Scout (recommended — passed live calibration)',
  '@cf/mistralai/mistral-small-3.1-24b-instruct': 'Mistral Small 3.1 (too generous in testing)',
  '@cf/meta/llama-3.2-11b-vision-instruct': 'Llama 3.2 Vision (too generous in testing)',
};
