package demo

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/approvals"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/campaigns"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/ids"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

// Services are the domain services a scenario seeds through. They are the
// instances the running server uses, so seeded records pass the same
// validation, editorial, and manifest invariants as records made in Studio.
type Services struct {
	DB         *pgxpool.Pool
	Auth       *auth.Service
	Devices    *devices.Service
	Presence   *devices.PresenceHub
	Media      *media.Service
	Playlists  *playlists.Service
	Layouts    *layouts.Service
	Scheduling *scheduling.Service
	Approvals  *approvals.Service
	Plugins    *plugins.Service
	Campaigns  *campaigns.Service
	Settings   *settings.Service
}

// ScreenState is the operational state a seeded screen shows in Studio.
type ScreenState string

const (
	// StateOnline screens hold a live player socket through the simulator.
	StateOnline ScreenState = "online"
	// StateRecent screens send HTTP heartbeats through the simulator without a
	// socket, the fallback a real player uses when its socket cannot connect.
	StateRecent ScreenState = "recent"
	// StateStale, StateOffline, and StateDisabled screens have no simulator.
	// Their last contact is set once at seed time, so they age like a player
	// that went silent at that moment.
	StateStale    ScreenState = "stale"
	StateOffline  ScreenState = "offline"
	StateDisabled ScreenState = "disabled"
)

// simulated reports whether a live simulator drives the state.
func (s ScreenState) simulated() bool { return s == StateOnline || s == StateRecent }

// lastContactAge is how long before the seed a silent screen last reported.
func (s ScreenState) lastContactAge() time.Duration {
	switch s {
	case StateStale:
		return 6 * time.Minute
	case StateDisabled:
		return 2 * time.Hour
	default:
		return 3*24*time.Hour + 5*time.Hour
	}
}

// Device is the hardware a seeded screen reports, as a real player would in
// its pairing request and heartbeats.
type Device struct {
	Platform      string
	Manufacturer  string
	Model         string
	OSVersion     string
	PlayerVersion string
	VersionCode   int64
	AndroidSDK    int
	Width, Height int
	Density       float32
}

// ScreenSpec describes one seeded screen.
type ScreenSpec struct {
	ID          uuid.UUID
	Name        string
	LocationID  *uuid.UUID
	RoomName    string
	RoomNumber  string
	Description string
	Device      Device
	State       ScreenState
}

// Player is a simulated player the seed enrolled. The credential exists only
// in memory: it came from the real enrollment path exactly once and is never
// written anywhere.
type Player struct {
	ScreenID   uuid.UUID
	ScreenName string
	Credential string
	Device     Device
	Socket     bool
}

type builder struct {
	ctx     context.Context
	svc     Services
	owner   uuid.UUID
	players []Player
}

func (b *builder) with(id uuid.UUID) context.Context { return ids.WithNext(b.ctx, id) }

// expect fails loudly when a service ignored the reserved ID, which would make
// the dataset silently non-deterministic.
func expect(kind string, want, got uuid.UUID) error {
	if want != got {
		return fmt.Errorf("demo %s was created as %s, want %s", kind, got, want)
	}
	return nil
}

func (b *builder) location(id uuid.UUID, input devices.LocationInput) error {
	created, err := b.svc.Devices.CreateLocation(b.with(id), b.owner, input)
	if err != nil {
		return fmt.Errorf("create location %q: %w", input.Name, err)
	}
	return expect("location", id, created.ID)
}

// user adds a managed account. Studio creates accounts in its HTTP handler, so
// there is no domain service to call; this mirrors that handler's insert and
// audit entry. The password is random and discarded: Demo Mode signs in only
// as the Owner.
func (b *builder) user(id uuid.UUID, name, username, role string) error {
	hash, err := auth.HashPassword(randomPassword())
	if err != nil {
		return err
	}
	if _, err = b.svc.DB.Exec(b.ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,$5,TRUE)`, id, name, username, hash, role); err != nil {
		return fmt.Errorf("create user %q: %w", username, err)
	}
	_, err = b.svc.DB.Exec(b.ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,'user.created','user',$3,jsonb_build_object('role',$4::text))`, uuid.New(), b.owner, id.String(), role)
	return err
}

