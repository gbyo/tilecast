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
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.tilecast.player.content.PlayerUpdateManager
import org.tilecast.player.content.UpdateUiState
import org.tilecast.player.core.CoreBeginResult
import org.tilecast.player.core.CoreHostState
import org.tilecast.player.core.CoreIdentity
import org.tilecast.player.core.CoreManifestResult
import org.tilecast.player.core.CorePlatformConfig
import org.tilecast.player.core.CorePlayerConfig
import org.tilecast.player.core.CorePairingState
import org.tilecast.player.core.CorePhoneSetup
import org.tilecast.player.core.CoreRecoveryResult
import org.tilecast.player.core.DiscoveredServer
import org.tilecast.player.core.PairingTarget
import org.tilecast.player.core.PlayerCoreHost
import org.tilecast.player.core.PlayerState
import org.tilecast.player.core.ReconnectBackoff
import org.tilecast.player.core.SetupPhase
import org.tilecast.player.core.ServerUrlPolicy
import org.tilecast.player.core.mapPlayerState
import org.tilecast.player.network.LanDiscovery
import org.tilecast.player.reliability.BootRecovery
import org.tilecast.player.reliability.CommissioningController
import org.tilecast.player.reliability.CommissioningStatus
import org.tilecast.player.reliability.ManagedKioskCapability
import org.tilecast.player.reliability.ReliabilityController
import org.tilecast.player.security.CredentialStore
import org.tilecast.player.security.MigratingCredentialStore
import java.time.Instant

/** Narrow host seam used to exercise PlayerViewModel setup without JNI. */
internal interface PlayerViewModelHost {
    val state: StateFlow<CoreHostState>
    val pairingState: StateFlow<CorePairingState>
    val updateManager: PlayerUpdateManager?

    suspend fun startDrivers()
    suspend fun refreshStatus()
    suspend fun fetchIdentity(url: String): CoreIdentity
    suspend fun beginPairing(url: String): CoreBeginResult
    suspend fun resetPairing(): Boolean
    suspend fun resetServer(): Boolean
    suspend fun resumePhoneSetup(): Boolean = false
    suspend fun syncManifest(): CoreManifestResult
    suspend fun rendererRecovery(json: String): CoreRecoveryResult
    suspend fun effectiveConfig(): CorePlayerConfig
    suspend fun reportObservations(json: String): Int
}

private class ProductionPlayerViewModelHost(
    private val delegate: PlayerCoreHost,
) : PlayerViewModelHost {
    override val state = delegate.state
    override val pairingState = delegate.pairingState
    override val updateManager = delegate.updateManager

    override suspend fun startDrivers() = delegate.startDrivers()
    override suspend fun refreshStatus() = delegate.refreshStatus()
    override suspend fun fetchIdentity(url: String) = delegate.fetchIdentity(url)
    override suspend fun beginPairing(url: String) = delegate.beginPairing(url)
    override suspend fun resetPairing() = delegate.resetPairing()
    override suspend fun resetServer() = delegate.resetServer()
    override suspend fun resumePhoneSetup() = delegate.resumePhoneSetup()
    override suspend fun syncManifest() = delegate.syncManifest()
    override suspend fun rendererRecovery(json: String) = delegate.rendererRecovery(json)
    override suspend fun effectiveConfig() = delegate.effectiveConfig()
    override suspend fun reportObservations(json: String) = delegate.reportObservations(json)
}

internal fun interface LanDiscoverySource {
    fun discover(): kotlinx.coroutines.flow.Flow<DiscoveredServer>
}

/**
 * The production Player UI state. Core owns pairing, content, presence,
 * and recovery; this ViewModel owns what Android must do itself: the
 * setup flow (discovery plus a credential-free identity check), the
 * Core state projection the screens render, platform configuration
 * effects, readiness reporting, updates, OS power effects, and the
 * platform observations Core merges into its heartbeat.
 *
 * Setup runs unattended. The Player searches until it finds a server,
 * pairs at once when it finds exactly one, retries failures with backoff,
 * and asks for a new code after revocation. An installer only acts when
 * several servers answer, none answer, or the server identity changed.
 */
