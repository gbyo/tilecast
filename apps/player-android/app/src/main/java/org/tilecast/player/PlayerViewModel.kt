package org.tilecast.player

import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.tilecast.player.content.UpdateUiState
import org.tilecast.player.core.CoreHostState
import org.tilecast.player.core.CorePlatformConfig
import org.tilecast.player.core.CorePlayerConfig
import org.tilecast.player.core.DiscoveredServer
import org.tilecast.player.core.PlayerCoreHost
import org.tilecast.player.core.PlayerState
import org.tilecast.player.core.SetupPhase
import org.tilecast.player.core.ServerUrlPolicy
import org.tilecast.player.core.mapPlayerState
import org.tilecast.player.network.LanDiscovery
import org.tilecast.player.network.ServerIdentity
import org.tilecast.player.reliability.BootRecovery
import org.tilecast.player.reliability.CommissioningController
import org.tilecast.player.reliability.CommissioningStatus
import org.tilecast.player.reliability.ManagedKioskCapability
import org.tilecast.player.reliability.ReliabilityController
import org.tilecast.player.security.CredentialStore
import org.tilecast.player.security.MigratingCredentialStore
import java.time.Instant

/**
 * The production Player UI state. Core owns pairing, content, presence,
 * and recovery; this ViewModel owns what Android must do itself: the
 * setup flow (discovery plus a credential-free identity check), the
 * Core state projection the screens render, platform configuration
 * effects, commissioning, updates, OS power effects, and the platform
 * observations Core merges into its heartbeat.
 */
class PlayerViewModel(application: Application) : AndroidViewModel(application) {
    private val host = PlayerCoreHost.get(application)
    private val discovery = LanDiscovery(application)
    private val reliability = ReliabilityController(application)
    private val commissioningController = CommissioningController(application, reliability)
    private val credentials: CredentialStore = MigratingCredentialStore.forProduction(application)
    private val prefs = application.getSharedPreferences("tilecast-reliability", Context.MODE_PRIVATE)
    private val updates = host.updateManager

    private val mutableSetup = MutableStateFlow<SetupPhase>(SetupPhase.Boot)
    private var beginUrl: String? = null
    private val mutableState = MutableStateFlow<PlayerState>(PlayerState.Unconfigured)
    val state: StateFlow<PlayerState> = mutableState.asStateFlow()

    private val mutablePlatform = MutableStateFlow<CorePlatformConfig?>(null)
    /** The accepted platform configuration, for the window, kiosk, and power effects. */
    val playerConfig: StateFlow<CorePlatformConfig?> = mutablePlatform.asStateFlow()
    private var appliedConfigRevision: Long? = null

    private val mutableActiveHours = MutableStateFlow(true)
    val activeHours: StateFlow<Boolean> = mutableActiveHours.asStateFlow()
    private val mutableTakeoverActive = MutableStateFlow(false)
    val takeoverActive: StateFlow<Boolean> = mutableTakeoverActive.asStateFlow()
    private val mutableRuntimeSupported = MutableStateFlow(true)
    /** False when the installed WebView cannot host the runtime bridge at all. */
    val runtimeSupported: StateFlow<Boolean> = mutableRuntimeSupported.asStateFlow()

    private val mutableCommissioning = MutableStateFlow(CommissioningStatus())
    val commissioning: StateFlow<CommissioningStatus> = mutableCommissioning.asStateFlow()

    private val mutableSafeMode = MutableStateFlow(reliability.isSafeMode())
    /** The crash-loop latch, set at boot before this model exists. */
    val safeMode: StateFlow<Boolean> = mutableSafeMode.asStateFlow()

    private val mutableUpdate = MutableStateFlow<UpdateUiState?>(null)
    val update: StateFlow<UpdateUiState?> = mutableUpdate.asStateFlow()
    private val updateListener: (UpdateUiState) -> Unit = { viewModelScope.launch { mutableUpdate.value = it } }

