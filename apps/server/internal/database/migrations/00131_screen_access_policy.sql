-- +goose Up

-- Screen access becomes an explicit per-account policy, like content access.
-- Before this migration an account with no user_screen_scopes rows reached
-- the whole fleet, so deleting rows (or never writing them) silently widened
-- access. Now the mode is a row of its own:
--
--   'all'        every screen
--   'restricted' the union of the account's location and group grants;
--                no grants means no screens
--
-- An account without a policy row reaches no screen. The grant rows stay in
-- user_screen_scopes and apply only in restricted mode. The Owner reaches
-- every screen by rule and its row is never consulted.
CREATE TABLE user_screen_access (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mode text NOT NULL CHECK (mode IN ('all', 'restricted')),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every existing account keeps exactly the access it had: no grants was the
-- whole fleet, and one or more grants was those grants.
INSERT INTO user_screen_access(user_id, mode)
SELECT u.id,
       CASE WHEN EXISTS(SELECT 1 FROM user_screen_scopes s WHERE s.user_id = u.id)
            THEN 'restricted' ELSE 'all' END
FROM users u;

-- +goose Down

-- The old model read "no grant rows" as the whole fleet. A restricted
-- account with no grants would widen to everything on rollback, so it is
-- deactivated instead.
UPDATE users u SET active = FALSE
WHERE u.role <> 'owner'
  AND EXISTS(SELECT 1 FROM user_screen_access a WHERE a.user_id = u.id AND a.mode = 'restricted')
  AND NOT EXISTS(SELECT 1 FROM user_screen_scopes s WHERE s.user_id = u.id);
DROP TABLE user_screen_access;
