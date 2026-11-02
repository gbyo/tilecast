package wasm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/contributions"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/installer"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/packages"
	"github.com/tilecast/tilecast/apps/server/internal/extensions/services"
	"github.com/tilecast/tilecast/apps/server/internal/externalplugins"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// The integration scenario belongs to the package repository. Core knows
// only the host ABI, package lifecycle, targeting, and JSON assertions.
type packageScenario struct {
	RequestURL string        `json:"requestUrl"`
	Steps      []packageStep `json:"steps"`
}
type packageStep struct {
	Name            string          `json:"name"`
	UI              json.RawMessage `json:"ui"`
	UIExpected      json.RawMessage `json:"uiExpected"`
	Source          json.RawMessage `json:"source"`
	FetchFails      bool            `json:"fetchFails"`
	Job             bool            `json:"job"`
	JobFails        bool            `json:"jobFails"`
	Lifecycle       string          `json:"lifecycle"`
	UpdateVersion   string          `json:"updateVersion"`
	State           json.RawMessage `json:"state"`
	UnchangedFields []string        `json:"unchangedFields"`
	Screens         []int           `json:"screens"`
}

func TestExternalPackageFixture(t *testing.T) {
	ownerCapabilities, _ := auth.BuiltinCapabilities("owner")
	root, scenarioPath := os.Getenv("TILECAST_EXTERNAL_PACKAGE_FIXTURE"), os.Getenv("TILECAST_EXTERNAL_PACKAGE_SCENARIO")
	if root == "" || scenarioPath == "" {
		t.Skip("external OCI fixture and scenario paths are not set")
	}
	original, err := packages.VerifyLayout(root)
	if err != nil {
		t.Fatal(err)
	}
	rawScenario, err := os.ReadFile(scenarioPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(rawScenario) > 64<<10 {
		t.Fatal("scenario exceeds its bound")
	}
	var scenario packageScenario
	decoder := json.NewDecoder(bytes.NewReader(rawScenario))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&scenario); err != nil {
		t.Fatal(err)
	}
	if len(scenario.Steps) == 0 || len(scenario.Steps) > 100 || original.Manifest.Capabilities == nil || original.Manifest.Capabilities.Realtime == nil || len(original.Manifest.Capabilities.Realtime.Jobs) != 1 {
		t.Fatal("fixture requires bounded steps and one realtime job")
	}
	ctx := context.Background()
	pool := kvPool(t)
	if _, err := pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	org, owner, group, location := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	screens := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO organization_settings(singleton,organization_name,id)VALUES(true,'Package qualification',$1)`, org)
	exec(`INSERT INTO users(id,name,username,password_hash,role)VALUES($1,'Owner','fixture-owner','unused','owner')`, owner)
	exec(`INSERT INTO locations(id,organization_id,name)VALUES($1,$2,'Fixture location')`, location, org)
	exec(`INSERT INTO screen_groups(id,organization_id,name,created_by)VALUES($1,$2,'Fixture group',$3)`, group, org, owner)
	for index, screen := range screens {
		exec(`INSERT INTO screens(id,organization_id,player_installation_id,name,platform,device_manufacturer,device_model,android_version,player_version,screen_width,screen_height,density,locale,timezone)
   VALUES($1,$2,$3,$4,'linux','Test','Test','none','1.0',1920,1080,1,'en','UTC')`, screen, org, uuid.NewString(), fmt.Sprintf("Screen %d", index))
		exec(`INSERT INTO screen_player_status(screen_id,presentation_schema_versions,native_presentation_capabilities)VALUES($1,'{1,2,3}','{"plugin.external-runtime":1}')`, screen)
	}
	exec(`INSERT INTO screen_group_memberships(screen_group_id,screen_id,added_by)VALUES($1,$2,$3)`, group, screens[1], owner)
	exec(`UPDATE screens SET location_id=$2 WHERE id=$1`, screens[2], location)
	const fixtureVersion = "1.0.0"
	inst := installer.NewService(pool, fixtureVersion, installer.WithUnsignedDevelopmentAllowed())
	// First prove the original artifact's range; the local execution variant
	// changes only compatibility, never a published package or release claim.
	if packagemanifest.SatisfiesTilecastRange(original.Manifest.Tilecast.Version, fixtureVersion) {
		t.Fatal("draft qualification fixture unexpectedly claims compatibility")
	}
	if _, err := inst.Activate(ctx, installer.Activation{Manifest: original.Manifest, Digest: original.Digest, SourceKind: installer.SourceCustom,
		SourceReference: original.Manifest.Repository, RegistryReference: original.Manifest.Distribution.OCI, Trust: installer.TrustUnsignedDevelopment, InstalledBy: owner}); !errors.Is(err, installer.ErrIncompatible) {
		t.Fatalf("draft compatibility gate: %v", err)
	}
	contents := make(map[string]string)
	layouts := make(map[string]string)
	installVariant := func(manifest packagemanifest.Manifest) installer.InstalledPackage {
		t.Helper()
		manifest.Tilecast.Version = ">=1.0.0 <2.0.0"
		config, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		if len(original.ContentDigests) != 1 {
			t.Fatal("qualification fixture needs one content layer")
		}
		content, err := os.ReadFile(filepath.Join(root, "blobs", "sha256", strings.TrimPrefix(original.ContentDigests[0], "sha256:")))
		if err != nil {
			t.Fatal(err)
		}
		layout := t.TempDir()
		digest, err := packages.WriteLayout(layout, config, content)
		if err != nil {
			t.Fatal(err)
		}
		verified, err := packages.VerifyLayout(layout)
		if err != nil {
			t.Fatal(err)
		}
		dir := filepath.Join(t.TempDir(), "content")
		if err := packages.ExtractContent(layout, verified, dir); err != nil {
			t.Fatal(err)
		}
		nested, err := packages.ReadVerifiedContributions(ctx, layout, dir, verified)
		if err != nil {
			t.Fatal(err)
		}
		claims := make([]installer.Contribution, 0, len(nested))
		for _, item := range nested {
			claims = append(claims, installer.Contribution{Kind: item.Kind, ID: item.ID, Path: item.Path, Digest: item.Digest})
		}
		if err := ValidatePackageRuntime(dir, manifest); err != nil {
			t.Fatal(err)
		}
		layouts[digest], contents[digest] = layout, dir
		installed, err := inst.Activate(ctx, installer.Activation{Manifest: manifest, Digest: digest, SourceKind: installer.SourceCustom,
			SourceReference: manifest.Repository, RegistryReference: manifest.Distribution.OCI, Trust: installer.TrustUnsignedDevelopment, InstalledBy: owner, Contributions: claims})
		if err != nil {
			t.Fatal(err)
		}
		return installed
	}
	installed := installVariant(original.Manifest)
	contentDir := func(_ context.Context, _, digest string) (string, error) {
		dir, ok := contents[digest]
		if !ok {
			return "", errors.New("fixture artifact missing")
		}
		return dir, nil
	}
	readFile := func(ctx context.Context, _, digest, name string, max int64) ([]byte, error) {
		verified, err := packages.VerifyLayout(layouts[digest])
		if err != nil {
			return nil, err
		}
		return packages.ReadVerifiedContentFile(ctx, layouts[digest], verified, name, max)
	}
	release := contentdefs.MustLoad()
	provider := contentdefs.NewProvider(release)
	catalog := contributions.NewService(pool, inst, release, provider, contentDir, func(string) bool { return false }, func(*contentdefs.Catalog) error { return nil },
		contributions.WithVerifiedPluginFiles(func(ctx context.Context, ref, digest, path, file string, max int64) ([]byte, error) {
			return readFile(ctx, ref, digest, filepath.ToSlash(filepath.Join(path, file)), max)
		}))
	if err := catalog.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	var contributionID string
	claims, err := inst.Contributions(ctx, installed.PackageID)
	if err != nil {
		t.Fatal(err)
	}
	for _, claim := range claims {
		if claim.Kind == "plugin" {
			if contributionID != "" {
				t.Fatal("fixture requires one plugin")
			}
			contributionID = claim.ID
		}
	}
	if contributionID == "" {
		t.Fatal("fixture has no plugin")
	}
	deviceService := devices.NewService(pool, devices.NewPresenceHub(), "")
	stateService := externalplugins.NewService(pool, catalog, deviceService, deviceService)
	dispatcher := services.NewDispatcher(services.Dependencies{DB: pool, Devices: deviceService, ExternalPlugins: stateService})
	store := NewPostgresKV(pool)
	runtime, err := NewService(ctx, inst, contentDir, store, nil, WithServiceCaller(dispatcher), WithVerifiedModuleReader(func(ctx context.Context, ref, digest, module string) ([]byte, error) {
		return readFile(ctx, ref, digest, module, 16<<20)
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close(ctx) })
	var source []byte
	var fetchFails bool
	runtime.host.fetch = func(_ context.Context, rawURL string, allow []string) ([]byte, error) {
		parsed, err := url.Parse(rawURL)
		if err != nil || rawURL != scenario.RequestURL || parsed.Scheme != "https" || len(allow) != 1 || parsed.Hostname() != allow[0] {
			return nil, errors.New("fixture fetch outside approved request")
		}
		if fetchFails {
			return nil, errors.New("fixture upstream unavailable")
		}
		return source, nil
	}
	var jobStatus int32
	scheduler := NewRealtimeScheduler(pool, func(ctx context.Context, pkg, job string) (int32, error) {
		status, err := runtime.InvokeJob(ctx, pkg, job)
		jobStatus = status
		return status, err
	}, nil)
	if err := SyncInstalledJobs(ctx, pool, original.Manifest.PackageID, nil); err != nil {
		t.Fatal(err)
	}
	var previous map[string]any
	for _, step := range scenario.Steps {
		t.Run(step.Name, func(t *testing.T) {
			replace := func(raw json.RawMessage) json.RawMessage {
				var value any
				if err := json.Unmarshal(raw, &value); err != nil {
					t.Fatal(err)
				}
				var transform func(any) any
				now := time.Now().UTC()
				transform = func(value any) any {
					switch typed := value.(type) {
					case string:
						bindings := map[string]string{"@screen0": screens[0].String(), "@screen1": screens[1].String(), "@screen2": screens[2].String(), "@group": group.String(), "@location": location.String()}
						if binding, ok := bindings[typed]; ok {
							return binding
						}
						if strings.HasPrefix(typed, "@time:") {
							offset, err := strconv.ParseInt(strings.TrimPrefix(typed, "@time:"), 10, 64)
							if err != nil {
								t.Fatal(err)
							}
							return now.Add(time.Duration(offset) * time.Millisecond).Format(time.RFC3339Nano)
						}
						return typed
					case []any:
						for i, item := range typed {
							typed[i] = transform(item)
						}
						return typed
					case map[string]any:
						for key, item := range typed {
							typed[key] = transform(item)
						}
						return typed
					default:
						return value
					}
				}
				answer, err := json.Marshal(transform(value))
				if err != nil {
					t.Fatal(err)
				}
				return answer
			}
			if step.Lifecycle != "" {
				previousInstallation := installed
				switch step.Lifecycle {
				case "update":
					next := original.Manifest
					next.PackageVersion = step.UpdateVersion
					installed = installVariant(next)
				case "rollback":
					var err error
					installed, err = inst.Rollback(ctx, installed.PackageID, owner)
					if err != nil {
						t.Fatal(err)
					}
				case "remove":
					if err := inst.Remove(ctx, installed.PackageID, owner); err != nil {
						t.Fatal(err)
					}
				case "reinstall":
					installed = installVariant(original.Manifest)
				default:
					t.Fatal("unknown fixture lifecycle")
				}
				runtime.Evict(ctx, previousInstallation.Digest)
				if err := catalog.Rebuild(ctx); err != nil {
					t.Fatal(err)
				}
				if err := SyncInstalledJobs(ctx, pool, original.Manifest.PackageID, nil); err != nil {
					t.Fatal(err)
				}
				if step.Lifecycle == "remove" {
					ran, err := scheduler.RunOnce(ctx)
					if err != nil || ran != 0 {
						t.Fatalf("removed package job still ran: %d %v", ran, err)
					}
				}
				if step.Lifecycle == "update" || step.Lifecycle == "rollback" {
					if installed.ExecutionEpoch == previousInstallation.ExecutionEpoch || installed.StorageEpoch != previousInstallation.StorageEpoch {
						t.Fatal("lifecycle epochs failed")
					}
				}
				_, denial, failure := dispatcher.Call(ctx, services.Call{PackageID: previousInstallation.PackageID, PackageDigest: previousInstallation.Digest, ExecutionEpoch: previousInstallation.ExecutionEpoch,
					Context: services.ContextBackground, Grants: original.Manifest.Capabilities.Services, Operation: "plugin-runtime.state@1/get", Input: json.RawMessage(fmt.Sprintf(`{"contributionId":%q}`, contributionID))})
				if step.Lifecycle != "reinstall" && denial == nil && failure == nil {
					t.Fatal("replaced or removed epoch still accepted")
				}
			}
			if step.UI != nil {
				answer, err := runtime.InvokeUI(ctx, original.Manifest.PackageID, services.Actor{UserID: owner, Role: "owner", Capabilities: ownerCapabilities}, replace(step.UI))
				if err != nil {
					t.Fatal(err)
				}
				if answer.Status < 0 {
					t.Fatalf("guest UI failed: %d", answer.Status)
				}
				if step.UIExpected != nil {
					assertFixtureJSON(t, replace(step.UIExpected), answer.Output)
				}
			}
			if step.Source != nil {
				source = replace(step.Source)
			}
			fetchFails = step.FetchFails
			if step.Job {
				exec(`UPDATE external_plugin_jobs SET next_run_at=now()-interval '1 second' WHERE package_id=$1 AND job_kind='realtime'`, original.Manifest.PackageID)
				ran, err := scheduler.RunOnce(ctx)
				if err != nil || ran != 1 {
					t.Fatalf("scheduled job: %d %v", ran, err)
				}
				if (jobStatus < 0) != step.JobFails {
					t.Fatalf("job status: %d", jobStatus)
				}
				var outcome string
				var epoch uuid.UUID
				var interval int
				if err := pool.QueryRow(ctx, `SELECT last_status,execution_epoch,interval_seconds FROM external_plugin_jobs WHERE package_id=$1 AND job_kind='realtime'`, original.Manifest.PackageID).Scan(&outcome, &epoch, &interval); err != nil {
					t.Fatal(err)
				}
				want := "ok"
				if step.JobFails {
					want = "error"
				}
				if outcome != want || epoch != installed.ExecutionEpoch || interval != int(original.Manifest.Capabilities.Realtime.Jobs[0].IntervalSeconds) {
					t.Fatalf("scheduled outcome or epoch/cadence mismatch: %s %s %d", outcome, epoch, interval)
				}
			}
			if step.State != nil || step.Screens != nil || len(step.UnchangedFields) > 0 {
				allowed := map[int]bool{}
				for _, index := range step.Screens {
					allowed[index] = true
				}
				var current map[string]any
				for index, screen := range screens {
					entries, err := stateService.ManifestForScreen(ctx, screen)
					if err != nil {
						t.Fatal(err)
					}
					if (len(entries) > 0) != allowed[index] {
						t.Fatalf("screen %d received %d entries", index, len(entries))
					}
					if len(entries) > 0 {
						if entries[0].Package.PackageID != original.Manifest.PackageID || entries[0].Package.PackageDigest != installed.Digest || entries[0].Package.ContributionID != contributionID {
							t.Fatal("public state has wrong package identity")
						}
						raw, err := json.Marshal(entries[0].State)
						if err != nil {
							t.Fatal(err)
						}
						if step.State != nil {
							assertFixtureJSON(t, step.State, raw)
						}
						if err := json.Unmarshal(raw, &current); err != nil {
							t.Fatal(err)
						}
					}
				}
				for _, field := range step.UnchangedFields {
					if !reflect.DeepEqual(current[field], previous[field]) {
						t.Fatalf("field %s changed during retry/failure", field)
					}
				}
				previous = current
			}
		})
	}
}

func assertFixtureJSON(t *testing.T, wanted, actual []byte) {
	t.Helper()
	var expected, got any
	if err := json.Unmarshal(wanted, &expected); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(actual, &got); err != nil {
		t.Fatal(err)
	}
	var subset func(any, any) bool
	subset = func(expected, got any) bool {
		if object, ok := expected.(map[string]any); ok {
			other, ok := got.(map[string]any)
			if !ok {
				return false
			}
			for key, value := range object {
				if !subset(value, other[key]) {
					return false
				}
			}
			return true
		}
		return reflect.DeepEqual(expected, got)
	}
	if !subset(expected, got) {
		t.Fatalf("fixture JSON mismatch: wanted %s, got %s", wanted, actual)
	}
}