class PlayerViewModel internal constructor(
    application: Application,
    private val host: PlayerViewModelHost,
    private val discovery: LanDiscoverySource,
) : AndroidViewModel(application) {
    constructor(application: Application) : this(
        application,
        ProductionPlayerViewModelHost(PlayerCoreHost.get(application)),
        LanDiscoverySource { LanDiscovery(application).discover() },
    )
    private val reliability = ReliabilityController(application)
    private val commissioningController = CommissioningController(application, reliability)
    private val credentials: CredentialStore = MigratingCredentialStore.forProduction(application)
    private val prefs = application.getSharedPreferences("tilecast-reliability", Context.MODE_PRIVATE)
    private val updates = host.updateManager

    private val mutableSetup = MutableStateFlow<SetupPhase>(SetupPhase.Boot)
    private val pairingTarget = MutableStateFlow<PairingTarget?>(null)
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
    private val mutableCommissioning = MutableStateFlow(CommissioningStatus())
    val commissioning: StateFlow<CommissioningStatus> = mutableCommissioning.asStateFlow()

    private val mutableSafeMode = MutableStateFlow(reliability.isSafeMode())
    /** The crash-loop latch, set at boot before this model exists. */
    val safeMode: StateFlow<Boolean> = mutableSafeMode.asStateFlow()

    private val mutableUpdate = MutableStateFlow<UpdateUiState?>(null)
    val update: StateFlow<UpdateUiState?> = mutableUpdate.asStateFlow()
    private val updateListener: (UpdateUiState) -> Unit = { viewModelScope.launch { mutableUpdate.value = it } }

    private var setupJob: Job? = null
    private var retryJob: Job? = null
    private var retryAttempt = 0
    private val backoff = ReconnectBackoff()
    /** The server the last attempt used, so a retry goes back to it rather than to search. */
    private var retryServer: String? = null
    /** The installer chose manual entry: the search must not pick a server for them. */
    private var manualEntry = false

    /** Phone setup while Core runs it: a QR code beside the setup screens. */
    val phoneSetup: StateFlow<CorePhoneSetup?> = host.pairingState
        .map { (it as? CorePairingState.Setup)?.phone }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private val mutableRetryAt = MutableStateFlow<Long?>(null)
    /** When the next automatic setup retry runs, in epoch milliseconds, for the countdown. */
    val retryAt: StateFlow<Long?> = mutableRetryAt.asStateFlow()

    init {
        mutableUpdate.value = updates?.restored
        updates?.addListener(updateListener)
        viewModelScope.launch { host.startDrivers() }
        viewModelScope.launch {
            combine(host.state, host.pairingState, mutableSetup, pairingTarget) { core, pairing, setup, target ->
                SetupInputs(core, pairing, setup, target)
            }.collect { (core, pairing, setup, target) ->
                val mapped = mapPlayerState(core, pairing, setup, target)
                mutableState.value = mapped
                onStateChanged(mapped, pairing)
                val status = (core as? CoreHostState.Ready)?.status
                mutableActiveHours.value = status?.activeHoursState != "off_hours"
                mutableTakeoverActive.value = status?.takeoverActive == true
                applyPowerEffects()
                if (status?.configRevision != appliedConfigRevision) refreshPlatformConfig(status?.configRevision)
                refreshCommissioning(status?.screenId)
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
        startSetup()
    }

    override fun onCleared() {
        updates?.removeListener(updateListener)
        super.onCleared()
    }

    // Setup: discovery and validation stay in Kotlin; pairing is Core's.

    private data class SetupInputs(
        val core: CoreHostState,
        val pairing: CorePairingState,
        val setup: SetupPhase,
        val target: PairingTarget?,
    )

    /**
     * Starts or restarts unattended setup: a server Core still remembers
     * comes first, then the network search. A paired Player, or one that
     * already shows a code, has nothing to set up. A revoked one clears
     * its pairing session and asks the same server for a new code.
     */
    private fun startSetup(after: Long = 0) {
        cancelRetry()
        setupJob?.cancel()
        setupJob = viewModelScope.launch {
            delay(after)
            runCatching { host.startDrivers() }
            runCatching { host.refreshStatus() }
            when (mapPlayerState(host.state.value, host.pairingState.value, SetupPhase.Boot)) {
                is PlayerState.PairedIdle, is PlayerState.PairedConnecting, PlayerState.Enrolling,
                is PlayerState.WaitingForApproval, PlayerState.PairingRequest, is PlayerState.ServerIdentityMismatch,
                -> return@launch
                is PlayerState.CredentialRevoked -> runCatching { host.resetPairing() }
                else -> Unit
            }
            val status = (host.state.value as? CoreHostState.Ready)?.status
            val known = retryServer ?: status?.serverUrl ?: status?.retainedServerUrl
            if (known != null && !manualEntry) connect(known, fromManualEntry = false) else search()
        }
    }

    /** Searches the network again from the start. Also the "Search again" action. */
    fun discover() {
        manualEntry = false
        retryServer = null
        retryAttempt = 0
        cancelRetry()
        setupJob?.cancel()
        setupJob = viewModelScope.launch {
            runCatching { host.startDrivers() }
            search()
        }
    }

    /**
     * Browses until a server answers. Exactly one answer pairs at once;
     * several are listed for the installer; none keeps the search going.
     */
    private suspend fun search() {
        mutableSetup.value = SetupPhase.Discovering
        val found = linkedMapOf<String, DiscoveredServer>()
        while (true) {
            withTimeoutOrNull(SCAN_MILLIS) {
                discovery.discover().catch { }.collect {
                    found[it.baseUrl] = it
                    if (found.size > 1) mutableSetup.value = SetupPhase.Browsing(found.values.toList())
                }
            }
            val servers = found.values.toList()
            if (servers.size == 1) {
                connect(servers.single().baseUrl, fromManualEntry = false)
                return
            }
            mutableSetup.value = SetupPhase.Browsing(servers)
            delay(RESCAN_MILLIS)
        }
    }

    /** Starts a paused phone setup session again. */
    fun resumePhoneSetup() {
        viewModelScope.launch { host.resumePhoneSetup() }
    }

    fun showManualEntry() {
        manualEntry = true
        cancelRetry()
        setupJob?.cancel()
        mutableSetup.value = SetupPhase.Manual()
    }

    /** Pairs with an address the installer typed. */
    fun submitServerAddress(value: String) {
        manualEntry = true
        cancelRetry()
        setupJob?.cancel()
        setupJob = viewModelScope.launch { connect(ServerUrlPolicy.withDefaultScheme(value), fromManualEntry = true) }
    }

    fun chooseServer(server: DiscoveredServer) {
        cancelRetry()
        setupJob?.cancel()
        setupJob = viewModelScope.launch { connect(server.baseUrl, fromManualEntry = false) }
    }

    /**
     * Checks the server identity without credentials and asks Core for a
     * pairing code. A failure from manual entry stays on the entry screen;
     * any other failure retries by itself.
     */
    private suspend fun connect(address: String, fromManualEntry: Boolean) {
        val normalized = ServerUrlPolicy.normalize(address).getOrElse {
            fail(it.message ?: "Enter a valid server address", fromManualEntry)
            return
        }
        retryServer = normalized.value
        mutableSetup.value = SetupPhase.Validating(normalized.value)
        val identity = runCatching { host.fetchIdentity(normalized.value) }.getOrNull()
        when {
            identity == null || !identity.ok ->
                return fail("Could not reach Tilecast at ${normalized.value}", fromManualEntry)
            identity.product != "tilecast" || identity.apiVersion != "v1" ->
                return fail("${normalized.value} is not a compatible Tilecast server", fromManualEntry)
            !identity.pairingEnabled ->
                return fail("Pairing is turned off on ${identity.organizationName ?: normalized.value}", fromManualEntry)
        }
        pairingTarget.value = PairingTarget(normalized.value, normalized.localInsecure)
        mutableSetup.value = SetupPhase.Requesting
        val result = runCatching { host.beginPairing(normalized.value) }.getOrNull()
        when {
            result?.ok == true -> {
                manualEntry = false
                retryAttempt = 0
            }
            // Core already holds a binding: the paired projection takes
            // over on the next status refresh.
            result?.code == "already_paired" -> runCatching { host.refreshStatus() }
            result?.code == "pairing_disabled" -> fail("Pairing is turned off on this Tilecast server", fromManualEntry = false)
            else -> fail("Could not request a pairing code from ${normalized.value}", fromManualEntry = false)
        }
    }

    private fun fail(message: String, fromManualEntry: Boolean) {
        if (fromManualEntry) {
            mutableSetup.value = SetupPhase.Manual(message)
            return
        }
        mutableSetup.value = SetupPhase.Failed(message)
        scheduleRetry()
    }

    /** Runs setup again after a growing delay; the error screen shows the countdown. */
    private fun scheduleRetry() {
        if (retryJob?.isActive == true) return
        val wait = backoff.delayMillis(retryAttempt + 2)
        retryAttempt += 1
        mutableRetryAt.value = System.currentTimeMillis() + wait
        retryJob = viewModelScope.launch {
            delay(wait)
            retryJob = null
            mutableRetryAt.value = null
            startSetup()
        }
    }

    private fun cancelRetry() {
        retryJob?.cancel()
        retryJob = null
        mutableRetryAt.value = null
    }

    /** "Try again now" on the error screen. */
    fun retryNow() {
        startSetup()
    }

    /**
     * Reacts to states that recover without a person: a revoked screen asks
     * the same server for a new code, and a rejected address retries. Once
     * Core pairs or shows a code, setup has nothing left to do.
     */
    private fun onStateChanged(state: PlayerState, pairing: CorePairingState) {
        val busy = setupJob?.isActive == true || retryJob?.isActive == true
        when {
            state is PlayerState.PairedIdle || state is PlayerState.PairedConnecting || state == PlayerState.Enrolling -> {
                setupJob?.cancel()
                cancelRetry()
                manualEntry = false
                retryAttempt = 0
            }
            state is PlayerState.WaitingForApproval -> cancelRetry()
            state is PlayerState.CredentialRevoked -> if (!busy) startSetup(after = REVOKED_NOTICE_MILLIS)
            pairing is CorePairingState.AddressRejected -> scheduleRetry()
        }
    }

    /** "Change server" on the pairing screen: drops the code and searches again. */
    fun changeServer() {
        viewModelScope.launch {
            runCatching { host.resetPairing() }
            pairingTarget.value = null
            discover()
        }
    }

    /**
     * Forgets the server connection entirely and searches again. Only an
     * explicit action reaches this: the identity-mismatch screen or the
     * maintenance menu.
     */
    fun resetServer() {
        viewModelScope.launch {
            runCatching { host.resetServer() }
            pairingTarget.value = null
            appliedConfigRevision = null
            mutablePlatform.value = null
            discover()
        }
    }

    // Renderer and clock callbacks from the Activity.

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
        // A new policy re-applies the current active-hours state.
        lastPowerActive = null
        applyPowerEffects()
        reportPlatformObservations()
    }

    /** Writes the policy prefs the OS integration reads: boot, kiosk return, and foreground reporting. */
    private fun applyPlatformPolicy(config: CorePlayerConfig) {
        val platform = config.platform
        BootRecovery.setLaunchAfterBoot(getApplication<Application>(), platform.reliability.launchAfterBoot)
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
        // The edge is recorded only once a policy can act on it, so a status
        // that arrives before the configuration is applied when it loads.
        val platform = mutablePlatform.value ?: return
        lastPowerActive = active
        if (active) {
            reliability.requestWake()
            return
        }
        if (platform.power.sleepOutsideActiveHours && !mutableTakeoverActive.value) reliability.requestSleep()
        val transition = (host.state.value as? CoreHostState.Ready)?.status?.nextTransitionAt
            ?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return
        reliability.scheduleWake(transition.minusSeconds(platform.power.startupGraceSeconds))
    }

    // Readiness: what Studio reports about unattended operation. Nothing here blocks playback.

    fun refreshCommissioning() {
        refreshCommissioning((host.state.value as? CoreHostState.Ready)?.status?.screenId)
    }

    private fun refreshCommissioning(screenId: String?) {
        mutableCommissioning.value = commissioningController.status(screenId)
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
            manager.refreshPermission(server, credentials.read(), state) { mutableTakeoverActive.value }
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
            updates?.beginInstall(server, credentials.read(), state) { mutableTakeoverActive.value }
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
            put("commissioningState", if (commissioning.completedAt != null) "complete" else "not_started")
            put("commissioningStep", CommissioningStatus.STEP)
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
            if (commissioning.selfTestResult != null) commissioning.checkedAt?.let { put("selfTestCompletedAt", it.toString()) }
        }.toString()
    }

    private companion object {
        const val SCAN_MILLIS = 5_000L
        const val RESCAN_MILLIS = 10_000L
        /** Long enough to read why the screen is about to show a new code. */
        const val REVOKED_NOTICE_MILLIS = 4_000L
    }
}
