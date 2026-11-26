-- Prompt to Pixel — Neon PostgreSQL schema (v2, cloud architecture)
-- Idempotent where practical. Applied by scripts/migrate.ts, tracked in schema_migrations.

-- gen_random_uuid() is built into PostgreSQL 13+, no extension needed.

-- ───────────────────────── Events ─────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{4,8}$'),
  name            text NOT NULL,
  phase           text NOT NULL DEFAULT 'lobby' CHECK (phase IN (
                    'lobby','r1_brief','r1_open','r1_judging','r1_results',
                    'r2_brief','r2_open','r2_judging','r2_results','final','closed')),
  phase_changed_at timestamptz NOT NULL DEFAULT now(),
  registration_open boolean NOT NULL DEFAULT true,
  host_pass_hash  text NOT NULL,              -- pbkdf2$iter$salt$hash
  projector_key   text NOT NULL,              -- random, read-only screen access
  state_version   bigint NOT NULL DEFAULT 1,  -- bumped on every visible change (drives polling ETags)
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Host settings (per event) ─────────────────────────
CREATE TABLE IF NOT EXISTS host_settings (
  event_id              uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  judge_provider        text NOT NULL DEFAULT 'workers-ai' CHECK (judge_provider IN ('workers-ai','ollama')),
  judge_model           text NOT NULL DEFAULT '@cf/meta/llama-3.2-11b-vision-instruct',
  r1_mode               text NOT NULL DEFAULT 'auto' CHECK (r1_mode IN ('auto','multi-image','composite','reference-description')),
  eval_concurrency      int  NOT NULL DEFAULT 4 CHECK (eval_concurrency BETWEEN 1 AND 10),
  max_attempts          int  NOT NULL DEFAULT 4 CHECK (max_attempts BETWEEN 1 AND 10),
  ai_neuron_daily_cap   int  NOT NULL DEFAULT 8500,     -- hard cap below 10,000 free neurons/day
  request_daily_cap     int  NOT NULL DEFAULT 85000,    -- hard cap below 100,000 free requests/day
  storage_byte_cap      bigint NOT NULL DEFAULT 4000000000, -- 4 GB of the 5 GB object storage
  bytea_byte_cap        bigint NOT NULL DEFAULT 600000000,  -- 600 MB of the 1 GB Postgres storage
  max_upload_bytes      int  NOT NULL DEFAULT 900000,
  max_submissions_per_round int NOT NULL DEFAULT 2 CHECK (max_submissions_per_round BETWEEN 1 AND 5),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Teams & credentials ─────────────────────────
CREATE TABLE IF NOT EXISTS teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 32),
  name_key    text NOT NULL,                  -- lower-cased, trimmed; uniqueness key
  anon_label  text NOT NULL,                  -- e.g. "Entry 17" — what the AI judge would see (it sees nothing, but logs use it)
  disabled    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, name_key)
);
CREATE INDEX IF NOT EXISTS teams_event_idx ON teams(event_id);

CREATE TABLE IF NOT EXISTS team_credentials (
  team_id         uuid PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  pin_hash        text NOT NULL,
  failed_attempts int  NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Sessions ─────────────────────────
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash  text PRIMARY KEY,               -- sha256(token), the raw token only lives in the HttpOnly cookie
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('team','host')),
  team_id     uuid REFERENCES teams(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked     boolean NOT NULL DEFAULT false,
  CHECK ((role = 'team') = (team_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS auth_sessions_team_idx ON auth_sessions(team_id);

-- ───────────────────────── Stored images (object storage index + BYTEA fallback) ─────────────────────────
CREATE TABLE IF NOT EXISTS images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('reference','submission','judge','thumb','composite','calibration')),
  backend     text NOT NULL CHECK (backend IN ('neon-s3','bytea')),
  object_key  text,                           -- neon-s3 key
  data        bytea,                          -- bytea fallback payload (compressed WebP/JPEG only)
  content_type text NOT NULL CHECK (content_type IN ('image/webp','image/jpeg','image/png')),
  byte_size   int  NOT NULL CHECK (byte_size > 0),
  sha256      text NOT NULL,
  width       int,
  height      int,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((backend = 'neon-s3' AND object_key IS NOT NULL AND data IS NULL)
      OR (backend = 'bytea'   AND data IS NOT NULL AND object_key IS NULL))
);
CREATE INDEX IF NOT EXISTS images_event_idx ON images(event_id, kind);

-- ───────────────────────── Round configuration ─────────────────────────
CREATE TABLE IF NOT EXISTS round_configs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  round_no         int  NOT NULL CHECK (round_no IN (1,2)),
  title            text NOT NULL,
  brief            text NOT NULL DEFAULT '',
  duration_sec     int  NOT NULL DEFAULT 600 CHECK (duration_sec BETWEEN 60 AND 7200),
  judging_window_sec int NOT NULL DEFAULT 300,
  reference_image_id uuid REFERENCES images(id),      -- round 1
  reference_judge_image_id uuid REFERENCES images(id),
  reference_dhash  text,                               -- 64-bit hex, computed by host browser
  reference_description text,                          -- generated once (reference-description mode)
  concepts         jsonb NOT NULL DEFAULT '[]'::jsonb, -- round 2: exactly 3 strings
  opens_at         timestamptz,
  deadline_at      timestamptz,                        -- server-authoritative
  -- judge lock: copied from host_settings when the round opens; never changes mid-round
  locked_provider  text,
  locked_model     text,
  locked_mode      text,
  locked_at        timestamptz,
  calibration      jsonb,
  UNIQUE (event_id, round_no),
  CHECK (round_no <> 2 OR jsonb_typeof(concepts) = 'array')
);

