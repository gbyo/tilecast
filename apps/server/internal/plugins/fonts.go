package plugins

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

const maxFontLabelRunes = 200

// fontService implements plugin.Fonts. It is bound to the calling plugin's
// identity at Host construction, so a plugin records and releases only its
// own references.
type fontService struct{ pluginID string }

func (s fontService) UseInTx(ctx context.Context, tx pgx.Tx, ownerID uuid.UUID, label string, fontIDs ...uuid.UUID) error {
	if ownerID == uuid.Nil {
		return fmt.Errorf("%w: a font reference needs an owner", plugin.ErrInvalid)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM font_references WHERE plugin_id=$1 AND owner_id=$2`, s.pluginID, ownerID); err != nil {
		return err
	}
	if len(fontIDs) == 0 {
		return nil
	}
	if len(fontIDs) > plugin.MaxPlayerStateFonts {
		return fmt.Errorf("%w: at most %d font families", plugin.ErrInvalid, plugin.MaxPlayerStateFonts)
	}
	label = strings.TrimSpace(label)
	if label == "" {
		return fmt.Errorf("%w: a font reference needs a label", plugin.ErrInvalid)
	}
	if utf8.RuneCountInString(label) > maxFontLabelRunes {
		label = string([]rune(label)[:maxFontLabelRunes])
	}
	for _, fontID := range fontIDs {
		// FOR SHARE serializes with a library removal, which locks the
		// family row FOR UPDATE before it checks for references.
		var exists bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM font_families WHERE id=$1 AND deleted_at IS NULL FOR SHARE)`, fontID).Scan(&exists)
		if err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("%w: the font is not in the library", plugin.ErrInvalid)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO font_references(plugin_id,owner_id,font_id,label) VALUES($1,$2,$3,$4)
			ON CONFLICT (plugin_id,owner_id,font_id) DO UPDATE SET label=EXCLUDED.label`, s.pluginID, ownerID, fontID, label); err != nil {
			return err
		}
	}
	return nil
}

func (s fontService) ReleaseInTx(ctx context.Context, tx pgx.Tx, ownerID uuid.UUID) error {
	_, err := tx.Exec(ctx, `DELETE FROM font_references WHERE plugin_id=$1 AND owner_id=$2`, s.pluginID, ownerID)
	return err
}
