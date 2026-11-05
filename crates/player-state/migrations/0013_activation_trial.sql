-- The activation trial of the pending manifest (docs/player-core.md,
-- "Activation trials"). A trial shows the pending manifest and promotes it
-- only after the renderer accepted it and reported content evidence. The
-- row records what a restart must not forget: a trial that was running
-- when the process ended counts as a failure, and a failed manifest is held
-- back until retry_at instead of being retried at once or never.
--
-- One row, bound to the installation, screen, normalized server URL and
-- the pending digest. Promotion and pending replacement delete it in the
-- same transaction. Downgrades keep the row; the old reader ignores the
-- table and retries the pending manifest as it did before.
CREATE TABLE activation_trial (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    installation_id TEXT NOT NULL,
    screen_id TEXT NOT NULL,
    server_url TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    state TEXT NOT NULL CHECK (state IN ('idle', 'running', 'failed')),
    failures INTEGER NOT NULL CHECK (failures >= 0),
    started_at_ms INTEGER,
    retry_at_ms INTEGER,
    reason TEXT CHECK (reason IS NULL OR length(reason) <= 64)
);