// screen enrolls a screen through the same pairing sequence a real player and
// an approving Owner perform: request, approval, private poll, one-time
// enrollment. Silent states then receive their last-contact time.
func (b *builder) screen(spec ScreenSpec) error {
	credential, err := b.enroll(spec, false)
	if err != nil {
		return err
	}
	// Every player reports once, through the real heartbeat path, right after
	// enrollment. That records its details and presentation capabilities the
	// way a fielded player does, before any Layout is assigned to it.
	principal, err := b.svc.Devices.AuthenticateDevice(b.ctx, credential)
	if err != nil {
		return err
	}
	if err = b.svc.Devices.Heartbeat(b.ctx, principal, heartbeatFor(spec.Device, nil), "192.0.2.10:0"); err != nil {
		return fmt.Errorf("record heartbeat for %q: %w", spec.Name, err)
	}
	if spec.State.simulated() {
		b.players = append(b.players, playerFor(spec, credential))
		return nil
	}
	if err = backdateContact(b.ctx, b.svc.DB, spec.ID, spec.State.lastContactAge()); err != nil {
		return err
	}
	if spec.State == StateDisabled {
		return b.svc.Devices.SetEnabled(b.ctx, spec.ID, b.owner, false)
	}
	return nil
}

func playerFor(spec ScreenSpec, credential string) Player {
	return Player{ScreenID: spec.ID, ScreenName: spec.Name, Credential: credential, Device: spec.Device, Socket: spec.State == StateOnline}
}

// enroll runs pairing and enrollment and returns the one-time credential.
// With replace, the same player repairs its existing screen's credential, the
// recovery path an Owner approves when a player lost its stored credential.
func (b *builder) enroll(spec ScreenSpec, replace bool) (string, error) {
	identity, err := b.svc.Devices.Identity(b.ctx)
	if err != nil {
		return "", err
	}
	metadata := devices.DeviceMetadata{
		PlayerInstallationID: playerInstallationID(spec.ID), Platform: spec.Device.Platform,
		Manufacturer: spec.Device.Manufacturer, Model: spec.Device.Model, AndroidVersion: spec.Device.OSVersion,
		PlayerVersion: spec.Device.PlayerVersion, ScreenWidth: spec.Device.Width, ScreenHeight: spec.Device.Height,
		Density: spec.Device.Density, Locale: "en-US", Timezone: demoTimezone,
	}
	pairing, err := b.svc.Devices.CreatePairing(b.ctx, identity.InstallationID, metadata)
	if err != nil {
		return "", fmt.Errorf("request pairing for %q: %w", spec.Name, err)
	}
	approved, err := b.svc.Devices.ApprovePairingWithOptions(b.with(spec.ID), pairing.ID, b.owner, devices.PairingApproval{
		Name: spec.Name, LocationID: spec.LocationID, RoomName: spec.RoomName, RoomNumber: spec.RoomNumber, Description: spec.Description,
		ReplaceExistingCredential: replace,
	})
	if err != nil {
		return "", fmt.Errorf("approve pairing for %q: %w", spec.Name, err)
	}
	if err = expect("screen", spec.ID, approved.ID); err != nil {
		return "", err
	}
	poll, err := b.svc.Devices.PollPairing(b.ctx, pairing.ID, pairing.PollSecret)
	if err != nil || poll.EnrollmentToken == "" {
		return "", fmt.Errorf("claim pairing for %q: status %q: %w", spec.Name, poll.Status, err)
	}
	enrolled, err := b.svc.Devices.Enroll(b.ctx, pairing.ID, poll.EnrollmentToken)
	if err != nil {
		return "", fmt.Errorf("enroll %q: %w", spec.Name, err)
	}
	return enrolled.DeviceCredential, nil
}

