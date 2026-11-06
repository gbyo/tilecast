-- +goose Up
-- +goose StatementBegin

-- Font files are stored as system-managed assets of type 'font'. They reuse
-- verified storage, the Player asset download route, and backup, but the
-- Media library, its pickers, and playlists never list them: every library
-- query already requires system_managed=FALSE.
ALTER TABLE assets DROP CONSTRAINT assets_type_check;
ALTER TABLE assets ADD CONSTRAINT assets_type_check CHECK (type IN ('image','video','widget','font'));

-- One family is one name a person picks in Studio. The family name is
-- display metadata only; content references the generated ID, and the
-- Player registers the face under a generated CSS name.
CREATE TABLE font_families (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organization_settings(id) ON DELETE RESTRICT,
    family TEXT NOT NULL CHECK (char_length(family) BETWEEN 1 AND 100),
    source TEXT NOT NULL CHECK (source IN ('google','upload')),
    source_id TEXT NOT NULL DEFAULT '' CHECK (char_length(source_id) <= 100),
    source_version TEXT NOT NULL DEFAULT '' CHECK (char_length(source_version) <= 40),
    category TEXT NOT NULL DEFAULT '' CHECK (category IN ('','sans-serif','serif','display','handwriting','monospace','icons')),
    license TEXT NOT NULL DEFAULT '' CHECK (char_length(license) <= 40),
    subsets TEXT[] NOT NULL DEFAULT '{}',
    rights_attested_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX font_families_family_unique ON font_families (organization_id, lower(family)) WHERE deleted_at IS NULL;

-- One face is one verified file: a style, a weight range (a variable font
-- covers a range, a static font one weight), and an optional character
-- subset with its unicode-range.
CREATE TABLE font_faces (
    id UUID PRIMARY KEY,
    family_id UUID NOT NULL REFERENCES font_families(id) ON DELETE CASCADE,
    asset_id UUID NOT NULL UNIQUE REFERENCES assets(id) ON DELETE RESTRICT,
    style TEXT NOT NULL CHECK (style IN ('normal','italic')),
    weight_min INTEGER NOT NULL CHECK (weight_min BETWEEN 1 AND 1000),
    weight_max INTEGER NOT NULL CHECK (weight_max BETWEEN 1 AND 1000 AND weight_max >= weight_min),
    subset TEXT NOT NULL DEFAULT '' CHECK (char_length(subset) <= 40),
    unicode_range TEXT NOT NULL DEFAULT '' CHECK (char_length(unicode_range) <= 4000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX font_faces_family_idx ON font_faces (family_id);

ALTER TABLE layout_draft_dependencies DROP CONSTRAINT layout_draft_dependencies_dependency_type_check;
ALTER TABLE layout_draft_dependencies ADD CONSTRAINT layout_draft_dependencies_dependency_type_check
    CHECK (dependency_type IN ('widget','asset','playlist','data_source','font'));
ALTER TABLE layout_revision_dependencies DROP CONSTRAINT layout_revision_dependencies_dependency_type_check;
ALTER TABLE layout_revision_dependencies ADD CONSTRAINT layout_revision_dependencies_dependency_type_check
    CHECK (dependency_type IN ('widget','asset','playlist','data_source','font'));

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DELETE FROM layout_revision_dependencies WHERE dependency_type='font';
DELETE FROM layout_draft_dependencies WHERE dependency_type='font';
ALTER TABLE layout_revision_dependencies DROP CONSTRAINT layout_revision_dependencies_dependency_type_check;
ALTER TABLE layout_revision_dependencies ADD CONSTRAINT layout_revision_dependencies_dependency_type_check
    CHECK (dependency_type IN ('widget','asset','playlist','data_source'));
ALTER TABLE layout_draft_dependencies DROP CONSTRAINT layout_draft_dependencies_dependency_type_check;
ALTER TABLE layout_draft_dependencies ADD CONSTRAINT layout_draft_dependencies_dependency_type_check
    CHECK (dependency_type IN ('widget','asset','playlist','data_source'));

DROP TABLE font_faces;
DROP TABLE font_families;

-- Structural reverse only: stored font files are not removed from disk.
DELETE FROM asset_variants WHERE asset_id IN (SELECT id FROM assets WHERE type='font');
DELETE FROM assets WHERE type='font';
ALTER TABLE assets DROP CONSTRAINT assets_type_check;
ALTER TABLE assets ADD CONSTRAINT assets_type_check CHECK (type IN ('image','video','widget'));

-- +goose StatementEnd
