-- +goose Up
-- Guarantee at the database level that a form record's workflow state always references a state
-- that exists for the same Form Data Source. The composite target already has a UNIQUE index
-- (data_source_id, state_key) from 00044. ON DELETE NO ACTION defers the check to end of
-- statement, so a full data_sources cascade that removes both a form's records and its states in
-- one statement still succeeds, while an attempt to delete a state that a record still references
-- fails. Application-level reconciliation in internal/forms enforces the same rule with clearer
-- errors; this constraint is the backstop.
ALTER TABLE form_records
    ADD CONSTRAINT form_records_state_fk
    FOREIGN KEY (data_source_id, state_key)
    REFERENCES form_workflow_states (data_source_id, state_key)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- +goose Down
ALTER TABLE form_records DROP CONSTRAINT form_records_state_fk;