// pendingPairing leaves one player waiting for approval, which Studio shows
// in the pairing queue until it expires ten minutes later.
func (b *builder) pendingPairing(device Device) error {
	identity, err := b.svc.Devices.Identity(b.ctx)
	if err != nil {
		return err
	}
	_, err = b.svc.Devices.CreatePairing(b.ctx, identity.InstallationID, devices.DeviceMetadata{
		PlayerInstallationID: uuid.NewSHA1(fixedID(kindPlayer, 0), []byte("pending")).String(), Platform: device.Platform,
		Manufacturer: device.Manufacturer, Model: device.Model, AndroidVersion: device.OSVersion, PlayerVersion: device.PlayerVersion,
		ScreenWidth: device.Width, ScreenHeight: device.Height, Density: device.Density, Locale: "en-US", Timezone: demoTimezone,
	})
	return err
}

func (b *builder) group(id uuid.UUID, name, description string, screens ...uuid.UUID) error {
	created, err := b.svc.Scheduling.CreateGroup(b.with(id), b.owner, name, description)
	if err != nil {
		return fmt.Errorf("create group %q: %w", name, err)
	}
	if err = expect("group", id, created.ID); err != nil {
		return err
	}
	for _, screen := range screens {
		if err = b.svc.Scheduling.AddScreen(b.ctx, id, screen, b.owner); err != nil {
			return fmt.Errorf("add screen to %q: %w", name, err)
		}
	}
	return nil
}

func (b *builder) tag(id uuid.UUID, name, color string) error {
	created, err := b.svc.Media.CreateTag(b.with(id), b.owner, name, color)
	if err != nil {
		return fmt.Errorf("create tag %q: %w", name, err)
	}
	return expect("tag", id, created.ID)
}

type slideAsset struct {
	ID    uuid.UUID
	Slide slide
	Name  string
}

// slides uploads every image through the resumable upload path and waits for
// the media workers to finish processing, so playlists can use them.
func (b *builder) slides(assets ...slideAsset) error {
	for _, asset := range assets {
		content, err := asset.Slide.render()
		if err != nil {
			return err
		}
		upload, err := b.svc.Media.CreateUpload(b.ctx, b.owner, asset.Slide.Filename, "image/png", int64(len(content)))
		if err != nil {
			return fmt.Errorf("create upload %q: %w", asset.Slide.Filename, err)
		}
		if _, err = b.svc.Media.AppendUpload(b.ctx, upload.ID, b.owner, 0, bytes.NewReader(content)); err != nil {
			return fmt.Errorf("upload %q: %w", asset.Slide.Filename, err)
		}
		created, err := b.svc.Media.FinalizeUpload(b.with(asset.ID), upload.ID, b.owner)
		if err != nil {
			return fmt.Errorf("finalize %q: %w", asset.Slide.Filename, err)
		}
		if err = expect("asset", asset.ID, created.ID); err != nil {
			return err
		}
		if asset.Name != "" {
			if _, err = b.svc.Media.UpdateAsset(b.ctx, asset.ID, b.owner, &asset.Name, nil); err != nil {
				return err
			}
		}
	}
	for _, asset := range assets {
		if err := b.awaitReady(asset.ID); err != nil {
			return err
		}
	}
	return nil
}

// awaitReady observes the asset's processing state rather than sleeping for a
// guessed duration.
func (b *builder) awaitReady(id uuid.UUID) error {
	ctx, cancel := context.WithTimeout(b.ctx, 90*time.Second)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		asset, err := b.svc.Media.GetAsset(ctx, id)
		if err == nil {
			switch asset.ProcessingStatus {
			case media.StatusReady:
				return nil
			case media.StatusFailed:
				return fmt.Errorf("demo asset %s failed processing: %s", id, valueOr(asset.ErrorMessage))
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("demo asset %s did not finish processing: %w", id, ctx.Err())
		case <-ticker.C:
		}
	}
}

func (b *builder) tagAssets(tag uuid.UUID, assets ...uuid.UUID) error {
	return b.svc.Media.BulkOrganize(b.ctx, b.owner, media.BulkOrganizeInput{AssetIDs: assets, AddTagIDs: []uuid.UUID{tag}})
}

