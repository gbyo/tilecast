-- +goose Up
-- Form Data Sources. A Form is a Data Source provider (provider='form', adapter
-- 'form_records'): the existing data_sources row is the parent resource and all form state
-- lives in the dedicated tables below. Submission values are stored as validated JSONB with a
-- reference to the immutable published form revision used when the record was created. The
-- provider identifier constraint is already shape-based (00039), so data_sources needs no change.

-- Immutable published field schemas. Rows are never UPDATEd after insert; editing a live form
-- publishes a new revision, so older submissions keep validating against the schema they used.
CREATE TABLE form_revisions (
    id UUID PRIMARY KEY,
    data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    schema JSONB NOT NULL CHECK (jsonb_typeof(schema) = 'object'),
    published_by UUID REFERENCES users(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (data_source_id, revision_number)
);

-- Bounded, mutable workflow states. Labels and output-eligibility are editable without
-- republishing a revision; records reference the stable state_key.
CREATE TABLE form_workflow_states (
    id UUID PRIMARY KEY,
    data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    state_key TEXT NOT NULL CHECK (state_key ~ '^[a-z][a-z0-9_]{0,39}$'),
    label TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    eligible_for_output BOOLEAN NOT NULL DEFAULT FALSE,
    is_initial BOOLEAN NOT NULL DEFAULT FALSE,
    is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (data_source_id, state_key)
);

CREATE TABLE form_workflow_transitions (
    id UUID PRIMARY KEY,
    data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    required_capability TEXT NOT NULL DEFAULT 'review'
        CHECK (required_capability IN ('submit', 'review', 'approve', 'manage')),
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (data_source_id, from_state, to_state)
);

-- Submission records. values are validated against the referenced (immutable) revision at
-- write time. eligible is denormalized from the workflow state so the projection query stays a
-- simple index scan. version provides optimistic concurrency for concurrent edits/transitions.
CREATE TABLE form_records (
    id UUID PRIMARY KEY,
    data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    revision_id UUID NOT NULL REFERENCES form_revisions(id) ON DELETE RESTRICT,
    state_key TEXT NOT NULL DEFAULT 'draft',
    values JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(values) = 'object'),
    submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    submitter_name TEXT NOT NULL DEFAULT '',
    display_title TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0,
    display_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    eligible BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX form_records_projection_idx
    ON form_records (data_source_id, state_key, priority DESC, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX form_records_window_idx
    ON form_records (data_source_id, expires_at)
    WHERE deleted_at IS NULL AND eligible;
CREATE INDEX form_records_submitter_idx
    ON form_records (data_source_id, submitted_by)
    WHERE deleted_at IS NULL;

-- Append-only per-record history.
CREATE TABLE form_record_events (
    id UUID PRIMARY KEY,
    record_id UUID NOT NULL REFERENCES form_records(id) ON DELETE CASCADE,
    data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL
        CHECK (event_type IN ('created', 'transition', 'edited', 'comment', 'attachment_added', 'attachment_removed')),
    from_state TEXT NOT NULL DEFAULT '',
    to_state TEXT NOT NULL DEFAULT '',
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX form_record_events_record_idx ON form_record_events (record_id, created_at DESC);

CREATE TABLE form_record_comments (
    id UUID PRIMARY KEY,
    record_id UUID NOT NULL REFERENCES form_records(id) ON DELETE CASCADE,
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX form_record_comments_record_idx
    ON form_record_comments (record_id, created_at)
    WHERE deleted_at IS NULL;

-- Saved output views. Each non-deleted view projects to one named typed dataset.
CREATE TABLE form_views (
    id UUID PRIMARY KEY,
    data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    key TEXT NOT NULL CHECK (key ~ '^[a-z][a-z0-9_-]{0,79}$'),
    name TEXT NOT NULL,
    included_states TEXT[] NOT NULL DEFAULT '{}',
    field_filters JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(field_filters) = 'array'),
    time_filter JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(time_filter) = 'object'),
    sort JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sort) = 'array'),
    output_fields TEXT[] NOT NULL DEFAULT '{}',
    record_limit INTEGER NOT NULL DEFAULT 100 CHECK (record_limit BETWEEN 1 AND 2000),
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX form_views_key_idx
    ON form_views (data_source_id, key)
    WHERE deleted_at IS NULL;

-- Per-form access grants. This is the first per-resource ACL in the schema. Global roles are
-- unchanged; a grant additionally authorizes one user on one Form Data Source.
CREATE TABLE form_grants (
    id UUID PRIMARY KEY,
    data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    capability TEXT NOT NULL
        CHECK (capability IN ('manage', 'submit', 'view_own', 'view_all', 'review', 'approve')),
    granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (data_source_id, user_id, capability)
);
CREATE INDEX form_grants_user_idx ON form_grants (user_id, data_source_id);

-- Attachments distinguish form submission uploads from the public Media library. The origin
-- column keeps unapproved attachments out of the media picker, playlists, and manifests.
ALTER TABLE assets ADD COLUMN origin TEXT NOT NULL DEFAULT 'library'
    CHECK (origin IN ('library', 'form_attachment'));

CREATE TABLE form_record_attachments (
    id UUID PRIMARY KEY,
    record_id UUID NOT NULL REFERENCES form_records(id) ON DELETE CASCADE,
    asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
    field_key TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (record_id, asset_id)
);

-- +goose Down
DROP TABLE form_record_attachments;
ALTER TABLE assets DROP COLUMN origin;
DROP TABLE form_grants;
DROP TABLE form_views;
DROP TABLE form_record_comments;
DROP TABLE form_record_events;
DROP TABLE form_records;
DROP TABLE form_workflow_transitions;
DROP TABLE form_workflow_states;
DROP TABLE form_revisions;
