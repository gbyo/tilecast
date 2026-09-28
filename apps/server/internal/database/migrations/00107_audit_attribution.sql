-- +goose Up
ALTER TABLE audit_logs
    ADD COLUMN calling_surface TEXT NOT NULL DEFAULT 'legacy' CHECK (calling_surface IN ('studio','cli','mcp','api','system','legacy')),
    ADD COLUMN client_id TEXT,
    ADD COLUMN client_instance TEXT;
CREATE INDEX audit_logs_surface_idx ON audit_logs(calling_surface, created_at DESC, id DESC);

-- +goose Down
DROP INDEX audit_logs_surface_idx;
ALTER TABLE audit_logs DROP COLUMN client_instance, DROP COLUMN client_id, DROP COLUMN calling_surface;