func (b *builder) widget(id uuid.UUID, input media.WidgetInput) error {
	created, err := b.svc.Media.CreateWidget(b.with(id), b.owner, input)
	if err != nil {
		return fmt.Errorf("create widget %q: %w", input.Name, err)
	}
	return expect("widget", id, created.ID)
}

func (b *builder) website(id uuid.UUID, input media.WebsiteInput) error {
	created, err := b.svc.Media.CreateWebsite(b.with(id), b.owner, input)
	if err != nil {
		return fmt.Errorf("create website %q: %w", input.Name, err)
	}
	return expect("website", id, created.ID)
}

type playlistItem struct {
	Asset    uuid.UUID
	Layout   *uuid.UUID
	Duration time.Duration
}

// playlist creates a static playlist, adds its items to the draft, and
// publishes the draft through the editorial service unless it should stay an
// unpublished draft.
func (b *builder) playlist(id uuid.UUID, name, description string, publish bool, items ...playlistItem) error {
	created, err := b.svc.Playlists.Create(b.with(id), b.owner, name, description, "static")
	if err != nil {
		return fmt.Errorf("create playlist %q: %w", name, err)
	}
	if err = expect("playlist", id, created.ID); err != nil {
		return err
	}
	for _, item := range items {
		duration := item.Duration.Milliseconds()
		input := playlists.ItemInput{AssetID: item.Asset, LayoutID: item.Layout, DurationMS: &duration, FitMode: "cover", Transition: "fade", DeliveryPolicy: "download"}
		if _, err = b.svc.Playlists.AddItem(b.ctx, id, b.owner, input); err != nil {
			return fmt.Errorf("add item to %q: %w", name, err)
		}
	}
	if !publish {
		return nil
	}
	draft, err := b.svc.Playlists.GetDraft(b.ctx, id)
	if err != nil {
		return err
	}
	if _, err = b.svc.Approvals.SubmitAndPublish(b.ctx, b.owner, "owner", approvals.TypePlaylist, id, draft.DraftRevision); err != nil {
		return fmt.Errorf("publish playlist %q: %w", name, err)
	}
	return nil
}

func (b *builder) layout(id uuid.UUID, name, description, orientation string, width, height int, publish bool, placements ...layouts.Placement) error {
	created, err := b.svc.Layouts.Create(b.with(id), b.owner, name, description, orientation, width, height)
	if err != nil {
		return fmt.Errorf("create layout %q: %w", name, err)
	}
	if err = expect("layout", id, created.ID); err != nil {
		return err
	}
	document := created.Draft
	document.Placements = placements
	saved, err := b.svc.Layouts.SaveDraft(b.ctx, id, b.owner, created.DraftRevision, document)
	if err != nil {
		return fmt.Errorf("save layout %q: %w", name, err)
	}
	if !publish {
		return nil
	}
	if _, err = b.svc.Approvals.SubmitAndPublish(b.ctx, b.owner, "owner", approvals.TypeLayout, id, saved.DraftRevision); err != nil {
		return fmt.Errorf("publish layout %q: %w", name, err)
	}
	return nil
}

func (b *builder) assignScreen(screen uuid.UUID, playlist, layout *uuid.UUID) error {
	if _, err := b.svc.Playlists.AssignPresentation(b.ctx, screen, playlist, layout, b.owner); err != nil {
		return fmt.Errorf("assign screen %s: %w", screen, err)
	}
	return nil
}

func (b *builder) assignGroup(group uuid.UUID, playlist, layout *uuid.UUID) error {
	if err := b.svc.Playlists.AssignGroupPresentation(b.ctx, group, playlist, layout, b.owner); err != nil {
		return fmt.Errorf("assign group %s: %w", group, err)
	}
	return nil
}

func (b *builder) schedule(id uuid.UUID, input scheduling.Input) error {
	created, err := b.svc.Scheduling.Create(b.with(id), b.owner, input)
	if err != nil {
		return fmt.Errorf("create schedule %q: %w", input.Name, err)
	}
	return expect("schedule", id, created.ID)
}

