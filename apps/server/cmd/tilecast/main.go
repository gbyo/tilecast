package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/alerts"
	"github.com/tilecast/tilecast/apps/server/internal/approvals"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/backup"
	"github.com/tilecast/tilecast/apps/server/internal/campaigns"
	"github.com/tilecast/tilecast/apps/server/internal/config"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/contenthealth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/demo"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/discovery"
	"github.com/tilecast/tilecast/apps/server/internal/fleetops"
	"github.com/tilecast/tilecast/apps/server/internal/forms"
	"github.com/tilecast/tilecast/apps/server/internal/httpapi"
	"github.com/tilecast/tilecast/apps/server/internal/integrations"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/notify"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/presentations"
	"github.com/tilecast/tilecast/apps/server/internal/presentnet"
	"github.com/tilecast/tilecast/apps/server/internal/previews"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
	"github.com/tilecast/tilecast/apps/server/internal/snapshots"
	"github.com/tilecast/tilecast/apps/server/internal/span"
	"github.com/tilecast/tilecast/apps/server/internal/updates"
	"github.com/tilecast/tilecast/apps/server/internal/version"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "backup", "restore", "mfa":
			runCLI(os.Args[1], os.Args[2:])
			return
		case "serve":
			// Fall through to the server below.
		case "help", "-h", "--help":
			printUsage()
			return
		default:
			fmt.Fprintf(os.Stderr, "unknown command %q\n\n", os.Args[1])
			printUsage()
			os.Exit(2)
		}
	}
	serve()
}

