-- +goose Up

-- Takeovers can overlap. The Server chooses the highest-priority active
-- takeover independently for each screen while the other contenders stay
-- resumable. The Player contract still carries only the selected takeover.
ALTER TABLE takeovers
    ADD COLUMN priority_class text NOT NULL DEFAULT 'routine'
        CHECK (priority_class IN ('routine','priority','urgent','emergency'));

-- Existing automatic NWS takeovers must keep their emergency precedence after
-- the column is introduced. Manual and package-created takeovers keep the
-- routine default.
UPDATE takeovers t
SET priority_class='emergency'
WHERE EXISTS (
    SELECT 1
    FROM alert_activations a
    WHERE a.takeover_id=t.id
);

-- "suspended" is server-owned state: the takeover still applies to this screen
-- but a higher-priority (or newer same-class) takeover currently wins there.
ALTER TABLE takeover_screen_states
    DROP CONSTRAINT emergency_screen_states_state_check;
ALTER TABLE takeover_screen_states
    ADD CONSTRAINT takeover_screen_states_state_check
    CHECK (state IN (
        'pending','notified','preparing','ready','active','failed','offline',
        'suspended','restored','expired','cancelled'
    ));

-- +goose Down

UPDATE takeover_screen_states
SET state='pending',last_updated_at=now()
WHERE state='suspended';

ALTER TABLE takeover_screen_states
    DROP CONSTRAINT takeover_screen_states_state_check;
ALTER TABLE takeover_screen_states
    ADD CONSTRAINT emergency_screen_states_state_check
    CHECK (state IN (
        'pending','notified','preparing','ready','active','failed','offline',
        'restored','expired','cancelled'
    ));

ALTER TABLE takeovers DROP COLUMN priority_class;