    private var discoverJob: Job? = null
    private var validateJob: Job? = null
    private var pairingJob: Job? = null

    init {
        mutableUpdate.value = updates?.restored
        updates?.addListener(updateListener)
        viewModelScope.launch { host.startDrivers() }
        viewModelScope.launch {
            combine(host.state, host.pairingState, mutableSetup) { core, pairing, setup ->
                Triple(core, pairing, setup)
            }.collect { (core, pairing, setup) ->
                mutableState.value = mapPlayerState(core, pairing, setup, beginUrl)
                val status = (core as? CoreHostState.Ready)?.status
                mutableActiveHours.value = status?.activeHoursState != "off_hours"
                mutableTakeoverActive.value = status?.takeoverActive == true
                applyPowerEffects()
                if (status?.configRevision != appliedConfigRevision) refreshPlatformConfig(status?.configRevision)
                refreshCommissioning(status?.screenId, status?.cachedFallbackAvailable == true)
            }
        }
        viewModelScope.launch {
            while (true) {
                delay(10_000)
                runCatching { host.refreshStatus() }
            }
        }
        viewModelScope.launch {
            while (true) {
                delay(60_000)
                reportPlatformObservations()
            }
        }
        discover()
    }

    override fun onCleared() {
        updates?.removeListener(updateListener)
        super.onCleared()
    }

    // Setup: discovery and validation stay in Kotlin; pairing is Core's.

    /** Starts Core when needed and lists nearby servers, then projects the result. */
    fun discover() {
        discoverJob?.cancel()
        discoverJob = viewModelScope.launch {
            runCatching { host.startDrivers() }
            mutableSetup.value = SetupPhase.Discovering
            val found = linkedMapOf<String, DiscoveredServer>()
            withTimeoutOrNull(5_000) { discovery.discover().catch { }.collect { found[it.baseUrl] = it } }
            if (mutableSetup.value == SetupPhase.Discovering) mutableSetup.value = SetupPhase.Browsing(found.values.toList())
        }
    }

    fun showManualEntry() {
        mutableSetup.value = SetupPhase.Manual()
    }

    fun validateServer(value: String) {
        validateJob?.cancel()
        validateJob = viewModelScope.launch {
            val normalized = ServerUrlPolicy.normalize(value).getOrElse {
                mutableSetup.value = SetupPhase.Manual(it.message ?: "Invalid server address")
                return@launch
            }
            mutableSetup.value = SetupPhase.Validating(normalized.value)
            val identity = runCatching { host.fetchIdentity(normalized.value) }.getOrNull()
            if (identity == null || !identity.ok) {
                mutableSetup.value = SetupPhase.Manual("Could not connect to Tilecast")
                return@launch
            }
            if (identity.product != "tilecast" || identity.apiVersion != "v1") {
                mutableSetup.value = SetupPhase.Manual("This address is not a compatible Tilecast server")
                return@launch
            }
            mutableSetup.value = SetupPhase.Confirm(
                normalized,
                ServerIdentity(
                    identity.product ?: "tilecast",
                    identity.installationId ?: "",
                    identity.organizationName ?: "",
                    identity.apiVersion ?: "v1",
                    identity.pairingEnabled,
                ),
            )
        }
    }

    fun chooseServer(server: DiscoveredServer) = validateServer(server.baseUrl)

    fun requestPairing() {
        pairingJob?.cancel()
        pairingJob = viewModelScope.launch {
            val confirm = mutableSetup.value as? SetupPhase.Confirm ?: return@launch
            mutableSetup.value = SetupPhase.Requesting
            val result = runCatching { host.beginPairing(confirm.serverUrl.value) }.getOrNull()
            if (result?.ok == true) {
                beginUrl = confirm.serverUrl.value
                return@launch
            }
            // Already paired means Core holds a binding: the paired
            // projection takes over on the next status refresh.
            if (result?.code == "already_paired") {
                runCatching { host.refreshStatus() }
                return@launch
            }
            mutableSetup.value = when (result?.code) {
                "pairing_disabled" -> SetupPhase.Failed("Pairing is disabled on this server")
                else -> SetupPhase.Failed("Pairing request failed")
            }
        }
    }

