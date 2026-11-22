-- +goose Up
-- NWS alert Takeovers are public warnings, so they take the emergency class
-- and outrank operator and automation Takeovers on the same screens.
-- +goose StatementBegin
UPDATE takeovers SET class = 'emergency'
WHERE id IN (SELECT takeover_id FROM alert_activations WHERE takeover_id IS NOT NULL);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
UPDATE takeovers SET class = 'operator'
WHERE id IN (SELECT takeover_id FROM alert_activations WHERE takeover_id IS NOT NULL);
-- +goose StatementEnd
