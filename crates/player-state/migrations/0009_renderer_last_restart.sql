-- Remote diagnostics: remember the last renderer restart across daemon
-- restarts so the heartbeat reports when and why it happened, not just how
-- many restarts have accumulated. Nullable: databases that predate this
-- migration, and processes that never restarted the renderer, report no
-- last restart. Downgrades keep their rows; the old reader ignores the
-- new columns.
ALTER TABLE renderer_state ADD COLUMN last_restart_at_ms INTEGER;
ALTER TABLE renderer_state ADD COLUMN last_restart_reason TEXT;