    fun cancelPairing() {
        viewModelScope.launch {
            runCatching { host.resetPairing() }
            beginUrl = null
            discover()
        }
    }

    fun reconnectAfterRevocation() {
        viewModelScope.launch {
            runCatching { host.resetPairing() }
            beginUrl = null
            discover()
        }
    }

    /** Forgets the server connection entirely. The Activity clears renderer website data around this. */
    fun resetServer() {
        viewModelScope.launch {
            runCatching { host.resetServer() }
            beginUrl = null
            appliedConfigRevision = null
            mutablePlatform.value = null
            discover()
        }
    }

    // Renderer and clock callbacks from the Activity.

    /** A proven capability may unlock staged content, as the legacy probe pass reconciled. */
    fun onCapabilitiesChanged() {
        viewModelScope.launch {
            runCatching { host.syncManifest() }
            runCatching { host.refreshStatus() }
        }
    }

    /** The installed WebView cannot host the runtime bridge: show the native fallback screen. */
    fun onRendererUnsupported() {
        mutableRuntimeSupported.value = false
    }

    /** A clock or timezone jump re-resolves the committed selection. */
    fun onClockChanged() {
        viewModelScope.launch {
            runCatching { host.syncManifest() }
            runCatching { host.refreshStatus() }
        }
    }

    /** Maintenance clears safe mode in Core and in the local latch together. */
    fun clearSafeMode() {
        viewModelScope.launch {
            runCatching { host.rendererRecovery("""{"op":"clear_safe_mode"}""") }
            reliability.setSafeMode(false)
            mutableSafeMode.value = false
            runCatching { host.refreshStatus() }
        }
    }

    /** The Activity reports foreground transitions for presence and power policy. */
    fun onForegroundChanged(foreground: Boolean) {
        prefs.edit().putBoolean("foreground", foreground).apply {
            if (!foreground) putLong("last-foreground-exit", System.currentTimeMillis())
        }.apply()
        reportPlatformObservations()
    }

    // Platform configuration: effects for what Android owns.

    private suspend fun refreshPlatformConfig(revision: Long?) {
        val config = runCatching { host.effectiveConfig() }.getOrNull() ?: CorePlayerConfig(null)
        appliedConfigRevision = revision
        mutablePlatform.value = config.platform
        applyPlatformPolicy(config)
        reportPlatformObservations()
    }

    /** Writes the policy prefs the OS integration reads: boot, kiosk return, and foreground reporting. */
    private fun applyPlatformPolicy(config: CorePlayerConfig) {
        val platform = config.platform
        prefs.edit()
            .putBoolean("launch-after-boot", platform.reliability.launchAfterBoot)
            .putBoolean("accessibility-enabled-by-policy", platform.accessibility.controlAssistEnabled)
            .putBoolean("report-foreground-package", platform.accessibility.reportForegroundPackage)
            .putBoolean("pause-accessibility-during-updates", platform.accessibility.pauseDuringUpdates)
            .putBoolean("pause-accessibility-during-admin", platform.accessibility.pauseDuringAdminSession)
            .putInt("return-delay", platform.accessibility.returnDelaySeconds.toInt())
            .putInt("maximum-returns", platform.accessibility.maximumReturns.toInt())
            .putInt("return-window", platform.accessibility.returnWindowMinutes.toInt())
            .putStringSet("allowed-packages", platform.accessibility.allowedPackages.toSet())
            .apply()
    }

    /**
     * OS power effects for the hours state Core reports. Core owns the
     * off-hours gate; Android owns sleep, wake, and the pre-opening wake.
     * Edges only: a steady state never re-requests.
     */
    private var lastPowerActive: Boolean? = null

