-- v2.1: wheel spins (each spin = one "turn" of a round), numbered teams with host-issued PINs,
-- one active event with password-only host login, Llama 4 Scout as default judge.

-- round_configs now holds one row per spin ("turn")
ALTER TABLE round_configs DROP CONSTRAINT IF EXISTS round_configs_event_id_round_no_key;
ALTER TABLE round_configs ADD COLUMN IF NOT EXISTS seq int NOT NULL DEFAULT 1;
ALTER TABLE round_configs ADD COLUMN IF NOT EXISTS bank_item text;
ALTER TABLE round_configs ADD COLUMN IF NOT EXISTS spin_at timestamptz;        -- wheel starts
ALTER TABLE round_configs ADD COLUMN IF NOT EXISTS preview_from timestamptz;   -- wheel stops, image/concepts shown
ALTER TABLE round_configs ADD COLUMN IF NOT EXISTS preview_until timestamptz;  -- image hidden (round 1), uploads open
ALTER TABLE round_configs ADD COLUMN IF NOT EXISTS revealed_at timestamptz;    -- scores shown to everyone
CREATE INDEX IF NOT EXISTS round_configs_spin_idx ON round_configs(event_id, spin_at DESC);

-- one active event; host logs in with the password only
ALTER TABLE events ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT false;
-- Events created before this version stay inactive: the host creates the live one from /host.
CREATE UNIQUE INDEX IF NOT EXISTS events_one_active_uidx ON events(active) WHERE active;

-- numbered teams (BID WARS style): host creates Team 1..N with 4-digit PINs, teams name themselves on first join
ALTER TABLE teams ADD COLUMN IF NOT EXISTS team_no int;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS named boolean NOT NULL DEFAULT true;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS joined_at timestamptz;
UPDATE teams SET joined_at = created_at WHERE joined_at IS NULL AND team_no IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS teams_no_uidx ON teams(event_id, team_no) WHERE team_no IS NOT NULL;
ALTER TABLE team_credentials ADD COLUMN IF NOT EXISTS pin_plain text;  -- host-issued 4-digit PIN, shown only to the host for the PIN sheet

-- timings + judge default
ALTER TABLE host_settings ADD COLUMN IF NOT EXISTS r1_preview_sec int NOT NULL DEFAULT 8;
ALTER TABLE host_settings ADD COLUMN IF NOT EXISTS r1_duration_sec int NOT NULL DEFAULT 270;
ALTER TABLE host_settings ADD COLUMN IF NOT EXISTS r2_duration_sec int NOT NULL DEFAULT 360;
ALTER TABLE host_settings ALTER COLUMN judge_model SET DEFAULT '@cf/meta/llama-4-scout-17b-16e-instruct';
UPDATE host_settings SET judge_model = '@cf/meta/llama-4-scout-17b-16e-instruct' WHERE judge_model = '@cf/meta/llama-3.2-11b-vision-instruct';
ALTER TABLE host_settings ALTER COLUMN max_submissions_per_round SET DEFAULT 2;