func (b *builder) installPlugins(ids ...string) error {
	for _, id := range ids {
		if _, _, err := b.svc.Plugins.Install(b.ctx, id, b.owner); err != nil {
			return fmt.Errorf("install plugin %s: %w", id, err)
		}
	}
	return nil
}

func (b *builder) campaign(id uuid.UUID, name, description string, edit func(*campaigns.Snapshot)) error {
	created, err := b.svc.Campaigns.Create(b.with(id), b.owner, name, description, demoTimezone)
	if err != nil {
		return fmt.Errorf("create campaign %q: %w", name, err)
	}
	if err = expect("campaign", id, created.ID); err != nil {
		return err
	}
	if edit == nil {
		return nil
	}
	draft := created.Draft
	edit(&draft)
	if _, err = b.svc.Campaigns.UpdateDraft(b.ctx, id, b.owner, created.DraftRevision, draft); err != nil {
		return fmt.Errorf("edit campaign %q: %w", name, err)
	}
	return nil
}

// organizationSettings changes organization settings through the settings
// registry, which validates every value.
func (b *builder) organizationSettings(values map[string]any) error {
	document, err := b.svc.Settings.Organization(b.ctx)
	if err != nil {
		return err
	}
	merged := map[string]any{}
	for key, value := range document.Values {
		merged[key] = value
	}
	for key, value := range values {
		merged[key] = value
	}
	if _, err = b.svc.Settings.UpdateOrganization(b.ctx, b.owner, document.Revision, merged); err != nil {
		return fmt.Errorf("update organization settings: %w", err)
	}
	return nil
}

// heartbeatFor is the status report a player of this kind sends. The
// capability lists match what the Android and Linux players declare.
func heartbeatFor(device Device, manifestVersion *int64) devices.Heartbeat {
	uptime := int64(3 * 24 * 60 * 60)
	storage := int64(18) << 30
	heartbeat := devices.Heartbeat{
		ScreenWidth: device.Width, ScreenHeight: device.Height, PlayerVersion: device.PlayerVersion,
		UptimeSeconds: &uptime, AvailableStorageBytes: &storage, PlaybackState: "playing",
		PresentationSchemaVersions:     []int{1},
		NativePresentationCapabilities: presentationCapabilities,
		WebRuntimeVersion:              2,
		WebBundleLimitBytes:            20 << 20,
		ActiveManifestVersion:          manifestVersion,
	}
	if device.VersionCode > 0 {
		code := device.VersionCode
		heartbeat.PlayerVersionCode = &code
	}
	if device.AndroidSDK > 0 {
		sdk := device.AndroidSDK
		heartbeat.AndroidSDK = &sdk
		heartbeat.InstallerSource = "sideload"
	}
	return heartbeat
}

var presentationCapabilities = map[string]int{
	"layout.surface": 1, "layout.box": 1, "layout.row": 1, "layout.column": 1, "layout.stack": 1, "layout.grid": 1, "layout.spacer": 1, "layout.divider": 1,
	"content.text": 1, "content.icon": 2, "content.asset_image": 2, "content.badge": 1, "content.progress": 2, "content.qr_code": 1, "content.marquee": 1,
	"content.line_chart": 2, "content.bar_chart": 2, "content.donut_chart": 2,
	"collection.repeat": 2, "collection.conditional": 2, "collection.grouped_sections": 1, "binding.core": 2, "format.typed": 2,
	"selection.relative_date": 1, "selection.temporal": 1, "playback.auto_skip": 1,
}

func randomPassword() string {
	value := make([]byte, 24)
	_, _ = rand.Read(value)
	return base64.RawURLEncoding.EncodeToString(value)
}

func valueOr(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func mustJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

var errNotDemoDatabase = errors.New("the database holds an installation that Demo Mode did not create; Demo Mode refuses to replace it. Point TILECAST_DATABASE_URL at an empty, disposable database")
