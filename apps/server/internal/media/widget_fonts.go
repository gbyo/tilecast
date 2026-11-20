package media

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
)

// recordWidgetFontsInTx replaces the library families a Widget's font fields
// choose (docs/fonts.md). Each family row is read FOR SHARE first. A font
// library deletion locks the row FOR UPDATE before it reads these
// references, so a save and a deletion cannot pass each other. A provider
// without font fields records nothing.
func (s *Service) recordWidgetFontsInTx(ctx context.Context, tx pgx.Tx, widgetID uuid.UUID, provider string, configuration any) error {
	definition, ok := s.definitions.Widget(provider)
	if !ok {
		return nil
	}
	values, _ := configuration.(map[string]any)
	fontIDs := contentdefs.FontFieldValues(definition.ConfigurationSchema.Fields, values)
	if _, err := tx.Exec(ctx, `DELETE FROM widget_font_references WHERE widget_id=$1`, widgetID); err != nil {
		return err
	}
	for _, fontID := range fontIDs {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM font_families WHERE id=$1 AND deleted_at IS NULL FOR SHARE)`, fontID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return &ConfigurationError{Err: errors.New("the chosen font was removed from the font library")}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO widget_font_references(widget_id,font_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, widgetID, fontID); err != nil {
			return err
		}
	}
	return nil
}