-- ───────────────────────── Submissions ─────────────────────────
CREATE TABLE IF NOT EXISTS submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  round_id      uuid NOT NULL REFERENCES round_configs(id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  image_id      uuid NOT NULL REFERENCES images(id),
  judge_image_id uuid NOT NULL REFERENCES images(id),
  thumb_image_id uuid NOT NULL REFERENCES images(id),
  prompt_text   text CHECK (char_length(prompt_text) <= 2000), -- shown in gallery, NEVER sent to the judge
  dhash         text,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN (
                  'queued','evaluating','scored','needs_review','failed','paused_quota','superseded','rejected')),
  flags         text[] NOT NULL DEFAULT '{}',
  score_total   numeric(6,2),
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  scored_at     timestamptz
);
-- exactly one live submission per team per round (resubmission supersedes before the deadline)
CREATE UNIQUE INDEX IF NOT EXISTS submissions_live_uidx
  ON submissions(round_id, team_id) WHERE status NOT IN ('superseded');
CREATE INDEX IF NOT EXISTS submissions_round_status_idx ON submissions(round_id, status);

-- ───────────────────────── Evaluation jobs ─────────────────────────
CREATE TABLE IF NOT EXISTS evaluation_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'score' CHECK (kind IN ('score','calibration')),
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN (
                   'queued','running','retry','done','failed','paused_quota','cancelled')),
  attempts       int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until    timestamptz,
  last_enqueued_at timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
-- one active score job per submission → duplicate queue deliveries cannot create parallel work
CREATE UNIQUE INDEX IF NOT EXISTS evaluation_jobs_active_uidx
  ON evaluation_jobs(submission_id) WHERE kind = 'score' AND status IN ('queued','running','retry','paused_quota');
CREATE INDEX IF NOT EXISTS evaluation_jobs_due_idx ON evaluation_jobs(status, next_attempt_at);

-- ───────────────────────── Evaluation results ─────────────────────────
CREATE TABLE IF NOT EXISTS evaluation_results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  job_id         uuid NOT NULL REFERENCES evaluation_jobs(id) ON DELETE CASCADE,
  provider       text NOT NULL,
  model          text NOT NULL,
  mode           text NOT NULL,
  criteria       jsonb NOT NULL,          -- {criterionKey: 0..10}
  total          numeric(6,2) NOT NULL,   -- computed on the backend from criteria × weights
  feedback       text,
  raw_response   text,
  input_tokens   int,
  output_tokens  int,
  neurons_est    numeric(10,2),
  latency_ms     int,
  is_published   boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);
-- at most ONE published result per submission → duplicate evaluations can never publish twice
CREATE UNIQUE INDEX IF NOT EXISTS evaluation_results_published_uidx
  ON evaluation_results(submission_id) WHERE is_published;

-- ───────────────────────── Leaderboard (materialised, refreshed after each score) ─────────────────────────
CREATE TABLE IF NOT EXISTS leaderboard_entries (
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  r1_score    numeric(6,2),
  r2_score    numeric(6,2),
  total       numeric(7,2) NOT NULL DEFAULT 0,
  rank        int,
  r2_submitted_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, team_id)
);

-- ───────────────────────── Usage (zero-cost enforcement) ─────────────────────────
CREATE TABLE IF NOT EXISTS usage_daily (
  day     date NOT NULL,      -- UTC day, matches Cloudflare reset at 00:00 UTC
  metric  text NOT NULL,      -- ai_neurons, ai_calls, ai_failures, worker_requests, uploads, upload_bytes
  value   numeric(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

-- ───────────────────────── Audit log ─────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id         bigserial PRIMARY KEY,
  event_id   uuid REFERENCES events(id) ON DELETE CASCADE,
  actor      text NOT NULL,            -- 'host', 'team:<uuid>', 'system'
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_event_idx ON audit_logs(event_id, created_at DESC);
