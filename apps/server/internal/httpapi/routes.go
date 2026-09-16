package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/tilecast/tilecast/apps/server/internal/integrations"
	"github.com/tilecast/tilecast/apps/server/internal/web"
)

// Content roles, named so the difference is visible at every call site rather
// than inferred from a repeated literal.
//
// A Contributor authors content but cannot publish a Layout, delete anything,
// or put content on a screen. Assignment has always been Owner/Administrator
// only, so the boundary that matters for a Contributor is publish and delete.
var (
	contentAuthors  = []string{"owner", "administrator", "editor", "contributor"}
	contentManagers = []string{"owner", "administrator", "editor"}
)

func (s *server) routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(s.securityHeaders)
	r.Use(s.requestLog)
	r.Use(s.restoreGate)
	r.Get("/healthz", s.health)
	// Linux provisioning. Unauthenticated on purpose: a machine being installed
	// has no credential yet, and these serve only what an operator has already
	// published — the vetted script and a release they chose to cache.
	r.With(s.installRateLimit).Get("/install.sh", s.installScript)
	r.With(s.installRateLimit).Get("/install-airplay.sh", s.airplayInstallScript)
	r.With(s.installRateLimit).Get("/install/tilecast-player.service", s.playerServiceUnit)
	// The Presentation Network helper installer and its system unit. Same
	// unauthenticated boundary as the other provisioning assets: they serve only
	// what an operator already published, and a box being installed has no
	// credential yet.
	r.With(s.installRateLimit).Get("/install-presentation-network.sh", s.presentationNetworkInstallScript)
	r.With(s.installRateLimit).Get("/install/tilecast-networkd.service", s.presentationNetworkServiceUnit)
	r.Get("/readyz", s.ready)
	r.Route("/api/v1", func(api chi.Router) {
		api.Get("/system/health", s.health)
		api.Get("/system/identity", s.systemIdentity)
		api.With(s.installRateLimit).Get("/install/linux", s.installableLinuxRelease)
		api.With(s.installRateLimit).Get("/install/linux/artifact", s.installableLinuxArtifact)
		api.With(s.installRateLimit).Head("/install/linux/artifact", s.installableLinuxArtifact)
		api.With(s.installRateLimit).Get("/install/airplay/uxplay", s.installableUxPlayArtifact)
		api.With(s.installRateLimit).Head("/install/airplay/uxplay", s.installableUxPlayArtifact)
		api.With(s.installRateLimit).Get("/install/airplay/uxplay.sha256", s.installableUxPlayChecksum)
		api.With(s.installRateLimit).Get("/install/presentation-network/helper", s.presentationNetworkHelper)
		api.With(s.installRateLimit).Head("/install/presentation-network/helper", s.presentationNetworkHelper)
		api.With(s.installRateLimit).Get("/install/presentation-network/helper.sha256", s.presentationNetworkHelperChecksum)
		api.Get("/auth/status", s.authStatus)
		api.With(s.authRateLimit).Post("/auth/setup", s.setup)
		api.With(s.authRateLimit).Post("/auth/login", s.login)
		api.With(s.requireSession, s.requireCSRF).Post("/auth/logout", s.logout)
		api.With(s.authRateLimit).Post("/auth/mfa/verify", s.verifyMFA)
		api.With(s.authRateLimit).Post("/auth/mfa/passkey/options", s.beginMFAPasskey)
		api.With(s.authRateLimit).Post("/auth/passkey/login/options", s.beginPasskeyLogin)
		api.With(s.authRateLimit).Post("/auth/passkey/login", s.finishPasskeyLogin)

		// Security self-service sits outside the dashboard group because a
		// session waiting on enrollment must still be able to enroll.
		api.Group(func(security chi.Router) {
			security.Use(s.requireSession)
			security.Get("/me/security", s.listFactors)
			security.With(s.requireCSRF).Post("/me/security/totp", s.beginTOTPEnrollment)
			security.With(s.requireCSRF).Post("/me/security/totp/confirm", s.confirmTOTPEnrollment)
			security.With(s.requireCSRF).Post("/me/security/totp/remove", s.disableTOTP)
			security.With(s.requireCSRF).Post("/me/security/recovery-codes", s.regenerateRecoveryCodes)
			security.With(s.requireCSRF).Post("/me/security/passkeys/options", s.beginPasskeyRegistration)
			security.With(s.requireCSRF).Post("/me/security/passkeys", s.finishPasskeyRegistration)
			security.With(s.requireCSRF).Patch("/me/security/passkeys/{id}", s.renamePasskey)
			security.With(s.requireCSRF).Post("/me/security/passkeys/{id}/remove", s.deletePasskey)
		})

		api.With(s.pairingRateLimit).Post("/player/pairing-sessions", s.createPairingSession)
		api.Get("/player/pairing-sessions/{id}", s.pollPairingSession)
		api.With(s.pairingRateLimit).Post("/player/enroll", s.enrollPlayer)
		api.With(s.requireDevice).Post("/player/heartbeat", s.playerHeartbeat)
		api.With(s.requireDevice).Get("/player/socket", s.playerSocket)
		api.With(s.requireDevice).Get("/player/live-stream-session", s.playerLiveStreamSession)
		api.With(s.requireDevice).Get("/player/assets/{assetId}/variants/{variantId}", s.playerAssetVariant)
		api.With(s.requireDevice).Head("/player/assets/{assetId}/variants/{variantId}", s.playerAssetVariant)
		api.With(s.requireDevice).Get("/player/span-panels/{id}", s.playerSpanPanel)
		api.With(s.requireDevice).Head("/player/span-panels/{id}", s.playerSpanPanel)
		api.With(s.requireDevice).Get("/player/manifest", s.playerManifest)
		api.With(s.requireDevice).Get("/player/commands", s.playerCommands)
		api.With(s.requireDevice).Get("/player/config", s.playerConfig)
		// Presentation Network provisioning material. The permanent player
		// credential is required, the network is derived from the authenticated
		// screen's own assignment rather than from the request, and the response
		// is no-store. See presentation_networks.go.
		api.With(s.requireDevice).Get("/player/presentation-network", s.playerPresentationNetworkSecret)
		api.With(s.requireDevice).Post("/player/commands/{id}/acknowledge", s.acknowledgePlayerCommand)
		api.With(s.requireDevice).Post("/player/commands/{id}/result", s.resultPlayerCommand)
		api.With(s.requireDevice).Get("/player/updates/{releaseId}", s.playerUpdateMetadata)
		api.With(s.requireDevice).Get("/player/updates/{releaseId}/apk", s.playerUpdateArtifact)
		api.With(s.requireDevice).Head("/player/updates/{releaseId}/apk", s.playerUpdateArtifact)
		api.With(s.requireDevice).Get("/player/updates/{releaseId}/artifact", s.playerUpdateArtifact)
		api.With(s.requireDevice).Head("/player/updates/{releaseId}/artifact", s.playerUpdateArtifact)
		api.With(s.requireDevice).Post("/player/update-deployments/{deploymentId}/status", s.playerUpdateStatus)
		api.With(s.operationsRateLimit, s.requireReleasePublisher, s.blockDuringBackup).Post("/player-releases/upload", s.uploadPlayerRelease)

		// Integration tokens are a third authentication boundary, next to the
		// dashboard cookie and the device credential. These routes take neither
		// a session nor a CSRF token, and each one names the scope it needs.
		api.With(s.operationsRateLimit, s.requireIntegrationToken(integrations.ScopeDataSourceWrite), s.blockDuringBackup).
			Put("/integration/data-sources/{id}/rows", s.replaceDataSourceRows)
		api.With(s.operationsRateLimit, s.requireIntegrationToken(integrations.ScopeActivityRead)).
			Get("/integration/activity/fleet", s.integrationFleetHealth)
		api.With(s.operationsRateLimit, s.requireIntegrationToken(integrations.ScopeActivityRead)).
			Get("/integration/metrics", s.integrationMetrics)

		api.Group(func(dashboard chi.Router) {
			dashboard.Use(s.requireSession)
			dashboard.Use(s.requireEnrollment)
			dashboard.Get("/screens", s.listScreens)
			dashboard.Get("/screens/archive", s.listArchivedScreens)
			dashboard.With(s.requireScreenScope).Get("/screens/{id}", s.getScreen)
			dashboard.With(s.requireScreenScope).Get("/screens/{id}/player-history", s.listScreenPlayerHistory)
			dashboard.With(s.requireCSRF, s.requireScreenScope).Post("/screens/{id}/live-stream", s.startLiveStream)
			dashboard.With(s.requireCSRF, s.requireScreenScope).Post("/screens/{id}/live-stream/{sessionId}/renew", s.renewLiveStream)
			dashboard.With(s.requireCSRF, s.requireScreenScope).Delete("/screens/{id}/live-stream/{sessionId}", s.endLiveStream)
			dashboard.With(s.requireScreenScope).Get("/screens/{id}/live-stream/{sessionId}/mjpeg", s.watchLiveStream)
			dashboard.With(s.requireScreenScope).Get("/screens/{id}/reliability", s.screenReliability)
			// AirPlay Present is a temporary, high-priority external
			// presentation. Only screen managers can start/stop it; read access
			// is available to any enrolled dashboard session.
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/airplay/sessions", s.createAirplaySession)
			dashboard.Get("/airplay/sessions/{id}", s.getAirplaySession)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/airplay/sessions/{id}/stop", s.stopAirplaySession)
			// Presentation Networks are reusable organization Wi-Fi definitions a
			// Linux player joins temporarily for AirPlay. They are administrative
			// settings, so they carry the same Owner/Administrator + CSRF boundary as
			// every other settings and screen-assignment operation. Credentials are
			// write-only: no read here can produce a stored PSK or password.
			dashboard.With(s.requireRoles("owner", "administrator")).Get("/presentation-networks", s.listPresentationNetworks)
			dashboard.With(s.requireRoles("owner", "administrator")).Get("/presentation-networks/{id}", s.getPresentationNetwork)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/presentation-networks", s.createPresentationNetwork)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Patch("/presentation-networks/{id}", s.updatePresentationNetwork)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/presentation-networks/{id}", s.deletePresentationNetwork)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Put("/presentation-networks/{id}/screens", s.replacePresentationNetworkAssignments)
			dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF).Post("/presentation-networks/{id}/test", s.testPresentationNetwork)
			dashboard.With(s.requireScreenScope).Get("/screens/{id}/presentation-network", s.getScreenPresentationNetwork)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope).Put("/screens/{id}/presentation-network", s.putScreenPresentationNetwork)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope).Delete("/screens/{id}/presentation-network", s.deleteScreenPresentationNetwork)
			dashboard.Get("/presentation-overrides", s.listPresentationOverrides)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/presentation-overrides", s.createPresentationOverride)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/presentation-overrides/{id}/stop", s.stopPresentationOverride)
			dashboard.Get("/locations", s.listLocations)
			dashboard.Get("/plugins", s.listPlugins)
			dashboard.Get("/plugins/dependency-graph", s.dependencyGraph)
			dashboard.Get("/plugins/countdown-bar/instances", s.listCountdownBars)
			dashboard.Get("/plugins/countdown-bar/instances/{id}", s.getCountdownBar)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/plugins/countdown-bar/instances", s.createCountdownBar)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Put("/plugins/countdown-bar/instances/{id}", s.updateCountdownBar)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/plugins/countdown-bar/instances/{id}", s.deleteCountdownBar)
			dashboard.Get("/plugins/brand-bug/instances", s.listBrandBugs)
			dashboard.Get("/plugins/brand-bug/instances/{id}", s.getBrandBug)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/plugins/brand-bug/instances", s.createBrandBug)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Put("/plugins/brand-bug/instances/{id}", s.updateBrandBug)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/plugins/brand-bug/instances/{id}", s.deleteBrandBug)
			dashboard.Get("/plugins/noise-meter/instances", s.listNoiseMeters)
			dashboard.Get("/plugins/noise-meter/instances/{id}", s.getNoiseMeter)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/plugins/noise-meter/instances", s.createNoiseMeter)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Put("/plugins/noise-meter/instances/{id}", s.updateNoiseMeter)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/plugins/noise-meter/instances/{id}", s.deleteNoiseMeter)
			// History reads. Screens are resolved from the caller's own scope,
			// never from the request, and the ten-second table is never exposed
			// directly: every route here answers with an aggregation.
			dashboard.Get("/plugins/noise-meter/instances/{id}/history/screens", s.noiseHistoryScreens)
			dashboard.Get("/plugins/noise-meter/instances/{id}/history/summary", s.noiseHistorySummary)
			dashboard.Get("/plugins/noise-meter/instances/{id}/history/series", s.noiseHistorySeries)
			dashboard.Get("/plugins/noise-meter/instances/{id}/history/daily", s.noiseHistoryDaily)
			dashboard.Get("/plugins/noise-meter/instances/{id}/history/export.csv", s.exportNoiseHistory)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/locations", s.createLocation)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Patch("/locations/{id}", s.updateLocation)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/locations/{id}", s.deleteLocation)
			dashboard.Get("/screen-groups", s.listScreenGroups)
			dashboard.Get("/screen-groups/{id}", s.getScreenGroup)
			dashboard.Get("/screen-groups/{id}/span", s.getSpanStatus)
			dashboard.With(s.requireRoles("owner", "administrator")).Get("/screen-groups/{id}/display-control/preview", s.previewGroupDisplayControl)
			dashboard.Get("/schedules", s.listSchedules)
			dashboard.Get("/schedules/{id}", s.getSchedule)
			dashboard.Get("/settings", s.getSettings)
			dashboard.With(s.requireRoles("owner", "administrator")).Get("/users", s.listUsers)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/users", s.createUser)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Patch("/users/{id}", s.updateUser)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/users/{id}", s.deleteUser)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/users/{id}/permanent", s.permanentlyDeleteUser)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/users/{id}/security/reset", s.resetUserFactors)
			dashboard.Get("/me/preferences", s.getPreferences)
			dashboard.With(s.requireCSRF).Patch("/me/preferences", s.updatePreferences)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Patch("/settings", s.updateSettings)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/settings/reset", s.resetSettings)
			dashboard.Get("/screen-groups/{id}/policy", s.getGroupPolicy)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Put("/screen-groups/{id}/policy", s.putGroupPolicy)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/screen-groups/{id}/policy", s.deleteGroupPolicy)
			dashboard.With(s.requireScreenScope).Get("/screens/{id}/policy", s.getScreenPolicy)
			dashboard.With(s.requireScreenScope).Get("/screens/{id}/effective-policy", s.getEffectivePolicy)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope).Put("/screens/{id}/policy", s.putScreenPolicy)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope).Delete("/screens/{id}/policy", s.deleteScreenPolicy)
			dashboard.With(s.requireRoles("owner", "administrator")).Get("/system/status", s.systemStatus)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/system/maintenance/{action}", s.systemMaintenance)
			if s.backups != nil {
				dashboard.With(s.requireRoles("owner")).Get("/system/backups", s.listBackups)
				dashboard.With(s.requireRoles("owner"), s.requireCSRF).Post("/system/backups", s.createBackup)
				dashboard.With(s.requireRoles("owner")).Get("/system/backups/jobs/current", s.currentBackupJob)
				dashboard.With(s.requireRoles("owner")).Get("/system/backups/jobs/{id}", s.getBackupJob)
				dashboard.With(s.requireRoles("owner"), s.requireCSRF).Post("/system/backups/{id}/verify", s.verifyBackup)
				dashboard.With(s.requireRoles("owner")).Get("/system/backups/{id}/plan", s.restorePlan)
				dashboard.With(s.requireRoles("owner"), s.requireCSRF).Post("/system/backups/{id}/restore", s.restoreBackup)
				dashboard.With(s.requireRoles("owner")).Get("/system/backups/{id}/download", s.downloadBackup)
				dashboard.With(s.requireRoles("owner"), s.requireCSRF).Delete("/system/backups/{id}", s.deleteBackup)
			}
			dashboard.With(s.requireRoles("owner")).Get("/system/settings/export", s.exportSettings)
			dashboard.With(s.requireRoles("owner"), s.requireCSRF).Post("/system/settings/import/preview", s.previewSettingsImport)
			dashboard.With(s.requireRoles("owner"), s.requireCSRF).Post("/system/settings/import/apply", s.applySettingsImport)
			dashboard.Get("/takeovers", s.listTakeovers)
			if s.alerts != nil {
				dashboard.Get("/alerts/nws", s.alertSettings)
				dashboard.Get("/alerts/nws/zones", s.alertZones)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Put("/alerts/nws/monitor", s.updateAlertMonitor)
				dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF).Post("/alerts/nws/poll", s.pollAlerts)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/alerts/nws/rules", s.createAlertRule)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Put("/alerts/nws/rules/{id}", s.updateAlertRule)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/alerts/nws/rules/{id}", s.deleteAlertRule)
			}
			if s.snapshots != nil {
				// Scoped like every other per-screen route.
				dashboard.With(s.requireScreenScope).Get("/screens/{id}/snapshots", s.listScreenSnapshots)
				dashboard.With(s.requireScreenScope).Get("/screens/{id}/snapshots/{snapshotId}/image", s.getScreenSnapshotImage)
				dashboard.With(s.requireRoles("owner", "administrator")).Get("/system/snapshots/usage", s.snapshotUsage)
			}
			if s.approvals != nil {
				// Anyone who can author content can see where it stands.
				dashboard.With(s.requireRoles(contentAuthors...)).Get("/content-reviews", s.listContentReviews)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).
					Post("/content-reviews/{type}/{id}", s.decideContentReview)
				dashboard.With(s.requireRoles(contentAuthors...)).Get("/content-submissions", s.listContentSubmissions)
				dashboard.With(s.requireRoles(contentAuthors...)).Get("/content-submissions/{id}", s.getContentSubmission)
				dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/content-submissions/{type}/{id}", s.submitContent)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/content-submissions/{id}/approve", s.approveContentSubmission)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/content-submissions/{id}/request-changes", s.requestContentChanges)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/content-submissions/{id}/publish", s.publishContentSubmission)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/content-submissions/{id}/schedule", s.scheduleContentSubmission)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/content-submissions/{id}/cancel-schedule", s.cancelContentSchedule)
				dashboard.With(s.requireRoles(contentAuthors...)).Get("/content-history/{type}/{id}/publications", s.contentPublicationHistory)
				dashboard.With(s.requireRoles(contentAuthors...)).Get("/content-history/{type}/{id}/compare", s.comparePublications)
				dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/content-history/{type}/{id}/publications/{publicationId}/restore-draft", s.restorePublicationToDraft)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/content-history/{type}/{id}/publications/{publicationId}/rollback", s.rollbackPublication)
			}
			if s.integrations != nil {
				// Only an Owner mints or revokes a token: it is a standing
				// outbound-and-inbound capability, not a content change.
				dashboard.With(s.requireRoles("owner")).Get("/integration-tokens", s.listIntegrationTokens)
				dashboard.With(s.requireRoles("owner"), s.requireCSRF).Post("/integration-tokens", s.createIntegrationToken)
				dashboard.With(s.requireRoles("owner"), s.requireCSRF).Delete("/integration-tokens/{id}", s.revokeIntegrationToken)
			}
			if s.fleet != nil {
				// Preview is a read of what would change, so it needs no CSRF
				// token and no elevated role beyond seeing screens.
				dashboard.With(s.requireRoles("owner", "administrator")).Post("/screens/bulk/preview", s.previewBulkOperation)
				dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF).Post("/screens/bulk/apply", s.applyBulkOperation)
				dashboard.With(s.requireRoles("owner", "administrator")).Get("/screens/bulk/operations", s.listBulkOperations)
				dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF).Post("/screens/bulk/operations/{id}/undo", s.undoBulkOperation)
			}
			if s.contentHealthService != nil {
				dashboard.Get("/content-health", s.contentHealth)
			}
			if s.notifications != nil {
				// Any signed-in account can see whether email works and can
				// test its own address; only administrators configure where
				// notifications go, because a webhook is an outbound data path.
				dashboard.Get("/notifications/status", s.notificationStatus)
				dashboard.With(s.operationsRateLimit, s.requireCSRF).Post("/notifications/test", s.sendTestNotification)
				dashboard.With(s.requireRoles("owner", "administrator")).Get("/notifications/deliveries", s.listNotificationDeliveries)
				dashboard.With(s.requireRoles("owner", "administrator")).Get("/notifications/webhooks", s.listNotificationWebhooks)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/notifications/webhooks", s.createNotificationWebhook)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Put("/notifications/webhooks/{id}", s.updateNotificationWebhook)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/notifications/webhooks/{id}", s.deleteNotificationWebhook)
				dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF).Post("/notifications/webhooks/{id}/test", s.testNotificationWebhook)
			}
			dashboard.Get("/player-releases", s.listPlayerReleases)
			dashboard.With(s.requireRoles("owner"), s.operationsRateLimit, s.requireCSRF).Post("/player-releases/check", s.checkPlayerReleases)
			dashboard.With(s.requireRoles("owner"), s.operationsRateLimit, s.requireCSRF).Post("/player-releases/github/configuration", s.configureGitHubOAuth)
			dashboard.With(s.requireRoles("owner"), s.operationsRateLimit, s.requireCSRF).Post("/player-releases/github/device", s.startGitHubDeviceAuthorization)
			dashboard.With(s.requireRoles("owner"), s.requireCSRF).Post("/player-releases/github/device/poll", s.pollGitHubDeviceAuthorization)
			dashboard.With(s.requireRoles("owner"), s.requireCSRF).Delete("/player-releases/github", s.disconnectGitHub)
			dashboard.With(s.requireRoles("owner"), s.operationsRateLimit, s.requireCSRF, s.blockDuringBackup).Post("/player-releases/{id}/cache", s.cachePlayerRelease)
			dashboard.With(s.requireRoles("owner"), s.operationsRateLimit, s.requireCSRF, s.blockDuringBackup).Delete("/player-releases/{id}", s.deletePlayerRelease)
			dashboard.Get("/update-deployments", s.listUpdateDeployments)
			dashboard.Get("/update-deployments/{id}", s.getUpdateDeployment)
			dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF).Post("/update-deployments", s.createUpdateDeployment)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/update-deployments/{id}/cancel", s.cancelUpdateDeployment)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/update-deployments/{id}/screens/{screenId}/retry", s.retryUpdateScreen)
			dashboard.Get("/takeovers/{id}", s.getTakeover)
			dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF).Post("/takeovers", s.activateTakeover)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/takeovers/{id}/cancel", s.cancelTakeover)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/screen-groups", s.createScreenGroup)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Patch("/screen-groups/{id}", s.updateScreenGroup)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Put("/screen-groups/{id}/span", s.updateSpanGeometry)
			dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF).Post("/screen-groups/{id}/display-control", s.applyGroupDisplayControl)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/screen-groups/{id}", s.deleteScreenGroup)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/screen-groups/{id}/screens", s.addScreenGroupMember)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/screen-groups/{id}/screens/{screenId}", s.removeScreenGroupMember)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Put("/screen-groups/{id}/playlist-assignment", s.assignSyncGroupPlaylist)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/screen-groups/{id}/playlist-assignment", s.unassignSyncGroupPlaylist)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/schedules", s.createSchedule)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Patch("/schedules/{id}", s.updateSchedule)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Delete("/schedules/{id}", s.deleteSchedule)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/schedules/{id}/enable", s.enableSchedule)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/schedules/{id}/disable", s.disableSchedule)
			dashboard.With(s.requireRoles("owner", "administrator")).Post("/schedules/preview", s.previewSchedule)
			dashboard.Get("/assets", s.listAssets)
			dashboard.Get("/assets/{id}", s.getAsset)
			dashboard.Get("/assets/{id}/website/diagnostics", s.websiteDiagnostics)
			dashboard.Get("/assets/{id}/thumbnail", s.assetThumbnail)
			dashboard.Get("/assets/{id}/preview", s.assetPlaybackPreview)
			dashboard.Head("/assets/{id}/preview", s.assetPlaybackPreview)
			dashboard.Get("/content-folders", s.listContentFolders)
			dashboard.Get("/content-collections", s.listContentCollections)
			dashboard.Get("/content-tags", s.listContentTags)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/content-folders", s.createContentFolder)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Patch("/content-folders/{id}", s.updateContentFolder)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Delete("/content-folders/{id}", s.deleteContentFolder)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/content-collections", s.createContentCollection)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Patch("/content-collections/{id}", s.updateContentCollection)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Delete("/content-collections/{id}", s.deleteContentCollection)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/content-tags", s.createContentTag)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Patch("/content-tags/{id}", s.updateContentTag)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Delete("/content-tags/{id}", s.deleteContentTag)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/assets/bulk-organize", s.bulkOrganizeContent)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/assets/archive", s.archiveAssets)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/assets/restore", s.restoreAssets)
			dashboard.Get("/playlists", s.listPlaylists)
			dashboard.Get("/layouts", s.listLayouts)
			dashboard.Get("/layouts/{id}", s.getLayout)
			dashboard.Get("/layouts/{id}/preview-image", s.getLayoutPreviewImage)
			dashboard.Get("/playlists/{id}/revisions", s.listPlaylistRevisions)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).
				Post("/playlists/{id}/revisions/{revision}/restore", s.restorePlaylistRevision)
			dashboard.Get("/layouts/{id}/revisions", s.listLayoutRevisions)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/layouts", s.createLayout)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Patch("/layouts/{id}", s.updateLayout)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Put("/layouts/{id}/preview-image", s.updateLayoutPreviewImage)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Put("/layouts/{id}/draft", s.saveLayoutDraft)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/layouts/{id}/publish", s.publishLayout)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/layouts/{id}/duplicate", s.duplicateLayout)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/layouts/{id}/revisions/{revisionId}/restore", s.restoreLayoutRevision)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Delete("/layouts/{id}", s.deleteLayout)
			dashboard.Get("/playlists/{id}", s.getPlaylist)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/playlists", s.createPlaylist)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Patch("/playlists/{id}", s.updatePlaylist)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Delete("/playlists/{id}", s.deletePlaylist)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/playlists/{id}/duplicate", s.duplicatePlaylist)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/playlists/{id}/items", s.addPlaylistItem)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Put("/playlists/{id}/items/bulk", s.bulkUpdatePlaylistItems)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Patch("/playlists/{id}/items/{itemId}", s.updatePlaylistItem)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Delete("/playlists/{id}/items/{itemId}", s.deletePlaylistItem)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Put("/playlists/{id}/items/order", s.reorderPlaylistItems)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Put("/playlists/{id}/tag-rule", s.setPlaylistTagRule)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/playlists/{id}/publish", s.publishPlaylist)
			if s.campaigns != nil {
				dashboard.Get("/campaigns", s.listCampaigns)
				dashboard.Get("/campaigns/{id}", s.getCampaign)
				dashboard.Get("/campaigns/{id}/preflight", s.preflightCampaign)
				dashboard.Get("/campaigns/{id}/releases", s.listCampaignReleases)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/campaigns", s.createCampaign)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Patch("/campaigns/{id}/draft", s.updateCampaignDraft)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/campaigns/{id}/releases/{releaseId}/restore", s.restoreCampaignRelease)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/campaigns/{id}/publish", s.publishCampaign)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Delete("/campaigns/{id}", s.archiveCampaign)
			}
			dashboard.With(s.requireScreenScope).Get("/screens/{id}/playlist-assignment", s.getPlaylistAssignment)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope).Put("/screens/{id}/playlist-assignment", s.assignPlaylist)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope).Delete("/screens/{id}/playlist-assignment", s.unassignPlaylist)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Patch("/assets/{id}", s.updateAsset)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/assets/websites", s.createWebsite)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Patch("/assets/{id}/website", s.updateWebsite)
			// Widgets — renderable visual content.
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/widgets", s.createWidget)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/widgets/compile-preview", s.compileWidgetPreview)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Put("/widgets/{id}/preview-image", s.updateWidgetPreviewImage)
			dashboard.Get("/provider-catalog", s.providerCatalog)
			dashboard.Get("/content-definitions", s.contentDefinitions)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Patch("/widgets/{id}", s.updateWidget)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/widgets/{id}/duplicate", s.duplicateWidget)
			// Data Sources — reusable non-visual data connections.
			dashboard.Get("/data-sources", s.listDataSources)
			dashboard.Get("/data-sources/{id}", s.getDataSource)
			dashboard.Get("/data-sources/{id}/preview", s.previewSavedDataSource)
			dashboard.Get("/data-sources/{id}/diagnostics", s.dataSourceDiagnostics)
			dashboard.With(s.requireRoles(contentAuthors...), s.operationsRateLimit).Get("/data-sources/{id}/inspect", s.inspectSavedDataSource)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/data-sources", s.createDataSource)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Patch("/data-sources/{id}", s.updateDataSource)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF).Post("/data-sources/{id}/duplicate", s.duplicateDataSource)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Delete("/data-sources/{id}", s.deleteDataSource)
			dashboard.With(s.requireRoles(contentAuthors...), s.operationsRateLimit, s.requireCSRF).Post("/data-sources/{provider}/preview", s.previewDataSource)
			dashboard.With(s.requireRoles(contentAuthors...), s.operationsRateLimit, s.requireCSRF).Post("/data-sources/{provider}/inspect", s.inspectDataSource)
			// Form Data Sources. Reads are session-guarded and further authorized per-form inside
			// each handler (grants depend on the {id} path param); mutations add CSRF. Creating a
			// form requires the editor+ global role; the creator becomes its manager.
			if s.forms != nil {
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).Post("/forms", s.createForm)
				dashboard.Get("/forms", s.listForms)
				dashboard.Get("/data-sources/{id}/form", s.getForm)
				dashboard.With(s.requireCSRF).Patch("/data-sources/{id}/form", s.updateFormMetadata)
				dashboard.With(s.requireCSRF).Patch("/data-sources/{id}/form/draft", s.updateFormDraft)
				dashboard.With(s.requireCSRF).Post("/data-sources/{id}/form/publish", s.publishForm)
				dashboard.With(s.requireCSRF).Put("/data-sources/{id}/form/workflow", s.configureFormWorkflow)
				dashboard.Get("/data-sources/{id}/records", s.listFormRecords)
				dashboard.With(s.requireCSRF).Post("/data-sources/{id}/records", s.createFormRecord)
				dashboard.Get("/data-sources/{id}/records/{recordId}", s.getFormRecord)
				dashboard.With(s.requireCSRF).Patch("/data-sources/{id}/records/{recordId}", s.updateFormRecord)
				dashboard.With(s.requireCSRF).Delete("/data-sources/{id}/records/{recordId}", s.deleteFormRecord)
				dashboard.With(s.requireCSRF).Post("/data-sources/{id}/records/{recordId}/transitions", s.transitionFormRecord)
				dashboard.With(s.requireCSRF).Post("/data-sources/{id}/records/{recordId}/comments", s.addFormRecordComment)
				dashboard.With(s.requireCSRF).Post("/data-sources/{id}/records/{recordId}/attachments", s.uploadFormRecordAttachment)
				dashboard.Get("/data-sources/{id}/records/{recordId}/attachments/{attachmentId}/content", s.serveFormRecordAttachment)
				dashboard.With(s.requireCSRF).Delete("/data-sources/{id}/records/{recordId}/attachments/{attachmentId}", s.removeFormRecordAttachment)
				dashboard.Get("/data-sources/{id}/views", s.listFormViews)
				dashboard.With(s.requireCSRF).Put("/data-sources/{id}/views", s.upsertFormView)
				dashboard.With(s.requireCSRF).Post("/data-sources/{id}/views/preview", s.previewFormView)
				dashboard.With(s.requireCSRF).Delete("/data-sources/{id}/views/{viewId}", s.deleteFormView)
				dashboard.Get("/data-sources/{id}/outputs", s.getFormOutputs)
				dashboard.With(s.requireCSRF).Post("/data-sources/{id}/outputs/rebuild", s.rebuildFormOutputs)
				dashboard.Get("/data-sources/{id}/grants", s.listFormGrants)
				dashboard.With(s.requireCSRF).Put("/data-sources/{id}/grants", s.setFormGrant)
				dashboard.With(s.requireCSRF).Delete("/data-sources/{id}/grants/{grantId}", s.revokeFormGrant)
				dashboard.Get("/data-sources/{id}/access", s.listFormAccess)
				dashboard.With(s.requireCSRF).Put("/data-sources/{id}/access/{userId}", s.replaceFormGrants)
				dashboard.Get("/data-sources/{id}/user-directory", s.searchFormUsers)
				dashboard.Get("/approvals", s.listApprovals)
			}
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.blockDuringBackup).Delete("/assets/{id}", s.deleteAsset)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.blockDuringBackup).Post("/assets/{id}/retry", s.retryAsset)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.blockDuringBackup).Post("/uploads", s.createUpload)
			dashboard.Head("/uploads/{id}", s.headUpload)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.blockDuringBackup).Patch("/uploads/{id}", s.patchUpload)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.blockDuringBackup).Post("/uploads/{id}/complete", s.completeUpload)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.blockDuringBackup).Delete("/uploads/{id}", s.cancelUpload)
			dashboard.With(s.requireRoles("owner", "administrator")).Get("/system/media-diagnostics", s.mediaDiagnostics)
			dashboard.With(s.requireRoles("owner", "administrator")).Get("/screens/pairing/pending", s.listPendingPairings)
			dashboard.With(s.codeRateLimit).Post("/screens/pairing/resolve", s.resolvePairing)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/screens/pairing/{id}/approve", s.approvePairing)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF).Post("/screens/pairing/{id}/reject", s.rejectPairing)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope).Patch("/screens/{id}", s.updateScreen)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope).Post("/screens/{id}/disable", s.disableScreen)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope).Post("/screens/{id}/enable", s.enableScreen)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope).Post("/screens/{id}/revoke", s.revokeScreen)
			dashboard.With(s.requireScreenScope).Get("/screens/{id}/commands", s.listScreenCommands)
			dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF, s.requireScreenScope).Post("/screens/{id}/commands", s.createPlayerCommand)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope).Post("/screens/{id}/commands/{commandId}/cancel", s.cancelPlayerCommand)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope).Put("/screens/{id}/power-assist", s.confirmPowerAssist)
		})
	})
	r.Handle("/*", web.Handler())
	return r
}