    private fun applyPowerEffects() {
        val active = mutableActiveHours.value
        if (active == lastPowerActive) return
        lastPowerActive = active
        val platform = mutablePlatform.value ?: return
        if (active) {
            reliability.requestWake()
            return
        }
        if (platform.power.sleepOutsideActiveHours && !mutableTakeoverActive.value) reliability.requestSleep()
        val transition = (host.state.value as? CoreHostState.Ready)?.status?.nextTransitionAt
            ?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return
        reliability.scheduleWake(transition.minusSeconds(platform.power.startupGraceSeconds))
    }

    // Commissioning: local setup readiness, unchanged in shape.

    fun refreshCommissioning() {
        val status = (host.state.value as? CoreHostState.Ready)?.status
        refreshCommissioning(status?.screenId, status?.cachedFallbackAvailable == true)
    }

    private fun refreshCommissioning(screenId: String?, cachedFallbackAvailable: Boolean) {
        mutableCommissioning.value = commissioningController.status(screenId, cachedFallbackAvailable)
    }

    fun setCommissioningPin(pin: CharArray) {
        commissioningController.setPin(pin)
        refreshCommissioning()
    }

    fun advanceCommissioning() {
        val screen = (host.state.value as? CoreHostState.Ready)?.status?.screenId ?: return
        commissioningController.advance(screen, mutableCommissioning.value.step)
        refreshCommissioning()
    }

    fun completeCommissioning() {
        viewModelScope.launch {
            val screen = (host.state.value as? CoreHostState.Ready)?.status?.screenId ?: return@launch
            commissioningController.complete(screen)
            refreshCommissioning()
            reportPlatformObservations()
        }
    }

    fun runSetupAgain() {
        val screen = (host.state.value as? CoreHostState.Ready)?.status?.screenId ?: return
        commissioningController.runAgain(screen)
        refreshCommissioning()
    }

    fun runSelfTest(): String {
        val screen = (host.state.value as? CoreHostState.Ready)?.status?.screenId ?: return "not_paired"
        val result = commissioningController.runSelfTest(screen)
        refreshCommissioning()
        reportPlatformObservations()
        return result
    }

    // Updates: the app-scoped manager prepares; this projects and drives the approval UI.

    fun openUpdatePermission() {
        updates?.openPermissionSettings()
    }

    fun refreshUpdatePermission() {
        viewModelScope.launch {
            val state = mutableUpdate.value ?: return@launch
            val manager = updates ?: return@launch
            val server = (host.state.value as? CoreHostState.Ready)?.status?.serverUrl
            manager.refreshPermission(server, credentials.read(), state)
            reportPlatformObservations()
        }
    }

    fun resumeUpdateSchedule() {
        viewModelScope.launch {
            val state = mutableUpdate.value ?: return@launch
            val server = (host.state.value as? CoreHostState.Ready)?.status?.serverUrl ?: return@launch
            val credential = credentials.read() ?: return@launch
            updates?.resumeMaintenance(server, credential, state, { mutableTakeoverActive.value }) { mutableUpdate.value = it }
        }
    }

    fun installUpdate() {
        viewModelScope.launch {
            val state = mutableUpdate.value ?: return@launch
            val server = (host.state.value as? CoreHostState.Ready)?.status?.serverUrl
            updates?.beginInstall(server, credentials.read(), state)
            reportPlatformObservations()
        }
    }

    // Platform observations: Kotlin-owned facts Core merges into its heartbeat.

    private fun reportPlatformObservations() {
        viewModelScope.launch {
            runCatching { host.reportObservations(platformObservationsJson()) }
        }
    }

