package externalplugins

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/targeting"
)

// ManifestForScreen never projects configuration, targets, operator facts,
// diagnostics, or KV data. Unsupported Players are gated by the composer.
func (s *Service) ManifestForScreen(ctx context.Context, screen uuid.UUID) ([]Entry, error) {
	type row struct {
		pkg, id, digest   string
		epoch             uuid.UUID
		state, targets    json.RawMessage
		validUntil        time.Time
		definitionVersion int
	}
	rows, err := s.db.Query(ctx, `SELECT state.package_id,state.contribution_id,installed.digest,installed.execution_epoch,
 state.state,state.targets,state.valid_until,state.definition_version
 FROM external_plugin_runtime_state state JOIN installed_packages installed
 ON installed.organization_id=state.organization_id AND installed.package_id=state.package_id
 JOIN installed_package_contributions contribution ON contribution.organization_id=state.organization_id
 AND contribution.package_id=state.package_id AND contribution.kind='plugin' AND contribution.contribution_id=state.contribution_id
 WHERE state.enabled AND state.state IS NOT NULL AND state.valid_until>$1
 ORDER BY state.package_id,state.contribution_id LIMIT $2`, s.now().UTC(), MaxEnabledInstances+1)
	if err != nil {
		return nil, err
	}
	var saved []row
	for rows.Next() {
		var item row
		if err = rows.Scan(&item.pkg, &item.id, &item.digest, &item.epoch, &item.state, &item.targets, &item.validUntil, &item.definitionVersion); err != nil {
			break
		}
		saved = append(saved, item)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(saved) > MaxEnabledInstances {
		return nil, fmt.Errorf("%w: too many enabled external plugins", ErrInvalid)
	}
	entries := []Entry{}
	for _, item := range saved {
		var targets targeting.Definition
		if err := json.Unmarshal(item.targets, &targets); err != nil {
			return nil, err
		}
		if err := targets.Validate(); err != nil {
			return nil, err
		}
		applies, err := targeting.Applies(ctx, s.db, targets, screen)
		if err != nil {
			return nil, err
		}
		if !applies {
			continue
		}
		nested, owned := strings.CutPrefix(item.id, item.pkg+".")
		if !owned || s.payloads == nil {
			continue
		}
		payload, ok, err := s.payloads.CurrentPluginPayload(ctx, item.pkg, nested, item.epoch)
		if err != nil {
			return nil, err
		}
		if !ok || payload.PackageDigest != item.digest || int(payload.Descriptor.DefinitionVersion) != item.definitionVersion {
			continue
		}
		state, err := normalizeState(item.state)
		if err != nil {
			continue
		}
		entries = append(entries, Entry{ID: item.id, Type: "external_plugin", Version: 1, DefinitionVersion: item.definitionVersion,
			Package: Package{PackageID: item.pkg, PackageDigest: item.digest, ContributionID: item.id, Frame: Frame{SHA256: payload.FrameSHA256Hex, FileSize: payload.FrameSize, DownloadPath: "/api/v1/player/packages/" + item.pkg + "/plugins/" + nested + "/frame"}},
			Runtime: payload.Descriptor.Runtime, State: state, ValidUntil: item.validUntil})
	}
	return entries, nil
}
