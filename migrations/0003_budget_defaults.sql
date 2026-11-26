-- Measured live (25 teams, Llama 4 Scout): ~51 neurons per judged image, so the free 10,000/day
-- covers ~190 images. One upload per team per spin by default keeps a 25-team game well inside it.
ALTER TABLE host_settings ALTER COLUMN max_submissions_per_round SET DEFAULT 1;
ALTER TABLE host_settings ALTER COLUMN ai_neuron_daily_cap SET DEFAULT 9500;
ALTER TABLE host_settings ALTER COLUMN eval_concurrency SET DEFAULT 4;