    private fun platformObservationsJson(): String {
        val app = getApplication<Application>()
        val update = mutableUpdate.value
        val commissioning = mutableCommissioning.value
        val boot = BootRecovery.status(app)
        val kiosk = reliability.kioskCapability()
        val accessibilityOn = reliability.accessibilityEnabled()
        val maintenance = reliability.maintenanceUntil()
        val configured = mutablePlatform.value?.reliability?.mode ?: "standard"
        val effective = prefs.getString("effective-mode", "standard") ?: "standard"
        val instantOrNull: (Long) -> String? = { value -> value.takeIf { it > 0 }?.let { Instant.ofEpochMilli(it).toString() } }
        return buildJsonObject {
            update?.deploymentId?.let { put("currentUpdateDeploymentId", it) }
            update?.state?.let { put("updateState", it) }
            update?.let { put("updateDownloadedBytes", it.downloadedBytes) }
            update?.let { put("updateExpectedBytes", it.expectedBytes) }
            update?.errorCode?.let { put("updateError", it) }
            put("configuredReliabilityMode", configured)
            put("effectiveReliabilityMode", effective)
            put("foregroundState", if (prefs.getBoolean("foreground", false)) "foreground" else "background")
            instantOrNull(prefs.getLong("last-foreground-exit", 0))?.let { put("lastForegroundExitAt", it) }
            if (prefs.getBoolean("report-foreground-package", false)) {
                prefs.getString("last-foreground-package", null)?.let { put("lastForegroundPackage", it) }
            }
            put("bootRecoveryResult", boot.result)
            instantOrNull(prefs.getLong("last-cold-boot", 0))?.let { put("lastSuccessfulColdBootAt", it) }
            put("immersiveModeActive", prefs.getBoolean("immersive", false))
            put("keepScreenOn", prefs.getBoolean("keep-screen-on", false))
            put("managedKioskCapability", kiosk.name.lowercase())
            put(
                "deviceOwnerState",
                if (kiosk == ManagedKioskCapability.PROVISIONED ||
                    kiosk == ManagedKioskCapability.LOCK_TASK_ALLOWED ||
                    kiosk == ManagedKioskCapability.LOCK_TASK_ACTIVE
                ) {
                    "provisioned"
                } else {
                    "not_provisioned"
                },
            )
            put("lockTaskState", if (effective == "managed_kiosk") "active" else "inactive")
            put(
                "accessibilityServiceState",
                if (mutablePlatform.value?.accessibility?.controlAssistEnabled == true && !accessibilityOn) {
                    "policy_enabled_service_disabled"
                } else if (accessibilityOn) {
                    "enabled"
                } else {
                    "disabled"
                },
            )
            prefs.getString("accessibility-return-state", null)?.let { put("accessibilityReturnState", it) }
            put("accessibilityReturnAttempts", prefs.getInt("accessibility-return-attempts", 0))
            put("sleepCapability", if (accessibilityOn) "accessibility_assisted" else "black_screen_only")
            prefs.getString("last-sleep-result", null)?.let { put("lastSleepRequestResult", it) }
            prefs.getString("last-wake-result", null)?.let { put("lastWakeResult", it) }
            maintenance?.let { put("maintenanceSessionExpiresAt", it.toString()) }
            prefs.getLong("admin-pin-changed-at", 0).takeIf { it > 0 }
                ?.let { put("adminPinChangedAt", Instant.ofEpochMilli(it).toString()) }
            put(
                "commissioningState",
                if (commissioning.required) {
                    "in_progress"
                } else if (commissioning.completedAt != null) {
                    "complete"
                } else {
                    "not_started"
                },
            )
            put("commissioningStep", commissioning.step.wireValue)
            commissioning.completedAt?.let { put("commissioningCompletedAt", it.toString()) }
            put("bootAttemptCount", boot.attemptCount)
            boot.lastAttemptAt?.let { put("bootLastAttemptAt", it.toString()) }
            put("bootLaunchVerified", boot.launchVerified)
            put(
                "updateReadiness",
                if (commissioning.installPermissionGranted && app.filesDir.usableSpace > (update?.expectedBytes ?: 0)) {
                    "ready"
                } else {
                    "needs_attention"
                },
            )
            commissioning.selfTestResult?.let { put("selfTestResult", it) }
            commissioning.selfTestCompletedAt?.let { put("selfTestCompletedAt", it.toString()) }
        }.toString()
    }
}
