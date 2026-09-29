-- +goose Up
-- Layout preview capture generation. Thumbnails stored before the settled
-- capture pipeline (version 1) predate lifecycle-aware capture and may show
-- blank or half-rendered Widget zones. A missing version counts as stale so
-- Studio regenerates those previews once instead of trusting them forever.
ALTER TABLE layouts
    ADD COLUMN preview_capture_version INTEGER;
-- Pre-pipeline thumbnails predate lifecycle-aware capture and cannot satisfy
-- the version requirement below. Clear them so the affected rows read as
-- "no preview" (stale) instead of failing the new constraint; Studio
-- regenerates them once on the next editor visit.
UPDATE layouts
SET preview_image = NULL,
    preview_content_type = NULL,
    preview_width = NULL,
    preview_height = NULL,
    preview_updated_at = NULL
WHERE preview_image IS NOT NULL;
ALTER TABLE layouts
    DROP CONSTRAINT layouts_preview_image_shape,
    ADD CONSTRAINT layouts_preview_image_shape CHECK (
        (preview_image IS NULL AND preview_content_type IS NULL AND preview_width IS NULL AND preview_height IS NULL AND preview_updated_at IS NULL AND preview_capture_version IS NULL)
        OR
        (preview_image IS NOT NULL AND preview_content_type = 'image/jpeg' AND preview_width BETWEEN 1 AND 960 AND preview_height BETWEEN 1 AND 960 AND preview_updated_at IS NOT NULL AND preview_capture_version IS NOT NULL)
    );

-- +goose Down
ALTER TABLE layouts
    DROP CONSTRAINT layouts_preview_image_shape,
    DROP COLUMN preview_capture_version,
    ADD CONSTRAINT layouts_preview_image_shape CHECK (
        (preview_image IS NULL AND preview_content_type IS NULL AND preview_width IS NULL AND preview_height IS NULL AND preview_updated_at IS NULL)
        OR
        (preview_image IS NOT NULL AND preview_content_type = 'image/jpeg' AND preview_width BETWEEN 1 AND 960 AND preview_height BETWEEN 1 AND 960 AND preview_updated_at IS NOT NULL)
    );