func serve() {
	cfg, err := config.Load()
	if err != nil {
		fail("configuration is invalid", err)
	}

	logger := newLogger(cfg.LogLevel)
	ctx := context.Background()

	if err := database.Migrate(ctx, cfg.DatabaseURL); err != nil {
		fail("database migration failed", err)
	}

	db, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		fail("database connection failed", err)
	}
	defer db.Close()
	contentDefinitions, err := contentdefs.Load()
	if err != nil {
		fail("content definition validation failed", err)
	}
	if err = media.ValidateContentAdapters(contentDefinitions); err != nil {
		fail("content adapter validation failed", err)
	}

	authService := auth.NewService(db, cfg.SessionTTL)
	webAuthnConfig, passkeyUnavailable := auth.ResolveWebAuthnConfig("Tilecast", cfg.PublicURL, cfg.WebAuthn.RPID, cfg.WebAuthn.Origins)
	if err = authService.ConfigurePasskeys(webAuthnConfig, passkeyUnavailable); err != nil {
		fail("passkey configuration failed", err)
	}
	if passkeyUnavailable != "" {
		logger.Info("passkeys are disabled", "reason", passkeyUnavailable)
	}
	presence := devices.NewPresenceHub()
	deviceService := devices.NewService(db, presence, cfg.PublicURL)
	mediaStorage, err := media.NewLocalStorage(cfg.Media.Root)
	if err != nil {
		fail("media storage initialization failed", err)
	}
	if err := media.ValidateExecutable(cfg.Media.FFmpegPath); err != nil {
		fail("FFmpeg validation failed", err)
	}
	if err := media.ValidateExecutable(cfg.Media.FFprobePath); err != nil {
		fail("FFprobe validation failed", err)
	}
	mediaService := media.NewService(db, mediaStorage, media.Config{
		MaxUploadBytes: cfg.Media.MaxUploadBytes, ReservedFreeBytes: cfg.Media.ReservedFreeBytes,
		FFmpegPath: cfg.Media.FFmpegPath, FFprobePath: cfg.Media.FFprobePath,
		Profile: media.CompatibilityProfile{MaxWidth: cfg.Media.VideoMaxWidth, MaxHeight: cfg.Media.VideoMaxHeight, MaxFrameRate: cfg.Media.VideoMaxFrameRate},
		Workers: cfg.Media.Workers, KeepOriginals: cfg.Media.KeepOriginals,
		Website:           media.WebsitePolicy{AllowPrivateHTTP: cfg.Website.AllowPrivateHTTP, DefaultTimeoutSeconds: cfg.Website.DefaultTimeoutSeconds, MaxTimeoutSeconds: cfg.Website.MaxTimeoutSeconds, MinRefreshSeconds: cfg.Website.MinRefreshSeconds, MaxAllowedHosts: cfg.Website.MaxAllowedHosts, MaxWebsites: cfg.Website.MaxWebsites},
		SourceFetch:       media.SourceFetchPolicy{AllowPrivateNetworks: cfg.Sources.AllowPrivateNetworks, Timeout: time.Duration(cfg.Sources.TimeoutSeconds) * time.Second, MaximumBytes: cfg.Sources.MaximumResponseBytes, MaximumRedirects: cfg.Sources.MaximumRedirects, MinimumRefresh: time.Duration(cfg.Sources.MinimumRefreshSeconds) * time.Second, MaximumRefresh: time.Duration(cfg.Sources.MaximumRefreshSeconds) * time.Second},
		AirQualityBaseURL: cfg.Sources.AirQualityBaseURL,
	})
	playlistService := playlists.NewService(db, deviceService)
	spanService := span.NewService(db, mediaStorage, span.Config{FFmpegPath: cfg.Media.FFmpegPath, FFprobePath: cfg.Media.FFprobePath}, deviceService)
	playlistService.SetSpanProjector(spanService)
	presentationService := presentations.NewService(db, deviceService)
	presentationService.SetPresentationReadiness(playlistService)
	playlistService.SetPresentationOverrides(presentationService)
	pluginService := plugins.NewService(db, deviceService)
	pluginService.SetManifestInvalidator(playlistService)
	playlistService.SetPluginProjector(pluginService)
	mediaService.SetContentDefinitions(contentDefinitions)
	playlistService.SetContentDefinitions(contentDefinitions)
	layoutService := layouts.NewService(db)
	layoutService.SetNotifier(deviceService)
	layoutService.SetManifestInvalidator(playlistService)
	mediaService.SetAssetInvalidator(playlistService)
	playlistService.SetSourceProjector(mediaService)
	formService := forms.NewService(db, mediaService)
	formService.SetContentDefinitions(contentDefinitions)
	formService.SetAssetInvalidator(playlistService)
	scheduleLimits := scheduling.Limits{MaxSchedules: cfg.Scheduling.MaxSchedules, MaxTargetsPerSchedule: cfg.Scheduling.MaxTargetsPerSchedule, MaxGroupsPerScreen: cfg.Scheduling.MaxGroupsPerScreen, PrefetchDays: cfg.Scheduling.PrefetchDays, ActivationGraceSeconds: cfg.Scheduling.ActivationGraceSeconds, ClockSkewWarningSeconds: cfg.Scheduling.ClockSkewWarningSeconds}
	schedulingService := scheduling.NewService(db, deviceService, scheduleLimits)
	schedulingService.SetPresentationReadiness(playlistService)
	playlistService.SetScheduling(schedulingService)
	settingsService := settings.NewService(db, deviceService, settings.HardLimits{MaxUploadBytes: cfg.Media.MaxUploadBytes, MaxTakeoverMinutes: cfg.Operations.MaxTakeoverDurationHours * 60, MaxWebsiteTimeout: cfg.Website.MaxTimeoutSeconds, MaxPrefetchDays: cfg.Scheduling.PrefetchDays, PrivateHTTPAllowed: cfg.Website.AllowPrivateHTTP})
	schedulingService.SetOrganizationSettingsProvider(settingsService)
	// Presentation Networks seal Wi-Fi credentials with an environment-backed
	// key. A missing key must not stop the server: signage, AirPlay without a
	// Presentation Network, and every other feature keep working, and Studio
	// reports a specific operator-facing limitation for the one capability that
	// cannot function. A key that is present but malformed *is* fatal, because
	// ignoring it would leave an operator believing credentials were protected.
	presentationNetworkCipher, cipherErr := presentnet.LoadCipher(cfg.PresentationNetworkKey)
	if cipherErr != nil {
		fail("load "+presentnet.KeyEnvironmentVariable, cipherErr)
	}
	presentationNetworkService := presentnet.NewService(db, presentationNetworkCipher)
	presentationNetworkService.SetConfigBumper(settingsService)
	if !presentationNetworkService.CredentialsAvailable() {
		logger.Info("Presentation Network credentials are unavailable",
			"reason", presentnet.KeyEnvironmentVariable+" is not set")
	}
	campaignService := campaigns.NewService(db, deviceService)
	campaignService.SetPresentationChecker(playlistService)
	campaignService.SetScheduler(schedulingService)
	campaignService.SetSchedulingLimits(scheduleLimits)
	alertService := alerts.NewService(db, deviceService, playlistService, logger, cfg.PublicURL, time.Duration(cfg.Operations.MaxTakeoverDurationHours)*time.Hour)
	updateService, updateErr := updates.NewService(db, updates.NewGitHubProvider(cfg.Updates.GitHubToken), updates.Config{Root: cfg.Updates.Root, TrustedPublicKey: cfg.Updates.TrustedPublicKey, MaxAPKBytes: cfg.Updates.MaxAPKBytes, GitHubClientID: cfg.Updates.GitHubClientID, GitHubTokenConfigured: strings.TrimSpace(cfg.Updates.GitHubToken) != ""})
	if updateErr != nil {
		fail("initialize player update service", updateErr)
	}
	backupGuard := backup.NewGuard()
	backupService, err := backup.NewService(db, cfg.Backup.Root, backupGuard)
	if err != nil {
		fail("initialize backup service", err)
	}
	backupWorker := backup.NewWorker(backupService, backup.WorkerConfig{
		DatabaseURL:       cfg.DatabaseURL,
		MediaRoot:         cfg.Media.Root,
		UpdatesRoot:       cfg.Updates.Root,
		ReservedFreeBytes: cfg.Backup.ReservedFreeBytes,
		Limits:            backup.Limits{MaxFiles: cfg.Backup.MaxArchiveFiles, MaxExpandedBytes: cfg.Backup.MaxArchiveBytes},
		TilecastVersion:   version.Version,
	}, logger)
	backupWorker.Start(ctx)
	defer backupWorker.Stop()
	// A session-level advisory lock marks a live server so the CLI can
	// refuse to restore while the server is running.
	serverLockConn, lockErr := pgx.Connect(ctx, cfg.DatabaseURL)
	if lockErr != nil {
		fail("acquire server lock connection", lockErr)
	}
	defer serverLockConn.Close(context.Background())
	var lockAcquired bool
	if err := serverLockConn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, backup.ServerAdvisoryLockID).Scan(&lockAcquired); err != nil {
		fail("acquire server advisory lock", err)
	}
	if !lockAcquired {
		logger.Warn("another Tilecast server appears to hold the database lock; backup CLI safety checks may misbehave")
	}
	_, _ = db.Exec(ctx, `INSERT INTO media_jobs(id,kind,status,run_after) VALUES(gen_random_uuid(),'clean_expired_uploads','queued',now())`)
	mediaWorkers := media.NewWorkerPool(mediaService, logger)
	mediaWorkers.SetExtraProcessor(spanService.ProcessJob)
	mediaWorkers.SetGate(backupGuard.BackgroundJobsAllowed)
	mediaWorkers.Start(ctx)
	defer mediaWorkers.Stop()
	sourceWorker := media.NewDataSourceRefreshWorker(mediaService, logger)
	sourceWorker.SetGate(backupGuard.BackgroundJobsAllowed)
	sourceWorker.Start(ctx)
	defer sourceWorker.Stop()
	formWorker := forms.NewProjectionWorker(formService, logger)
	formWorker.SetGate(backupGuard.BackgroundJobsAllowed)
	formWorker.Start(ctx)
	defer formWorker.Stop()
	notifyConfig := notify.DefaultConfig()
	notifyConfig.SMTPHost = cfg.Notifications.SMTPHost
	notifyConfig.SMTPPort = cfg.Notifications.SMTPPort
	notifyConfig.SMTPUsername = cfg.Notifications.SMTPUsername
	notifyConfig.SMTPPassword = cfg.Notifications.SMTPPassword
	notifyConfig.SMTPTLS = cfg.Notifications.SMTPTLS
	notifyConfig.SMTPAllowInsecure = cfg.Notifications.SMTPAllowInsecure
	notifyConfig.SMTPAllowPlaintextAuth = cfg.Notifications.SMTPAllowPlaintextAuth
	notifyConfig.PublicURL = cfg.PublicURL
	notifyService := notify.NewService(db, settingsService, notifyConfig,
		notify.NewSMTPSender(notifyConfig), notify.NewWebhookSender(notifyConfig), logger)
	if !notifyConfig.EmailConfigured() {
		logger.Info("notification email is unavailable", "reason", "TILECAST_SMTP_HOST is not set")
	}
	contentHealthService := contenthealth.NewService(db, settingsService)
	fleetService := fleetops.NewService(db, playlistService, deviceService, logger)
	integrationService := integrations.NewService(db)
	approvalService := approvals.NewService(db, settingsService)
	approvalService.SetProvider(approvals.TypePlaylist, playlistService)
	approvalService.SetProvider(approvals.TypeLayout, layoutService)
	approvalService.SetProvider(approvals.TypeCampaign, campaignService)
	if err := approvalService.ReconcileScheduled(ctx); err != nil {
		logger.Error("scheduled publication startup reconciliation failed", "error", err)
	}
	// Low-level Layout callers cannot publish around the editorial policy. The
	// HTTP publication path goes through approvals.Service and records the
	// immutable submission/publication history.
	layoutService.SetPublicationGuard(func(ctx context.Context, _ uuid.UUID, _ uuid.UUID, _ int64) error {
		if approvalService.Policy(ctx) != approvals.PolicyOff {
			return approvals.ErrReviewRequired
		}
		return nil
	})
	// The snapshot service drives scheduled captures through the same live
	// preview lease Studio uses, so there is one capture path.
	snapshotService := snapshots.NewService(db, settingsService, previews.NewService(db, deviceService), logger)
	snapshotWorker := snapshots.NewWorker(snapshotService, logger)
	snapshotWorker.SetGate(backupGuard.BackgroundJobsAllowed)
	snapshotWorker.Start(ctx)
	defer snapshotWorker.Stop()
	// The assignment path gets the transactional gate, which holds the content
	// locked against a concurrent edit until the assignment commits. The bulk
	// preview gets the advisory one: it reports what would happen and writes
	// nothing, and the apply that follows goes through the assignment path.
	playlistService.SetApprovalGate(approvalService.GateTx)
	fleetService.SetApprovalGate(approvalService.Gate)
	fleetService.SetScopeAuthorizer(deviceService)
	notifyWorker := notify.NewWorker(notifyService, logger)
	notifyWorker.AddSweeper(contentHealthService)
	notifyWorker.SetGate(backupGuard.BackgroundJobsAllowed)
	notifyWorker.Start(ctx)
	defer notifyWorker.Stop()
	alertService.SetGate(backupGuard.BackgroundJobsAllowed)
	alertService.Start(ctx)
	defer alertService.Stop()
	if cfg.MDNSEnabled {
		identity, identityErr := deviceService.Identity(ctx)
		if identityErr != nil {
			fail("read server identity for discovery", identityErr)
		}
		if identity.InstallationID == "" {
			logger.Info("mDNS discovery will begin after initial setup and a server restart")
		} else {
			discoveryServer, discoveryErr := discovery.Advertise(identity, cfg.PublicURL)
			if discoveryErr != nil {
				logger.Warn("mDNS discovery is unavailable", "error", discoveryErr)
			} else {
				defer discoveryServer.Shutdown()
				logger.Info("advertising Tilecast on the local network", "service", "_tilecast._tcp.local")
			}
		}
	}
	var demoRuntime *demo.Runtime
	if cfg.DemoMode() {
		demoRuntime = startDemo(ctx, cfg, logger, demo.Services{
			DB: db, Auth: authService, Devices: deviceService, Presence: presence, Media: mediaService,
			Playlists: playlistService, Layouts: layoutService, Scheduling: schedulingService, Approvals: approvalService,
			Plugins: pluginService, Campaigns: campaignService, Settings: settingsService,
		})
		defer demoRuntime.Stop()
	}
	handler := httpapi.New(httpapi.Dependencies{
		Auth:                 authService,
		PublicURL:            cfg.PublicURL,
		Devices:              deviceService,
		Media:                mediaService,
		Forms:                formService,
		Playlists:            playlistService,
		Campaigns:            campaignService,
		Presentations:        presentationService,
		Plugins:              pluginService,
		Layouts:              layoutService,
		Scheduling:           schedulingService,
		Settings:             settingsService,
		Updates:              updateService,
		Alerts:               alertService,
		Notifications:        notifyService,
		ContentHealth:        contentHealthService,
		Fleet:                fleetService,
		Integrations:         integrationService,
		Approvals:            approvalService,
		Snapshots:            snapshotService,
		Span:                 spanService,
		PresentationNetworks: presentationNetworkService,
		DB:                   db,
		Logger:               logger,
		CookieName:           cfg.CookieName,
		SecureCookies:        cfg.CookieSecure,
		ReleasePublishToken:  cfg.Updates.PublishToken,
		Backups:              backupService,
		BackupWorker:         backupWorker,
		BackupLimits:         backup.Limits{MaxFiles: cfg.Backup.MaxArchiveFiles, MaxExpandedBytes: cfg.Backup.MaxArchiveBytes},
		Operations: httpapi.OperationsConfig{
			MaxTakeoverDurationHours:    cfg.Operations.MaxTakeoverDurationHours,
			MaxTakeoverTargets:          cfg.Operations.MaxTakeoverTargets,
			MaxPendingCommands:          cfg.Operations.MaxPendingCommands,
			DefaultCommandExpiryMinutes: cfg.Operations.DefaultCommandExpiryMinutes,
			MaxIdentifySeconds:          cfg.Operations.MaxIdentifySeconds,
			CommandRetentionDays:        cfg.Operations.CommandRetentionDays,
		},
		Demo: demoRuntime,
	})

	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       0,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	shutdownCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		// AirPlay has a player-local deadline as a second line of defense, but
		// the server also expires sessions when a player is offline so the
		// transient identity and commands do not remain active in Studio/DB.
		deviceService.ExpireAirplaySessions(shutdownCtx)
		// A group interrupted mid-preparation by a restart is resolved from
		// durable state, not from a goroutine that no longer exists. Expiry runs
		// first so an already-expired session is never resumed.
		handler.ReconcileAirplaySessions(shutdownCtx)
		for {
			select {
			case <-shutdownCtx.Done():
				return
			case <-ticker.C:
				if err := approvalService.ReconcileScheduled(shutdownCtx); err != nil {
					logger.Error("scheduled publication reconciliation failed", "error", err)
				}
				deviceService.ExpireAirplaySessions(shutdownCtx)
				handler.ReconcileAirplaySessions(shutdownCtx)
				updateService.Cleanup(shutdownCtx, cfg.Updates.RetentionDays)
				_, _ = db.Exec(shutdownCtx, `UPDATE player_commands SET state='expired',completed_at=now(),updated_at=now() WHERE state IN ('pending','delivered','acknowledged','running') AND expires_at<=now()`)
				_, _ = db.Exec(shutdownCtx, `DELETE FROM player_commands WHERE completed_at<now()-make_interval(days=>COALESCE((SELECT (settings->>'retention.command_history_days')::int FROM organization_runtime_settings),$1))`, cfg.Operations.CommandRetentionDays)
				_, _ = db.Exec(shutdownCtx, `DELETE FROM audit_logs WHERE created_at<now()-make_interval(days=>COALESCE((SELECT (settings->>'retention.audit_days')::int FROM organization_runtime_settings),365))`)
				rows, err := db.Query(shutdownCtx, `WITH expired AS (UPDATE takeovers SET status='expired',updated_at=now() WHERE status='active' AND expires_at<=now() RETURNING id), affected AS (UPDATE takeover_screen_states SET state='expired',restored_at=now(),last_updated_at=now() WHERE takeover_id IN(SELECT id FROM expired) RETURNING screen_id), bumped AS (UPDATE screen_manifest_state SET manifest_version=manifest_version+1,changed_at=now(),change_reason='takeover.expired' WHERE screen_id IN(SELECT DISTINCT screen_id FROM affected) RETURNING screen_id,manifest_version) SELECT screen_id,manifest_version FROM bumped`)
				if err == nil {
					for rows.Next() {
						var screen uuid.UUID
						var version int64
						if rows.Scan(&screen, &version) == nil {
							deviceService.Notify(screen, map[string]any{"type": "takeover.changed", "manifestVersion": version})
							deviceService.Notify(screen, map[string]any{"type": "manifest.changed", "manifestVersion": version})
						}
					}
					rows.Close()
				}
			}
		}
	}()

	go func() {
		logger.Info("Tilecast server listening", "address", cfg.HTTPAddr, "environment", cfg.Environment)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fail("server stopped unexpectedly", err)
		}
	}()

	<-shutdownCtx.Done()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
	}
}

