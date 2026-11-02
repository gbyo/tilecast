-- +goose Up

-- Roles become rows, so an installation can define its own alongside the five
-- built-in ones. The capability vocabulary stays in application code: a role
-- row names a bundle, and role_capabilities lists the members of a custom
-- bundle. The server ignores any capability string it does not know, so a
-- row can never invent authority.
--
-- The built-in roles are inserted here and are protected. Their capabilities
-- are defined in code rather than in role_capabilities, so an upgrade that
-- adds a capability gives it to the built-in roles predictably and no
-- installation can edit Owner or Viewer into something else.
CREATE TABLE roles (
    key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9.-]{1,63}$'),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 60),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 280),
    builtin boolean NOT NULL DEFAULT FALSE,
    sort_order integer NOT NULL DEFAULT 1000,
    -- Attribution only. It deliberately has no foreign key: a cascade from
    -- users must never be able to remove the built-in role rows that every
    -- account references.
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- A custom key always carries the prefix, so a future built-in role can
    -- never collide with a key an installation already uses.
    CHECK (builtin OR key LIKE 'custom.%')
);
CREATE UNIQUE INDEX roles_name_unique ON roles (lower(name));

INSERT INTO roles(key, name, description, builtin, sort_order) VALUES
    ('owner', 'Owner', 'Full control of the installation.', TRUE, 0),
    ('administrator', 'Administrator', 'Manages screens, content, people, and settings.', TRUE, 1),
    ('editor', 'Editor', 'Creates, publishes, and removes content.', TRUE, 2),
    ('contributor', 'Contributor', 'Creates content and submits it for review.', TRUE, 3),
    ('viewer', 'Viewer', 'Views screens, content, and activity.', TRUE, 4);

CREATE TABLE role_capabilities (
    role_key text NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
    capability text NOT NULL CHECK (capability ~ '^[a-z][a-z0-9_.]{1,63}$'),
    PRIMARY KEY (role_key, capability)
);

-- users.role keeps its text values, so every existing account keeps exactly
-- the role it had. The fixed CHECK list becomes a reference to the roles
-- table, which also stops a custom role from being deleted while assigned.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_fkey
    FOREIGN KEY (role) REFERENCES roles(key) ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE INDEX users_role_idx ON users(role);

-- Content access narrows which part of the Media library an account reaches.
-- Unlike screen scopes, there is no "no rows means everything" rule: every
-- account has an explicit policy row, and an account without one reaches
-- nothing. library_mode 'all' is the whole library; 'restricted' is the union
-- of the granted folders and their descendants. tag_mode governs which tags
-- the account may apply, never which assets it can see.
CREATE TABLE user_content_access (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    library_mode text NOT NULL CHECK (library_mode IN ('all', 'restricted')),
    tag_mode text NOT NULL CHECK (tag_mode IN ('all', 'restricted')),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_content_folder_grants (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_id uuid NOT NULL REFERENCES content_folders(id) ON DELETE CASCADE,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, folder_id)
);
CREATE INDEX user_content_folder_grants_folder_idx ON user_content_folder_grants(folder_id);

CREATE TABLE user_content_tag_grants (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag_id uuid NOT NULL REFERENCES content_tags(id) ON DELETE CASCADE,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, tag_id)
);
CREATE INDEX user_content_tag_grants_tag_idx ON user_content_tag_grants(tag_id);

-- Every existing account keeps the whole library and every tag, which is the
-- access it had before this migration.
INSERT INTO user_content_access(user_id, library_mode, tag_mode)
SELECT id, 'all', 'all' FROM users;

-- An upload now carries the folder it will land in, authorized when the
-- session is created and again when the asset is registered. NULL is the
-- library root, which only an account with the whole library may use.
ALTER TABLE upload_sessions
    ADD COLUMN destination_folder_id uuid REFERENCES content_folders(id) ON DELETE SET NULL;

-- +goose Down

ALTER TABLE upload_sessions DROP COLUMN destination_folder_id;
DROP TABLE user_content_tag_grants;
DROP TABLE user_content_folder_grants;
DROP TABLE user_content_access;
DROP INDEX users_role_idx;
ALTER TABLE users DROP CONSTRAINT users_role_fkey;
-- Accounts on a custom role would violate the restored list. Viewer is the
-- least authority, the same choice the Contributor rollback made.
UPDATE users SET role = 'viewer' WHERE role NOT IN ('owner', 'administrator', 'editor', 'contributor', 'viewer');
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('owner', 'administrator', 'editor', 'contributor', 'viewer'));
DROP TABLE role_capabilities;
DROP TABLE roles;
