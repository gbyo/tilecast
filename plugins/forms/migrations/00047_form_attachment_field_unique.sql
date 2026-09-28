-- +goose Up

-- Image fields are single-valued: a record may hold at most one attachment per field key.
-- Enforce that in the database so a replacement can never leave two live attachments on one
-- field, even under concurrent uploads. Any pre-existing duplicates (keeping the most recent per
-- record/field) are removed before the constraint is added.
DELETE FROM form_record_attachments a
USING form_record_attachments b
WHERE a.record_id = b.record_id
  AND a.field_key = b.field_key
  AND (a.created_at, a.id) < (b.created_at, b.id);

ALTER TABLE form_record_attachments
    ADD CONSTRAINT form_record_attachments_record_field_unique UNIQUE (record_id, field_key);

-- +goose Down
ALTER TABLE form_record_attachments
    DROP CONSTRAINT form_record_attachments_record_field_unique;
