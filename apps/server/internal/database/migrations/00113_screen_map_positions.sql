-- +goose Up
ALTER TABLE screens
    ADD COLUMN map_latitude DOUBLE PRECISION,
    ADD COLUMN map_longitude DOUBLE PRECISION,
    ADD CONSTRAINT screens_map_latitude_range CHECK (map_latitude BETWEEN -90 AND 90),
    ADD CONSTRAINT screens_map_longitude_range CHECK (map_longitude BETWEEN -180 AND 180),
    ADD CONSTRAINT screens_map_position_pair CHECK ((map_latitude IS NULL) = (map_longitude IS NULL));

-- +goose Down
ALTER TABLE screens
    DROP CONSTRAINT screens_map_position_pair,
    DROP CONSTRAINT screens_map_longitude_range,
    DROP CONSTRAINT screens_map_latitude_range,
    DROP COLUMN map_longitude,
    DROP COLUMN map_latitude;
