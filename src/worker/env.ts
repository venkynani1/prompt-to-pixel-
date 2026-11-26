export interface QueueMessageBody {
  jobId: string;
  submissionId: string;
}

export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  EVAL_QUEUE: Queue<QueueMessageBody>;
  IMAGES?: ImagesBinding;           // optional: enables server-side composites for single-image models

  // secrets (wrangler secret put) — never sent to browsers
  DATABASE_URL: string;
  ADMIN_TOKEN: string;              // bootstrap token for creating events
  S3_ENDPOINT?: string;             // Neon Object Storage S3 endpoint
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  OLLAMA_URL?: string;              // optional emergency fallback provider (must be reachable over HTTPS)
  OLLAMA_TOKEN?: string;

  // vars
  PIN_PBKDF2_ITERATIONS?: string;
  STORAGE_MODE?: string;            // 'auto' | 'neon-s3' | 'bytea'
}