// startDemo seeds the disposable demo installation before the server accepts
// traffic. Demo Mode is logged loudly because it signs every visitor in as the
// Owner.
func startDemo(ctx context.Context, cfg config.Config, logger *slog.Logger, services demo.Services) *demo.Runtime {
	logger.Warn("DEMO MODE IS ENABLED: every visitor is signed in as the Owner and the database is disposable sample data",
		"scenario", cfg.Demo.Scenario, "reset_on_start", cfg.Demo.ResetOnStart, "public_url", cfg.PublicURL)
	baseURL, err := demo.LoopbackURL(cfg.HTTPAddr)
	if err != nil {
		fail("configure Demo Mode", err)
	}
	runtime, err := demo.NewRuntime(services, demo.Options{
		Scenario: cfg.Demo.Scenario, ResetOnStart: cfg.Demo.ResetOnStart, Players: cfg.Demo.Players, BaseURL: baseURL,
	}, logger)
	if err != nil {
		fail("configure Demo Mode", err)
	}
	if err = runtime.Start(ctx); err != nil {
		fail("seed Demo Mode", err)
	}
	return runtime
}

func newLogger(level string) *slog.Logger {
	var parsed slog.Level
	if err := parsed.UnmarshalText([]byte(level)); err != nil {
		parsed = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parsed}))
}

func fail(message string, err error) {
	slog.Error(message, "error", err)
	os.Exit(1)
}
