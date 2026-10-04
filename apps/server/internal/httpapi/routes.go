package httpapi

import (
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

func (s *server) routes() chi.Router {
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

		// Narrow built-in OAuth: authorization codes with PKCE for first-party
		// clients. The token endpoints are public and rate-limited; PKCE is
		// the client authentication. Approval stays inside the enrolled
		// dashboard session on the routes below.
		api.With(s.authRateLimit).Post("/oauth/token", s.oauthToken)
		api.With(s.authRateLimit).Post("/oauth/ios-session", s.oauthIOSSession)
		api.With(s.authRateLimit).Post("/oauth/revoke", s.oauthRevoke)

		// Security self-service sits outside the dashboard group because a
		// session waiting on enrollment must still be able to enroll.
		api.Group(func(security chi.Router) {
			security.Use(s.requireUser)
			security.With(s.requireSession).Get("/me/security", s.listFactors)
			security.With(s.requireCSRF, s.requireSession).Post("/me/security/totp", s.beginTOTPEnrollment)
			security.With(s.requireCSRF, s.requireSession).Post("/me/security/totp/confirm", s.confirmTOTPEnrollment)
			security.With(s.requireCSRF, s.requireSession).Post("/me/security/totp/remove", s.disableTOTP)
			security.With(s.requireCSRF, s.requireSession).Post("/me/security/recovery-codes", s.regenerateRecoveryCodes)
			security.With(s.requireCSRF, s.requireSession).Post("/me/security/passkeys/options", s.beginPasskeyRegistration)
			security.With(s.requireCSRF, s.requireSession).Post("/me/security/passkeys", s.finishPasskeyRegistration)
			security.With(s.requireCSRF, s.requireSession).Patch("/me/security/passkeys/{id}", s.renamePasskey)
			security.With(s.requireCSRF, s.requireSession).Post("/me/security/passkeys/{id}/remove", s.deletePasskey)
			security.With(s.requireScope("admin")).Get("/me/security/grants", s.listOAuthGrants)
			security.With(s.requireCSRF, s.requireScope("admin")).Delete("/me/security/grants/{id}", s.revokeOAuthGrant)
			security.With(s.requireScope("admin")).Get("/me/security/pats", s.listPATs)
			security.With(s.requireCSRF, s.requireScope("admin")).Post("/me/security/pats", s.createPAT)
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
			dashboard.Use(s.requireUser)
			dashboard.Use(s.requireEnrollment)
			dashboard.Use(s.withAuditContext)
			dashboard.With(s.operationsRateLimit, s.requireSession).Get("/oauth/authorize", s.oauthAuthorize)
			dashboard.With(s.operationsRateLimit, s.requireCSRF, s.requireSession).Post("/oauth/approve", s.oauthApprove)
			dashboard.With(s.operationsRateLimit, s.requireCSRF, s.requireSession).Post("/oauth/deny", s.oauthDeny)
			s.demoRoutes(dashboard)
			dashboard.With(s.requireScope("read")).Get("/screens", s.listScreens)
			dashboard.With(s.requireScope("read")).Get("/screens/archive", s.listArchivedScreens)
			dashboard.With(s.requireScreenScope, s.requireScope("read")).Get("/screens/{id}", s.getScreen)
			dashboard.With(s.requireScreenScope, s.requireScope("read")).Get("/screens/{id}/player-history", s.listScreenPlayerHistory)
			dashboard.With(s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Post("/screens/{id}/live-stream", s.startLiveStream)
			dashboard.With(s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Post("/screens/{id}/live-stream/{sessionId}/renew", s.renewLiveStream)
			dashboard.With(s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Delete("/screens/{id}/live-stream/{sessionId}", s.endLiveStream)
			dashboard.With(s.requireScreenScope, s.requireScope("read")).Get("/screens/{id}/live-stream/{sessionId}/mjpeg", s.watchLiveStream)
			dashboard.With(s.requireScreenScope, s.requireScope("read")).Get("/screens/{id}/reliability", s.screenReliability)
			// AirPlay Present is a temporary, high-priority external
			// presentation. Only screen managers can start/stop it; read access
			// is available to any enrolled dashboard session.
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/airplay/sessions", s.createAirplaySession)
			dashboard.With(s.requireScope("read")).Get("/airplay/sessions/{id}", s.getAirplaySession)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/airplay/sessions/{id}/stop", s.stopAirplaySession)
			// Presentation Networks are reusable organization Wi-Fi definitions a
			// Linux player joins temporarily for AirPlay. They are administrative
			// settings, so they carry the same Owner/Administrator + CSRF boundary as
			// every other settings and screen-assignment operation. Credentials are
			// write-only: no read here can produce a stored PSK or password.
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("read")).Get("/presentation-networks", s.listPresentationNetworks)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("read")).Get("/presentation-networks/{id}", s.getPresentationNetwork)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/presentation-networks", s.createPresentationNetwork)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Patch("/presentation-networks/{id}", s.updatePresentationNetwork)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Delete("/presentation-networks/{id}", s.deletePresentationNetwork)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Put("/presentation-networks/{id}/screens", s.replacePresentationNetworkAssignments)
			dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF, s.requireScope("write")).Post("/presentation-networks/{id}/test", s.testPresentationNetwork)
			dashboard.With(s.requireScreenScope, s.requireScope("read")).Get("/screens/{id}/presentation-network", s.getScreenPresentationNetwork)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Put("/screens/{id}/presentation-network", s.putScreenPresentationNetwork)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Delete("/screens/{id}/presentation-network", s.deleteScreenPresentationNetwork)
			dashboard.With(s.requireScope("read")).Get("/presentation-overrides", s.listPresentationOverrides)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/presentation-overrides", s.createPresentationOverride)
			dashboard.With(s.requirePresentationOverrideScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/presentation-overrides/{id}/stop", s.stopPresentationOverride)
			dashboard.With(s.requireScope("read")).Get("/locations", s.listLocations)
			dashboard.With(s.requireScope("read")).Get("/plugins", s.listPlugins)
			dashboard.With(s.requireScope("read")).Get("/plugins/dependency-graph", s.dependencyGraph)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Post("/plugins/{pluginId}/install", s.installPlugin)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Delete("/plugins/{pluginId}/installation", s.removePlugin)
			dashboard.With(s.requireScope("read")).Get("/plugins/{pluginId}/automation", s.getPluginAutomation)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/locations", s.createLocation)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Patch("/locations/{id}", s.updateLocation)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Delete("/locations/{id}", s.deleteLocation)
			dashboard.With(s.requireScope("read")).Get("/screen-groups", s.listScreenGroups)
			dashboard.With(s.requireGroupScope, s.requireScope("read")).Get("/screen-groups/{id}", s.getScreenGroup)
			dashboard.With(s.requireGroupScope, s.requireScope("read")).Get("/screen-groups/{id}/span", s.getSpanStatus)
			dashboard.With(s.requireGroupScope, s.requireRoles("owner", "administrator"), s.requireScope("read")).Get("/screen-groups/{id}/display-control/preview", s.previewGroupDisplayControl)
			dashboard.With(s.requireScope("read")).Get("/schedules", s.listSchedules)
			dashboard.With(s.requireScheduleScope, s.requireScope("read")).Get("/schedules/{id}", s.getSchedule)
			dashboard.With(s.requireScope("read")).Get("/settings", s.getSettings)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("admin")).Get("/users", s.listUsers)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Post("/users", s.createUser)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Patch("/users/{id}", s.updateUser)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Delete("/users/{id}", s.deleteUser)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Delete("/users/{id}/permanent", s.permanentlyDeleteUser)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Post("/users/{id}/security/reset", s.resetUserFactors)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("admin")).Get("/users/{id}/screen-scopes", s.getUserScreenScopes)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Put("/users/{id}/screen-scopes", s.putUserScreenScopes)
			dashboard.With(s.requireScope("read")).Get("/me/preferences", s.getPreferences)
			dashboard.With(s.requireCSRF, s.requireScope("write")).Patch("/me/preferences", s.updatePreferences)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Patch("/settings", s.updateSettings)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Post("/settings/reset", s.resetSettings)
			dashboard.With(s.requireGroupScope, s.requireScope("read")).Get("/screen-groups/{id}/policy", s.getGroupPolicy)
			dashboard.With(s.requireGroupScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Put("/screen-groups/{id}/policy", s.putGroupPolicy)
			dashboard.With(s.requireGroupScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Delete("/screen-groups/{id}/policy", s.deleteGroupPolicy)
			dashboard.With(s.requireScreenScope, s.requireScope("read")).Get("/screens/{id}/policy", s.getScreenPolicy)
			dashboard.With(s.requireScreenScope, s.requireScope("read")).Get("/screens/{id}/effective-policy", s.getEffectivePolicy)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Put("/screens/{id}/policy", s.putScreenPolicy)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Delete("/screens/{id}/policy", s.deleteScreenPolicy)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("read")).Get("/system/status", s.systemStatus)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Post("/system/maintenance/{action}", s.systemMaintenance)
			if s.backups != nil {
				dashboard.With(s.requireRoles("owner"), s.requireScope("admin")).Get("/system/backups", s.listBackups)
				dashboard.With(s.requireRoles("owner"), s.requireCSRF, s.requireScope("admin")).Post("/system/backups", s.createBackup)
				dashboard.With(s.requireRoles("owner"), s.requireScope("admin")).Get("/system/backups/jobs/current", s.currentBackupJob)
				dashboard.With(s.requireRoles("owner"), s.requireScope("admin")).Get("/system/backups/jobs/{id}", s.getBackupJob)
				dashboard.With(s.requireRoles("owner"), s.requireCSRF, s.requireScope("admin")).Post("/system/backups/{id}/verify", s.verifyBackup)
				dashboard.With(s.requireRoles("owner"), s.requireScope("admin")).Get("/system/backups/{id}/plan", s.restorePlan)
				dashboard.With(s.requireRoles("owner"), s.requireCSRF, s.requireScope("admin")).Post("/system/backups/{id}/restore", s.restoreBackup)
				dashboard.With(s.requireRoles("owner"), s.requireScope("admin")).Get("/system/backups/{id}/download", s.downloadBackup)
				dashboard.With(s.requireRoles("owner"), s.requireCSRF, s.requireScope("write")).Delete("/system/backups/{id}", s.deleteBackup)
			}
			dashboard.With(s.requireRoles("owner"), s.requireScope("admin")).Get("/system/settings/export", s.exportSettings)
			dashboard.With(s.requireRoles("owner"), s.requireCSRF, s.requireScope("admin")).Post("/system/settings/import/preview", s.previewSettingsImport)
			dashboard.With(s.requireRoles("owner"), s.requireCSRF, s.requireScope("admin")).Post("/system/settings/import/apply", s.applySettingsImport)
			dashboard.With(s.requireScope("read")).Get("/takeovers", s.listTakeovers)
			if s.snapshots != nil {
				// Scoped like every other per-screen route.
				dashboard.With(s.requireScreenScope, s.requireScope("read")).Get("/screens/{id}/snapshots", s.listScreenSnapshots)
				dashboard.With(s.requireScreenScope, s.requireScope("read")).Get("/screens/{id}/snapshots/{snapshotId}/image", s.getScreenSnapshotImage)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("read")).Get("/system/snapshots/usage", s.snapshotUsage)
			}
			if s.approvals != nil {
				// Anyone who can author content can see where it stands.
				dashboard.With(s.requireRoles(contentAuthors...), s.requireScope("read")).Get("/content-reviews", s.listContentReviews)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).
					Post("/content-reviews/{type}/{id}", s.decideContentReview)
				dashboard.With(s.requireRoles(contentAuthors...), s.requireScope("read")).Get("/content-submissions", s.listContentSubmissions)
				dashboard.With(s.requireRoles(contentAuthors...), s.requireScope("read")).Get("/content-submissions/{id}", s.getContentSubmission)
				dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/content-submissions/{type}/{id}", s.submitContent)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/content-submissions/{id}/approve", s.approveContentSubmission)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/content-submissions/{id}/request-changes", s.requestContentChanges)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/content-submissions/{id}/publish", s.publishContentSubmission)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/content-submissions/{id}/schedule", s.scheduleContentSubmission)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/content-submissions/{id}/cancel-schedule", s.cancelContentSchedule)
				dashboard.With(s.requireRoles(contentAuthors...), s.requireScope("read")).Get("/content-history/{type}/{id}/publications", s.contentPublicationHistory)
				dashboard.With(s.requireRoles(contentAuthors...), s.requireScope("read")).Get("/content-history/{type}/{id}/compare", s.comparePublications)
				dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/content-history/{type}/{id}/publications/{publicationId}/restore-draft", s.restorePublicationToDraft)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/content-history/{type}/{id}/publications/{publicationId}/rollback", s.rollbackPublication)
			}
			if s.integrations != nil {
				// Only an Owner mints or revokes a token: it is a standing
				// outbound-and-inbound capability, not a content change.
				dashboard.With(s.requireRoles("owner"), s.requireScope("admin")).Get("/integration-tokens", s.listIntegrationTokens)
				dashboard.With(s.requireRoles("owner"), s.requireCSRF, s.requireScope("admin")).Post("/integration-tokens", s.createIntegrationToken)
				dashboard.With(s.requireRoles("owner"), s.requireCSRF, s.requireScope("admin")).Delete("/integration-tokens/{id}", s.revokeIntegrationToken)
			}
			if s.fleet != nil {
				// Preview is a read of what would change, so it needs no CSRF
				// token and no elevated role beyond seeing screens.
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("write")).Post("/screens/bulk/preview", s.previewBulkOperation)
				dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF, s.requireScope("write")).Post("/screens/bulk/apply", s.applyBulkOperation)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("read")).Get("/screens/bulk/operations", s.listBulkOperations)
				dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF, s.requireScope("write")).Post("/screens/bulk/operations/{id}/undo", s.undoBulkOperation)
			}
			if s.contentHealthService != nil {
				dashboard.With(s.requireScope("read")).Get("/content-health", s.contentHealth)
			}
			if s.notifications != nil {
				// Any signed-in account can see whether email works and can
				// test its own address; only administrators configure where
				// notifications go, because a webhook is an outbound data path.
				dashboard.With(s.requireScope("read")).Get("/notifications/status", s.notificationStatus)
				dashboard.With(s.operationsRateLimit, s.requireCSRF, s.requireScope("write")).Post("/notifications/test", s.sendTestNotification)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("admin")).Get("/notifications/deliveries", s.listNotificationDeliveries)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("admin")).Get("/notifications/webhooks", s.listNotificationWebhooks)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Post("/notifications/webhooks", s.createNotificationWebhook)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Put("/notifications/webhooks/{id}", s.updateNotificationWebhook)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Delete("/notifications/webhooks/{id}", s.deleteNotificationWebhook)
				dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF, s.requireScope("admin")).Post("/notifications/webhooks/{id}/test", s.testNotificationWebhook)
			}
			dashboard.With(s.requireScope("read")).Get("/player-releases", s.listPlayerReleases)
			dashboard.With(s.requireRoles("owner"), s.operationsRateLimit, s.requireCSRF, s.requireScope("write")).Post("/player-releases/check", s.checkPlayerReleases)
			dashboard.With(s.requireRoles("owner"), s.operationsRateLimit, s.requireCSRF, s.requireScope("admin")).Post("/player-releases/github/configuration", s.configureGitHubOAuth)
			dashboard.With(s.requireRoles("owner"), s.operationsRateLimit, s.requireCSRF, s.requireScope("write")).Post("/player-releases/github/device", s.startGitHubDeviceAuthorization)
			dashboard.With(s.requireRoles("owner"), s.requireCSRF, s.requireScope("write")).Post("/player-releases/github/device/poll", s.pollGitHubDeviceAuthorization)
			dashboard.With(s.requireRoles("owner"), s.requireCSRF, s.requireScope("admin")).Delete("/player-releases/github", s.disconnectGitHub)
			dashboard.With(s.requireRoles("owner"), s.operationsRateLimit, s.requireCSRF, s.blockDuringBackup, s.requireScope("admin")).Post("/player-releases/{id}/cache", s.cachePlayerRelease)
			dashboard.With(s.requireRoles("owner"), s.operationsRateLimit, s.requireCSRF, s.blockDuringBackup, s.requireScope("admin")).Delete("/player-releases/{id}", s.deletePlayerRelease)
			dashboard.With(s.requireScope("read")).Get("/update-deployments", s.listUpdateDeployments)
			dashboard.With(s.requireScope("read")).Get("/update-deployments/{id}", s.getUpdateDeployment)
			dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF, s.requireScope("write")).Post("/update-deployments", s.createUpdateDeployment)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/update-deployments/{id}/cancel", s.cancelUpdateDeployment)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/update-deployments/{id}/screens/{screenId}/retry", s.retryUpdateScreen)
			dashboard.With(s.requireTakeoverScope, s.requireScope("read")).Get("/takeovers/{id}", s.getTakeover)
			dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF, s.requireScope("write")).Post("/takeovers", s.activateTakeover)
			dashboard.With(s.requireTakeoverScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/takeovers/{id}/cancel", s.cancelTakeover)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/screen-groups", s.createScreenGroup)
			dashboard.With(s.requireGroupScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Patch("/screen-groups/{id}", s.updateScreenGroup)
			dashboard.With(s.requireGroupScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Put("/screen-groups/{id}/span", s.updateSpanGeometry)
			dashboard.With(s.requireGroupScope, s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF, s.requireScope("write")).Post("/screen-groups/{id}/display-control", s.applyGroupDisplayControl)
			dashboard.With(s.requireGroupScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Delete("/screen-groups/{id}", s.deleteScreenGroup)
			dashboard.With(s.requireGroupScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/screen-groups/{id}/screens", s.addScreenGroupMember)
			dashboard.With(s.requireGroupScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Delete("/screen-groups/{id}/screens/{screenId}", s.removeScreenGroupMember)
			dashboard.With(s.requireGroupScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Put("/screen-groups/{id}/playlist-assignment", s.assignSyncGroupPlaylist)
			dashboard.With(s.requireGroupScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Delete("/screen-groups/{id}/playlist-assignment", s.unassignSyncGroupPlaylist)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/schedules", s.createSchedule)
			dashboard.With(s.requireScheduleScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Patch("/schedules/{id}", s.updateSchedule)
			dashboard.With(s.requireScheduleScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Delete("/schedules/{id}", s.deleteSchedule)
			dashboard.With(s.requireScheduleScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/schedules/{id}/enable", s.enableSchedule)
			dashboard.With(s.requireScheduleScope, s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/schedules/{id}/disable", s.disableSchedule)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("write")).Post("/schedules/preview", s.previewSchedule)
			dashboard.With(s.requireScope("read")).Get("/assets", s.listAssets)
			dashboard.With(s.requireScope("read")).Get("/assets/{id}", s.getAsset)
			dashboard.With(s.requireScope("read")).Get("/assets/{id}/website/diagnostics", s.websiteDiagnostics)
			dashboard.With(s.requireScope("read")).Get("/assets/{id}/thumbnail", s.assetThumbnail)
			dashboard.With(s.requireScope("read")).Get("/assets/{id}/preview", s.assetPlaybackPreview)
			dashboard.With(s.requireScope("read")).Head("/assets/{id}/preview", s.assetPlaybackPreview)
			dashboard.With(s.requireScope("read")).Get("/content-folders", s.listContentFolders)
			dashboard.With(s.requireScope("read")).Get("/content-collections", s.listContentCollections)
			dashboard.With(s.requireScope("read")).Get("/content-tags", s.listContentTags)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/content-folders", s.createContentFolder)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Patch("/content-folders/{id}", s.updateContentFolder)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Delete("/content-folders/{id}", s.deleteContentFolder)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/content-collections", s.createContentCollection)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Patch("/content-collections/{id}", s.updateContentCollection)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Delete("/content-collections/{id}", s.deleteContentCollection)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/content-tags", s.createContentTag)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Patch("/content-tags/{id}", s.updateContentTag)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Delete("/content-tags/{id}", s.deleteContentTag)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/assets/bulk-organize", s.bulkOrganizeContent)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/assets/archive", s.archiveAssets)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/assets/restore", s.restoreAssets)
			dashboard.With(s.requireScope("read")).Get("/playlists", s.listPlaylists)
			dashboard.With(s.requireScope("read")).Get("/layouts", s.listLayouts)
			dashboard.With(s.requireScope("read")).Get("/layouts/{id}", s.getLayout)
			dashboard.With(s.requireScope("read")).Get("/layouts/{id}/preview-image", s.getLayoutPreviewImage)
			dashboard.With(s.requireScope("read")).Get("/playlists/{id}/revisions", s.listPlaylistRevisions)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF).
				Post("/playlists/{id}/revisions/{revision}/restore", s.restorePlaylistRevision)
			dashboard.With(s.requireScope("read")).Get("/layouts/{id}/revisions", s.listLayoutRevisions)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/layouts", s.createLayout)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Patch("/layouts/{id}", s.updateLayout)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Put("/layouts/{id}/preview-image", s.updateLayoutPreviewImage)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Put("/layouts/{id}/draft", s.saveLayoutDraft)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/layouts/{id}/publish", s.publishLayout)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/layouts/{id}/duplicate", s.duplicateLayout)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/layouts/{id}/revisions/{revisionId}/restore", s.restoreLayoutRevision)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Delete("/layouts/{id}", s.deleteLayout)
			dashboard.With(s.requireScope("read")).Get("/playlists/{id}", s.getPlaylist)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/playlists", s.createPlaylist)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Patch("/playlists/{id}", s.updatePlaylist)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Delete("/playlists/{id}", s.deletePlaylist)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/playlists/{id}/duplicate", s.duplicatePlaylist)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/playlists/{id}/items", s.addPlaylistItem)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Put("/playlists/{id}/items/bulk", s.bulkUpdatePlaylistItems)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Patch("/playlists/{id}/items/{itemId}", s.updatePlaylistItem)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Delete("/playlists/{id}/items/{itemId}", s.deletePlaylistItem)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Put("/playlists/{id}/items/order", s.reorderPlaylistItems)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Put("/playlists/{id}/tag-rule", s.setPlaylistTagRule)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/playlists/{id}/publish", s.publishPlaylist)
			if s.campaigns != nil {
				dashboard.With(s.requireScope("read")).Get("/campaigns", s.listCampaigns)
				dashboard.With(s.requireScope("read")).Get("/campaigns/{id}", s.getCampaign)
				dashboard.With(s.requireScope("read")).Get("/campaigns/{id}/preflight", s.preflightCampaign)
				dashboard.With(s.requireScope("read")).Get("/campaigns/{id}/releases", s.listCampaignReleases)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/campaigns", s.createCampaign)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Patch("/campaigns/{id}/draft", s.updateCampaignDraft)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Post("/campaigns/{id}/releases/{releaseId}/restore", s.restoreCampaignRelease)
				dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("write")).Post("/campaigns/{id}/publish", s.publishCampaign)
				dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Delete("/campaigns/{id}", s.archiveCampaign)
			}
			dashboard.With(s.requireScreenScope, s.requireScope("read")).Get("/screens/{id}/playlist-assignment", s.getPlaylistAssignment)
			dashboard.With(s.requireScreenScope, s.requireScope("read")).Get("/screens/{id}/playback-plan", s.getPlaybackPlan)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Put("/screens/{id}/playlist-assignment", s.assignPlaylist)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Delete("/screens/{id}/playlist-assignment", s.unassignPlaylist)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Patch("/assets/{id}", s.updateAsset)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/assets/websites", s.createWebsite)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Patch("/assets/{id}/website", s.updateWebsite)
			// Widgets — renderable visual content.
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/widgets", s.createWidget)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/widgets/compile-preview", s.compileWidgetPreview)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Put("/widgets/{id}/preview-image", s.updateWidgetPreviewImage)
			dashboard.With(s.requireScope("read")).Get("/provider-catalog", s.providerCatalog)
			dashboard.With(s.requireScope("read")).Get("/content-definitions", s.contentDefinitions)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Patch("/widgets/{id}", s.updateWidget)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/widgets/{id}/duplicate", s.duplicateWidget)
			// Data Sources — reusable non-visual data connections.
			dashboard.With(s.requireScope("read")).Get("/data-sources", s.listDataSources)
			dashboard.With(s.requireScope("read")).Get("/data-sources/{id}", s.getDataSource)
			dashboard.With(s.requireScope("read")).Get("/data-sources/{id}/preview", s.previewSavedDataSource)
			dashboard.With(s.requireScope("read")).Get("/data-sources/{id}/diagnostics", s.dataSourceDiagnostics)
			dashboard.With(s.requireRoles(contentAuthors...), s.operationsRateLimit, s.requireScope("read")).Get("/data-sources/{id}/inspect", s.inspectSavedDataSource)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/data-sources", s.createDataSource)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Patch("/data-sources/{id}", s.updateDataSource)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.requireScope("write")).Post("/data-sources/{id}/duplicate", s.duplicateDataSource)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.requireScope("write")).Delete("/data-sources/{id}", s.deleteDataSource)
			dashboard.With(s.requireRoles(contentAuthors...), s.operationsRateLimit, s.requireCSRF, s.requireScope("write")).Post("/data-sources/{provider}/preview", s.previewDataSource)
			dashboard.With(s.requireRoles(contentAuthors...), s.operationsRateLimit, s.requireCSRF, s.requireScope("write")).Post("/data-sources/{provider}/inspect", s.inspectDataSource)
			dashboard.With(s.requireRoles(contentManagers...), s.requireCSRF, s.blockDuringBackup, s.requireScope("write")).Delete("/assets/{id}", s.deleteAsset)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.blockDuringBackup, s.requireScope("write")).Post("/assets/{id}/retry", s.retryAsset)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.blockDuringBackup, s.requireScope("write")).Post("/uploads", s.createUpload)
			dashboard.With(s.requireScope("read")).Head("/uploads/{id}", s.headUpload)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.blockDuringBackup, s.requireScope("write")).Patch("/uploads/{id}", s.patchUpload)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.blockDuringBackup, s.requireScope("write")).Post("/uploads/{id}/complete", s.completeUpload)
			dashboard.With(s.requireRoles(contentAuthors...), s.requireCSRF, s.blockDuringBackup, s.requireScope("write")).Delete("/uploads/{id}", s.cancelUpload)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("read")).Get("/system/media-diagnostics", s.mediaDiagnostics)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireScope("read")).Get("/screens/pairing/pending", s.listPendingPairings)
			dashboard.With(s.codeRateLimit, s.requireScope("write")).Post("/screens/pairing/resolve", s.resolvePairing)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Post("/screens/pairing/{id}/approve", s.approvePairing)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScope("admin")).Post("/screens/pairing/{id}/reject", s.rejectPairing)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Patch("/screens/{id}", s.updateScreen)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Post("/screens/{id}/disable", s.disableScreen)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Post("/screens/{id}/enable", s.enableScreen)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope, s.requireScope("admin")).Post("/screens/{id}/revoke", s.revokeScreen)
			dashboard.With(s.requireScreenScope, s.requireScope("read")).Get("/screens/{id}/commands", s.listScreenCommands)
			dashboard.With(s.requireRoles("owner", "administrator"), s.operationsRateLimit, s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Post("/screens/{id}/commands", s.createPlayerCommand)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Post("/screens/{id}/commands/{commandId}/cancel", s.cancelPlayerCommand)
			dashboard.With(s.requireRoles("owner", "administrator"), s.requireCSRF, s.requireScreenScope, s.requireScope("write")).Put("/screens/{id}/power-assist", s.confirmPowerAssist)
		})
		// Plugin routes come last so every one of them can be checked against
		// the core routes already registered above.
		s.mountPluginRoutes(api)
	})
	r.Handle("/*", web.Handler())
	return r
}
