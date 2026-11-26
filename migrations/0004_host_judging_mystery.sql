-- v2.2: the host can judge a spin by hand (instead of, or on top of, the AI) and run Mystery rounds
-- that pause the show while the host hands out points by team number.

-- 'host_judging' = waiting for the host to give a score (no AI job)
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_status_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_status_check CHECK (status IN (
  'queued','evaluating','scored','needs_review','failed','paused_quota','superseded','rejected','host_judging'));

-- who judges a spin: the AI or the host. Chosen before the spin, switchable after it.
ALTER TABLE round_configs ADD COLUMN IF NOT EXISTS judge_mode text NOT NULL DEFAULT 'ai';
ALTER TABLE round_configs DROP CONSTRAINT IF EXISTS round_configs_judge_mode_check;
ALTER TABLE round_configs ADD CONSTRAINT round_configs_judge_mode_check CHECK (judge_mode IN ('ai','host'));
ALTER TABLE host_settings ADD COLUMN IF NOT EXISTS host_judges_next boolean NOT NULL DEFAULT false;

-- Mystery round: while mystery_at is set, spins are paused and the big screen shows the Mystery screen
ALTER TABLE events ADD COLUMN IF NOT EXISTS mystery_at timestamptz;
ALTER TABLE events ADD COLUMN IF NOT EXISTS mystery_title text;

CREATE TABLE IF NOT EXISTS bonus_points (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  points     int  NOT NULL CHECK (points BETWEEN -1000 AND 1000 AND points <> 0),
  note       text CHECK (char_length(note) <= 80),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bonus_points_event_idx ON bonus_points(event_id, created_at);
CREATE INDEX IF NOT EXISTS bonus_points_team_idx ON bonus_points(team_id);
