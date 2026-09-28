package devices

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tilecast/tilecast/apps/server/internal/ids"
)

type Location struct {
	ID           uuid.UUID `json:"id"`
	Name         string    `json:"name"`
	AddressLine1 string    `json:"addressLine1"`
	AddressLine2 string    `json:"addressLine2"`
	City         string    `json:"city"`
	State        string    `json:"state"`
	PostalCode   string    `json:"postalCode"`
	Country      string    `json:"country"`
	Latitude     *float64  `json:"latitude,omitempty"`
	Longitude    *float64  `json:"longitude,omitempty"`
	ScreenCount  int       `json:"screenCount"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type LocationInput struct {
	Name         string   `json:"name"`
	AddressLine1 string   `json:"addressLine1"`
	AddressLine2 string   `json:"addressLine2"`
	City         string   `json:"city"`
	State        string   `json:"state"`
	PostalCode   string   `json:"postalCode"`
	Country      string   `json:"country"`
	Latitude     *float64 `json:"latitude"`
	Longitude    *float64 `json:"longitude"`
}

const locationSelect = `SELECT l.id,l.name,l.address_line_1,l.address_line_2,l.city,l.state,l.postal_code,l.country,l.latitude,l.longitude,
	(SELECT count(*) FROM screens s WHERE s.location_id=l.id AND s.archived_at IS NULL),l.created_at,l.updated_at FROM locations l`

func normalizeLocationInput(input LocationInput) (LocationInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.AddressLine1 = strings.TrimSpace(input.AddressLine1)
	input.AddressLine2 = strings.TrimSpace(input.AddressLine2)
	input.City = strings.TrimSpace(input.City)
	input.State = strings.TrimSpace(input.State)
	input.PostalCode = strings.TrimSpace(input.PostalCode)
	input.Country = strings.TrimSpace(input.Country)
	if len(input.Name) < 1 || len(input.Name) > 120 || len(input.AddressLine1) > 240 ||
		len(input.AddressLine2) > 240 || len(input.City) > 120 || len(input.State) > 120 ||
		len(input.PostalCode) > 40 || len(input.Country) > 120 {
		return LocationInput{}, errors.New("location details are invalid")
	}
	if input.Latitude != nil && (*input.Latitude < -90 || *input.Latitude > 90) {
		return LocationInput{}, errors.New("latitude must be between -90 and 90")
	}
	if input.Longitude != nil && (*input.Longitude < -180 || *input.Longitude > 180) {
		return LocationInput{}, errors.New("longitude must be between -180 and 180")
	}
	return input, nil
}

func scanLocation(row scanner) (Location, error) {
	var location Location
	err := row.Scan(&location.ID, &location.Name, &location.AddressLine1, &location.AddressLine2, &location.City, &location.State, &location.PostalCode, &location.Country, &location.Latitude, &location.Longitude, &location.ScreenCount, &location.CreatedAt, &location.UpdatedAt)
	return location, err
}

func (s *Service) ListLocations(ctx context.Context) ([]Location, error) {
	rows, err := s.db.Query(ctx, locationSelect+` ORDER BY lower(l.name),l.id`)
	if err != nil {
		return nil, fmt.Errorf("list locations: %w", err)
	}
	defer rows.Close()
	items := []Location{}
	for rows.Next() {
		item, scanErr := scanLocation(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) GetLocation(ctx context.Context, id uuid.UUID) (Location, error) {
	item, err := scanLocation(s.db.QueryRow(ctx, locationSelect+` WHERE l.id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Location{}, ErrNotFound
	}
	return item, err
}

func (s *Service) CreateLocation(ctx context.Context, userID uuid.UUID, input LocationInput) (Location, error) {
	input, err := normalizeLocationInput(input)
	if err != nil {
		return Location{}, err
	}
	var id uuid.UUID
	err = s.db.QueryRow(ctx, `INSERT INTO locations(id,organization_id,name,address_line_1,address_line_2,city,state,postal_code,country,latitude,longitude)
		SELECT $10,id,$1,$2,$3,$4,$5,$6,$7,$8,$9 FROM organization_settings WHERE singleton=TRUE RETURNING id`,
		input.Name, input.AddressLine1, input.AddressLine2, input.City, input.State, input.PostalCode, input.Country, input.Latitude, input.Longitude, ids.New(ctx)).Scan(&id)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" {
			return Location{}, ErrConflict
		}
		return Location{}, fmt.Errorf("create location: %w", err)
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,'location.created','location',$3)`, uuid.New(), userID, id.String())
	return s.GetLocation(ctx, id)
}

func (s *Service) UpdateLocation(ctx context.Context, id, userID uuid.UUID, input LocationInput) (Location, error) {
	input, err := normalizeLocationInput(input)
	if err != nil {
		return Location{}, err
	}
	result, err := s.db.Exec(ctx, `UPDATE locations SET name=$2,address_line_1=$3,address_line_2=$4,city=$5,state=$6,postal_code=$7,country=$8,latitude=$9,longitude=$10,updated_at=now() WHERE id=$1`,
		id, input.Name, input.AddressLine1, input.AddressLine2, input.City, input.State, input.PostalCode, input.Country, input.Latitude, input.Longitude)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" {
			return Location{}, ErrConflict
		}
		return Location{}, fmt.Errorf("update location: %w", err)
	}
	if result.RowsAffected() != 1 {
		return Location{}, ErrNotFound
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,'location.updated','location',$3)`, uuid.New(), userID, id.String())
	return s.GetLocation(ctx, id)
}

func (s *Service) DeleteLocation(ctx context.Context, id, userID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Archived rows must never keep a reusable location alive. This also cleans
	// up installations upgraded from versions that only hid revoked screens.
	if _, err := tx.Exec(ctx, `UPDATE screens SET location_id=NULL,updated_at=now() WHERE location_id=$1 AND archived_at IS NOT NULL`, id); err != nil {
		return fmt.Errorf("detach archived screens from location: %w", err)
	}
	var assigned int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM screens WHERE location_id=$1 AND archived_at IS NULL`, id).Scan(&assigned); err != nil {
		return err
	}
	if assigned > 0 {
		return ErrConflict
	}
	result, err := tx.Exec(ctx, `DELETE FROM locations WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete location: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ErrNotFound
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,'location.deleted','location',$3)`, uuid.New(), userID, id.String()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
