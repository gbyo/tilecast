package org.tilecast.player

import android.app.Application
import android.os.Build
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.tilecast.player.core.DiscoveredServer
import org.tilecast.player.core.NormalizedServerUrl
import org.tilecast.player.core.PlayerEvent
import org.tilecast.player.core.PlayerState
import org.tilecast.player.core.PlayerStateMachine
import org.tilecast.player.core.OfflineAction
import org.tilecast.player.core.OfflineEscalationPolicy
import org.tilecast.player.core.ReconnectBackoff
import org.tilecast.player.core.ServerUrlPolicy
import org.tilecast.player.data.ConfigurationRepository
import org.tilecast.player.data.PlayerConfiguration
import org.tilecast.player.data.PlayerDatabase
import org.tilecast.player.network.ApiException
import org.tilecast.player.network.DeviceMetadata
import org.tilecast.player.network.HeartbeatRequest
import org.tilecast.player.network.LanDiscovery
import org.tilecast.player.network.ServerIdentity
import org.tilecast.player.network.PairingSession
import org.tilecast.player.network.TilecastApi
import org.tilecast.player.security.CredentialStore
import org.tilecast.player.security.KeystoreCredentialStore
import org.tilecast.player.content.ManifestSyncManager
import org.tilecast.player.content.ServerClock
import org.tilecast.player.content.PlaybackSession
import org.tilecast.player.content.nextRuntimeActivationIdentity
import org.tilecast.player.content.PreparedContent
import org.tilecast.player.content.SyncProgress
import org.tilecast.player.content.ScheduleEngine
import org.tilecast.player.content.WebsitePlaybackStatus
import org.tilecast.player.content.WidgetPlaybackStatus
import org.tilecast.player.content.WebsiteDataManager
import org.tilecast.player.content.WebsiteStartupClearGate
import org.tilecast.player.content.CommandCoordinator
import org.tilecast.player.content.CommandOutcome
import org.tilecast.player.content.runCommandPollSafely
import org.tilecast.player.content.TakeoverController
import org.tilecast.player.content.PlayerConfigManager
import org.tilecast.player.content.PlayerUpdateManager
import org.tilecast.player.content.UpdateUiState
import org.tilecast.player.content.synchronizedPlaybackStart
import org.tilecast.player.content.pendingActivationDelayMillis
import org.tilecast.player.content.withAvailablePlaylistItems
import org.tilecast.player.content.nextAvailabilityTransition
import org.tilecast.player.network.PlayerConfig
import org.tilecast.player.network.encodeLiveStreamFrame
import org.tilecast.player.reliability.ActiveHoursEngine
import org.tilecast.player.reliability.ActiveHoursRule
import org.tilecast.player.reliability.ReliabilityController
import org.tilecast.player.reliability.ReliabilitySupervisor
import org.tilecast.player.reliability.PreferencesRecoveryStateStore
import org.tilecast.player.reliability.RecoveryDecision
import org.tilecast.player.reliability.RecoveryLevel
import org.tilecast.player.reliability.CommissioningController
import org.tilecast.player.reliability.CommissioningStatus
import org.tilecast.player.reliability.BootRecovery
import java.time.DayOfWeek
import java.time.LocalTime
import java.time.Duration
import java.time.Instant
import java.util.Locale
import java.util.TimeZone

class PlayerViewModel(application: Application) : AndroidViewModel(application) {
    var onLiveStreamSessionChanged: (() -> Unit)? = null
    private val machine = PlayerStateMachine()
    private val mutableState = MutableStateFlow<PlayerState>(PlayerState.Unconfigured)
    val state: StateFlow<PlayerState> = mutableState.asStateFlow()
	private val configuration = ConfigurationRepository(PlayerDatabase.get(application).configuration())
	private val database = PlayerDatabase.get(application)
	private val playbackCheckpoint = application.getSharedPreferences("tilecast-playback-checkpoint", android.content.Context.MODE_PRIVATE)
    private val serverClock = ServerClock(application.getSharedPreferences("tilecast-server-clock", android.content.Context.MODE_PRIVATE))
	private val synchronizer = ManifestSyncManager(application, database, api = TilecastApi(), cacheLimitBytes=BuildConfig.MEDIA_CACHE_BYTES, minimumFreeBytes=BuildConfig.MINIMUM_FREE_BYTES, automaticVideoThresholdBytes=BuildConfig.AUTOMATIC_VIDEO_THRESHOLD_BYTES, concurrentDownloads=BuildConfig.CONCURRENT_DOWNLOADS, serverClock=serverClock)
    private val credentials: CredentialStore = KeystoreCredentialStore(application)
    private val api = TilecastApi()
    private val discovery = LanDiscovery(application)
    private val backoff = ReconnectBackoff()
    private val offlineEscalation = OfflineEscalationPolicy()
    private val activityQueue by lazy { org.tilecast.player.activity.PlayerActivityQueue.get(application) }
    // Elapsed-realtime timestamp of the current healthy socket; used to decide whether a
    // connection was healthy long enough to reset reconnect backoff. Offline self-heal
    // escalation state is persisted in SharedPreferences (see maybeSelfHeal), not here, so
    // it survives a process restart.
    private var socketOpenedAtElapsed: Long = 0L
    private var current: PlayerConfiguration? = null
    private var selectedIdentity: ServerIdentity? = null
    private var selectedUrl: NormalizedServerUrl? = null
	private var socket: WebSocket? = null
	private var reconnectJob: Job? = null
	private val connectionEpoch = ConnectionEpoch()
	private var pairingJob: Job? = null
	private var pairingRequestJob: Job? = null
	private val mutableContent = MutableStateFlow<PlaybackSession?>(null)
	val content: StateFlow<PlaybackSession?> = mutableContent.asStateFlow()
	private val mutableNoContentKnown = MutableStateFlow(false)
	val noContentKnown: StateFlow<Boolean> = mutableNoContentKnown.asStateFlow()
	private val mutableUnavailableKnown = MutableStateFlow(false)
	val unavailableKnown: StateFlow<Boolean> = mutableUnavailableKnown.asStateFlow()
	private val mutableNoContentLogoPath = MutableStateFlow<String?>(null)
	val noContentLogoPath: StateFlow<String?> = mutableNoContentLogoPath.asStateFlow()
	private var pendingContent: PreparedContent? = null
	private var syncJob: Job? = null
	// A manifest.changed push that arrives while a sync is already running must not be
	// dropped; it is coalesced into one follow-up pass after the running sync finishes.
	private var syncPending = false
	private var syncRetryJob: Job? = null
	private var syncFailureCount = 0
	private var pendingActivationJob: Job? = null
	private var playbackRetryJob: Job? = null
	private var commandRetryJob: Job? = null
	private var commandFailureCount = 0
	private var manifestPollJob: Job? = null
	private var syncProgress = SyncProgress()
	private var lastPlaybackError: String? = null
	private var currentItemId: String? = null
	private var currentAssetId: String? = null
	private var activeManifestVersion: Long? = null
	private var assignedPlaylistId: String? = null
	private var scheduleContent: PreparedContent? = null
	private var scheduleJob: Job? = null
	private var currentScheduleId: String? = null
	private var currentPlaylistId: String? = null
	private var selectionSource: String = "none"
	private var nextTransition: Instant? = null
	private var scheduleError: String? = null
	private var clockOffsetSeconds: Long? = null
	private var websiteStatus=WebsitePlaybackStatus()
	private var widgetStatus=WidgetPlaybackStatus()
	private val commandCoordinator=CommandCoordinator(application,api)
	private val mutablePlaybackDisabled=MutableStateFlow(commandCoordinator.playbackDisabled)
	val playbackDisabled:StateFlow<Boolean> = mutablePlaybackDisabled.asStateFlow()
	private val mutableIdentify=MutableStateFlow<String?>(null)
	val identify:StateFlow<String?> = mutableIdentify.asStateFlow()
	private var takeoverJob:Job?=null
	private var activeTakeoverId:String?=null
	private var takeoverState:String?=null
	private var activePresentationOverrideId:String?=null
	private var lastCommandId:String?=null
	private var lastCommandState:String?=null
	private var lastCommandResult:String?=null
	private var lastCommandCompletedAt:String?=null
	private val configManager=PlayerConfigManager(database,api)
	private val mutablePlayerConfig=MutableStateFlow<PlayerConfig?>(null)
	val playerConfig:StateFlow<PlayerConfig?> = mutablePlayerConfig.asStateFlow()
	private var configPollJob:Job?=null
	private var activeConfigRevision:Long?=null
	private var configurationError:String?=null
	private var lastStatusSentAt:Long=0
	private val updateManager=PlayerUpdateManager(application,api)
	private val mutableUpdate=MutableStateFlow<UpdateUiState?>(updateManager.restored)
	val update:StateFlow<UpdateUiState?> = mutableUpdate.asStateFlow()
	private val reliabilityController=ReliabilityController(application)
		private var reliabilitySupervisor=ReliabilitySupervisor(store=PreferencesRecoveryStateStore(application))
		private val commissioningController=CommissioningController(application,reliabilityController)
		private val mutableCommissioning=MutableStateFlow(CommissioningStatus())
		val commissioning:StateFlow<CommissioningStatus> = mutableCommissioning.asStateFlow()
	private val mutableActiveHours=MutableStateFlow(true)
	val activeHours:StateFlow<Boolean> = mutableActiveHours.asStateFlow()
	private val mutableSafeMode=MutableStateFlow(false)
	val safeMode:StateFlow<Boolean> = mutableSafeMode.asStateFlow()
	private var powerJob:Job?=null
	private var activeHoursNextTransition:Instant?=null
	private var resumeCheckpointPending = true
	private var lastWatchdogFailure:String?=null
	private var lastWatchdogRecoveryAt:Instant?=null
	private var recoveryLevel:Int=0
		private var recoveryCount:Int=0
		private var lastPlaybackProgressAt:Instant?=null
		private var watchdogJob:Job?=null

    init { viewModelScope.launch { bootstrap() } }

    private fun emit(event: PlayerEvent) { mutableState.value = machine.transition(event) }

    private suspend fun bootstrap() {
        current = configuration.getOrCreate()
        val saved = current ?: return
		val storedCredential = credentials.read()
			mutablePlayerConfig.value=configManager.loadActive(saved.serverUrl, saved.serverInstallationId, saved.screenId);mutablePlayerConfig.value?.let(::applyPlayerConfig)
			if (saved.serverUrl != null && storedCredential != null) {
				synchronizer.loadActive(saved.serverUrl, saved.serverInstallationId, saved.screenId)?.let { active -> activeManifestVersion=active.manifest.manifestVersion;activateScheduleSelection(active,saved.serverUrl,storedCredential) }
			}
			refreshCommissioning()
			startWatchdog()
        if (saved.serverUrl == null) { discover(); return }
        emit(PlayerEvent.Validate(saved.serverUrl))
        try {
            val identity = api.identity(saved.serverUrl)
			if (saved.serverInstallationId != null && saved.serverInstallationId != identity.installationId) {
				clearPlaybackState()
				synchronizer.clear()
				clearPlayerConfigState()
                emit(PlayerEvent.IdentityChanged(saved.serverInstallationId, identity.installationId)); return
            }
            selectedIdentity = identity
            selectedUrl = ServerUrlPolicy.normalize(saved.serverUrl).getOrThrow()
            val credential = storedCredential
            if (credential != null && saved.screenName != null) connectPaired(saved, credential)
            else if (saved.pairingSessionId != null && saved.pairingPollSecret != null && saved.pairingCode != null && saved.pairingExpiresAt != null && Instant.parse(saved.pairingExpiresAt).isAfter(Instant.now())) {
                val session=PairingSession(saved.pairingSessionId,saved.pairingCode,saved.pairingPollSecret,saved.pairingExpiresAt,Instant.now().toString(),saved.pairingPollingIntervalSeconds?:3,"",saved.organizationName?:identity.organizationName)
                emit(PlayerEvent.IdentityConfirmed(selectedUrl!!,identity));emit(PlayerEvent.PairingCreated(saved.serverUrl,identity.organizationName,session));startPairingPoll(selectedUrl!!.value,session.id,session.pollSecret,session.pollingIntervalSeconds)
            } else {
                if(saved.pairingSessionId!=null)current=configuration.clearPairingSession(saved)
                emit(PlayerEvent.IdentityConfirmed(selectedUrl!!, identity))
            }
        } catch (error: CancellationException) { throw error
        } catch (error: Exception) { emit(PlayerEvent.Failed(error.message ?: "Could not reach the Tilecast server")) }
    }

    fun discover() { viewModelScope.launch {
        emit(PlayerEvent.Start)
        val found = linkedMapOf<String, DiscoveredServer>()
        withTimeoutOrNull(5_000) { discovery.discover().catch { }.collect { found[it.baseUrl] = it } }
        emit(PlayerEvent.DiscoveryFinished(found.values.toList()))
    } }

    fun showManualEntry() = emit(PlayerEvent.EnterManualAddress)

    fun validateServer(value: String) { viewModelScope.launch {
        val normalized = ServerUrlPolicy.normalize(value).getOrElse { emit(PlayerEvent.Failed(it.message ?: "Invalid server address")); return@launch }
        emit(PlayerEvent.Validate(normalized.value))
        try {
            val identity = api.identity(normalized.value)
            require(identity.product == "tilecast" && identity.apiVersion == "v1") { "This address is not a compatible Tilecast server" }
            selectedUrl = normalized; selectedIdentity = identity
            emit(PlayerEvent.IdentityConfirmed(normalized, identity))
        } catch (error: CancellationException) { throw error
        } catch (error: Exception) { emit(PlayerEvent.Failed(error.message ?: "Could not connect to Tilecast")) }
    } }

    fun chooseServer(server: DiscoveredServer) = validateServer(server.baseUrl)

    fun requestPairing() {
		pairingRequestJob?.cancel()
		pairingRequestJob = viewModelScope.launch {
        val url = selectedUrl ?: return@launch; val identity = selectedIdentity ?: return@launch; val saved = current ?: configuration.getOrCreate()
        emit(PlayerEvent.RequestPairing)
        try {
            current = configuration.saveServer(saved, url.value, identity.installationId, identity.organizationName)
            val persisted=current!!
            if(persisted.pairingSessionId!=null&&persisted.pairingPollSecret!=null&&persisted.pairingCode!=null&&persisted.pairingExpiresAt!=null&&Instant.parse(persisted.pairingExpiresAt).isAfter(Instant.now())){
                val existing=PairingSession(persisted.pairingSessionId,persisted.pairingCode,persisted.pairingPollSecret,persisted.pairingExpiresAt,Instant.now().toString(),persisted.pairingPollingIntervalSeconds?:3,"",identity.organizationName)
                emit(PlayerEvent.PairingCreated(url.value,identity.organizationName,existing));startPairingPoll(url.value,existing.id,existing.pollSecret,existing.pollingIntervalSeconds);return@launch
            }
            val session = api.createPairing(url.value, identity.installationId, deviceMetadata(saved.playerInstallationId))
            current=configuration.savePairingSession(current!!,session)
            emit(PlayerEvent.PairingCreated(url.value, identity.organizationName, session))
            startPairingPoll(url.value, session.id, session.pollSecret, session.pollingIntervalSeconds)
        } catch (error: CancellationException) { throw error
        } catch (error: Exception) { emit(PlayerEvent.Failed(error.message ?: "Pairing request failed")) }
    } }

    private fun startPairingPoll(url: String, sessionId: String, pollSecret: String, interval: Int) {
        pairingJob?.cancel()
        pairingJob = viewModelScope.launch { pollPairing(url, sessionId, pollSecret, interval) }
    }

    private suspend fun pollPairing(url: String, sessionId: String, pollSecret: String, interval: Int) {
        while (true) {
            delay(interval.coerceAtLeast(2) * 1_000L)
            try {
                val result = api.pollPairing(url, sessionId, pollSecret)
                when (result.status) {
                    "pending", "approved" -> continue
                    "rejected" -> { emit(PlayerEvent.Failed(result.failureReason ?: "The pairing request was rejected")); return }
                    "expired", "cancelled" -> { current?.let{current=configuration.clearPairingSession(it)};emit(PlayerEvent.Failed("The pairing code expired. Request a new code.")); return }
                    "claimed" -> {
                        val token = result.enrollmentToken ?: return
                        emit(PlayerEvent.EnrollmentStarted)
                        val enrollment = api.enroll(url, sessionId, token)
                        if (current?.screenId != null && current?.screenId != enrollment.screenId) {
                            clearPlaybackState()
                            synchronizer.clear()
                            clearPlayerConfigState()
                        }
                        credentials.save(enrollment.deviceCredential)
						current = configuration.saveEnrollment(current ?: return, enrollment.screenId, enrollment.screenName)
						refreshCommissioning()
                        emit(PlayerEvent.Enrolled(enrollment.screenName))
                        connectPaired(current!!, enrollment.deviceCredential)
                        return
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: ApiException) {
                if (error.status in 400..499) { emit(PlayerEvent.Failed(error.message)); return }
            } catch (_: Exception) { /* transient loss: keep the visible code and retry */ }
        }
    }

    private suspend fun connectPaired(saved: PlayerConfiguration, credential: String) {
        val epoch = connectionEpoch.capture()
        val url = saved.serverUrl ?: return; val screenName = saved.screenName ?: return
        mutableContent.value = mutableContent.value?.copy(serverUrl = url, credential = credential)
        emit(PlayerEvent.Enrolled(screenName))
        try {
            api.heartbeat(url, credential, heartbeat())
        } catch (error: ApiException) {
            if (error.code == "device_credential_revoked" || error.code == "device_credential_invalid") { revokeLocally(screenName); return }
            if (error.code == "screen_disabled") { emit(PlayerEvent.Disconnected(screenName, "This screen is disabled in Tilecast Studio")); return }
            if (error.status in 400..499) { emit(PlayerEvent.Failed(error.message)); return }
        } catch (error: CancellationException) { throw error
        } catch (_: Exception) { }
        openSocket(url, screenName, credential, 0, epoch)
    }

    private fun openSocket(url: String, screenName: String, credential: String, attempt: Int, epoch: Long) {
        if (!connectionEpoch.isCurrent(epoch)) return
        val previous = socket
        socket = null
        previous?.cancel()
        socket = api.socket(url, credential, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!connectionEpoch.isCurrent(epoch) || socket !== webSocket) return
                reconnectJob?.cancel(); reconnectJob = null
                if (attempt > 0) recordReliabilityEvent("connection.restored", "info", result = "recovered", failureMessage = "Reconnected after $attempt attempt(s)")
                socketOpenedAtElapsed = SystemClock.elapsedRealtime()
                // Server reachable again: clear this outage's self-heal escalation state.
                getApplication<Application>().getSharedPreferences("tilecast-reliability", Application.MODE_PRIVATE).edit().putString("offline-last-action", "NONE").apply()
                webSocket.send("{\"type\":\"player.hello\",\"protocolVersion\":1,\"playerVersion\":\"${BuildConfig.VERSION_NAME}\"}")
                webSocket.send(Json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), statusMessage()))
                onLiveStreamSessionChanged?.invoke()
				viewModelScope.launch { if (connectionEpoch.isCurrent(epoch)) emit(PlayerEvent.Connected(screenName)) }
					getApplication<Application>().getSharedPreferences("tilecast-reliability",Application.MODE_PRIVATE).edit().putLong("last-server-connection-at",System.currentTimeMillis()).apply()
				viewModelScope.launch { if (connectionEpoch.isCurrent(epoch)) reconcileManifest(url, credential) }
				viewModelScope.launch { if (connectionEpoch.isCurrent(epoch)) runCommands(url, credential) }
				viewModelScope.launch { if (connectionEpoch.isCurrent(epoch)) reconcilePlayerConfig(url,credential) }
				// The periodic pass also polls commands: a dropped commands.available push must
				// never strand a command until the next reconnect.
				manifestPollJob?.cancel(); manifestPollJob=viewModelScope.launch { while (connectionEpoch.isCurrent(epoch)) { delay(manifestPollDelayMillis(mutablePlayerConfig.value?.sync?.manifestReconciliationSeconds)); if (connectionEpoch.isCurrent(epoch)) { reconcileManifest(url,credential); runCommands(url,credential) } } }
				configPollJob?.cancel();configPollJob=viewModelScope.launch{while(connectionEpoch.isCurrent(epoch)){delay(manifestPollDelayMillis(mutablePlayerConfig.value?.sync?.manifestReconciliationSeconds));if(connectionEpoch.isCurrent(epoch))reconcilePlayerConfig(url,credential)}}
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
				if (!connectionEpoch.isCurrent(epoch) || socket !== webSocket) return
				if (text.contains("server.ping")) { webSocket.send("{\"type\":\"player.pong\"}");val interval=(mutablePlayerConfig.value?.sync?.statusReportSeconds?:60)*1000L;if(System.currentTimeMillis()-lastStatusSentAt>=interval){webSocket.send(Json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), statusMessage()));lastStatusSentAt=System.currentTimeMillis()} }
				if (text.contains("manifest.changed")) viewModelScope.launch { if (connectionEpoch.isCurrent(epoch)) reconcileManifest(url, credential) }
				if(text.contains("commands.available"))viewModelScope.launch{if(connectionEpoch.isCurrent(epoch))runCommands(url,credential)}
				if(text.contains("config.changed"))viewModelScope.launch{if(connectionEpoch.isCurrent(epoch))reconcilePlayerConfig(url,credential)}
				if(text.contains("live_stream.session_changed"))onLiveStreamSessionChanged?.invoke()
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
				if (!connectionEpoch.isCurrent(epoch) || socket !== webSocket) return
				manifestPollJob?.cancel()
				configPollJob?.cancel()
                webSocket.close(code, reason)
                scheduleReconnect(url, screenName, credential, nextReconnectAttempt(attempt), reason, epoch)
            }
            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
				if (!connectionEpoch.isCurrent(epoch) || socket !== webSocket) return
				manifestPollJob?.cancel()
				configPollJob?.cancel()
                if (response?.code == 401) { viewModelScope.launch { verifyAfterAuthFailure(url, screenName, credential, epoch) }; return }
                scheduleReconnect(url, screenName, credential, nextReconnectAttempt(attempt), error.message, epoch)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
				if (!connectionEpoch.isCurrent(epoch) || socket !== webSocket) return
				manifestPollJob?.cancel()
				configPollJob?.cancel()
                scheduleReconnect(url, screenName, credential, nextReconnectAttempt(attempt), reason, epoch)
            }
        })
    }

    fun sendLiveStreamFrame(
        sessionId: String,
        capturedAtMillis: Long,
        width: Int,
        height: Int,
        jpeg: ByteArray,
    ): Boolean {
        val activeSocket = socket ?: return false
        return runCatching {
            activeSocket.send(encodeLiveStreamFrame(sessionId, capturedAtMillis, width, height, jpeg))
        }.getOrDefault(false)
    }

    // nextReconnectAttempt resets the escalation index when the socket that just closed had
    // been healthy long enough, so a brief blip after a stable connection reconnects fast.
    private fun nextReconnectAttempt(attempt: Int): Int {
        val connectedFor = if (socketOpenedAtElapsed > 0) SystemClock.elapsedRealtime() - socketOpenedAtElapsed else 0L
        return backoff.nextAttempt(attempt, connectedFor)
    }

    // Synchronized because OkHttp invokes onClosing/onFailure/onClosed from its own threads;
    // an unsynchronized check-then-set on reconnectJob could schedule two reconnect loops and
    // leave two live sockets fighting each other.
    @Synchronized
    private fun scheduleReconnect(url: String, name: String, credential: String, attempt: Int, reason: String?, epoch: Long) {
        if (!connectionEpoch.isCurrent(epoch)) return
        if (reconnectJob?.isActive == true) return
        reconnectJob = viewModelScope.launch {
            emit(PlayerEvent.Disconnected(name, reason))
            if (attempt <= 1) recordReliabilityEvent("connection.lost", "warning", result = "failed", failureMessage = reason ?: "Connection lost")
            maybeSelfHeal()
            delay(backoff.delayMillis(attempt))
            if (!connectionEpoch.isCurrent(epoch)) return@launch
            try {
                val actual = api.identity(url)
				if (!connectionEpoch.isCurrent(epoch)) return@launch
				val expected = current?.serverInstallationId
				if (expected != null && actual.installationId != expected) {
					clearPlaybackState()
					clearPlayerConfigState()
					emit(PlayerEvent.IdentityChanged(expected, actual.installationId))
					return@launch
                }
                openSocket(url, name, credential, attempt, epoch)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                reconnectJob = null
                scheduleReconnect(url, name, credential, attempt + 1, "Server unavailable", epoch)
            }
        }
    }

    // maybeSelfHeal escalates a Player that has lost server contact AND is no longer
    // rendering. "Rendering" is judged by real playback progress, not by the presence of a
    // playback session, because a session can exist while the screen is blank or frozen.
    // Escalation state is persisted so it survives a process restart and cannot loop: a
    // relaunched process reads that it already restarted this outage and holds. State clears
    // as soon as playback progresses again or the server becomes reachable (see onOpen).
    private fun maybeSelfHeal() {
        val prefs = getApplication<Application>().getSharedPreferences("tilecast-reliability", Application.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val lastContact = prefs.getLong("last-server-connection-at", 0)
        if (lastContact <= 0) return // never connected yet; enrollment path handles first contact
        val offlineFor = java.time.Duration.ofMillis((now - lastContact).coerceAtLeast(0))
        val lastProgress = prefs.getLong("last-playback-progress-at", 0)
        val progressStaleFor = if (lastProgress > 0) java.time.Duration.ofMillis((now - lastProgress).coerceAtLeast(0)) else java.time.Duration.ofDays(3650)
        val lastAction = runCatching { OfflineAction.valueOf(prefs.getString("offline-last-action", "NONE")!!) }.getOrDefault(OfflineAction.NONE)
        val action = offlineEscalation.decide(offlineFor, progressStaleFor, lastAction)
        if (action == OfflineAction.NONE) {
            // Progress resumed (or we never went stale): clear escalation so a later outage starts fresh.
            if (progressStaleFor.toMinutes() < 2 && lastAction != OfflineAction.NONE) prefs.edit().putString("offline-last-action", "NONE").apply()
            return
        }
        // Backstop against a restart loop even if persisted state is lost: never restart the
        // process more than once per restart interval.
        if (action == OfflineAction.RESTART_PROCESS && now - prefs.getLong("offline-restart-process-at", 0) < 30 * 60_000L && prefs.getLong("offline-restart-process-at", 0) > 0) return
        prefs.edit().putString("offline-last-action", action.name).apply()
        // An attempt, not a confirmed recovery: recovery is only reported once the socket
        // actually reopens (connection.restored) or playback progress resumes.
        recordReliabilityEvent(
            "watchdog.offline_recovery",
            if (action == OfflineAction.VERIFY_FALLBACK) "warning" else "error",
            result = "unknown",
            failureCode = action.name.lowercase(),
            failureMessage = "Offline ${offlineFor.toMinutes()}m, no playback progress for ${progressStaleFor.toMinutes()}m; attempting ${action.name.lowercase()}",
        )
        when (action) {
            // Re-show cached content locally; this never contacts the unavailable server.
            OfflineAction.VERIFY_FALLBACK -> recalculateSchedule()
            OfflineAction.RESTART_ACTIVITY -> reliabilityController.restartActivity()
            OfflineAction.RESTART_PROCESS -> { prefs.edit().putLong("offline-restart-process-at", now).commit(); reliabilityController.restartProcess() }
            OfflineAction.NONE -> {}
        }
    }

    private fun recordReliabilityEvent(eventType: String, severity: String, result: String = "unknown", failureCode: String = "", failureMessage: String = "") {
        runCatching {
            activityQueue.record(
                eventType = eventType,
                severity = severity,
                result = result,
                failureCode = failureCode,
                failureMessage = failureMessage,
                manifestVersion = activeManifestVersion,
                priority = 2,
            )
        }
    }

    private suspend fun verifyAfterAuthFailure(url: String, name: String, credential: String, epoch: Long) {
        if (!connectionEpoch.isCurrent(epoch)) return
        try { api.heartbeat(url, credential, heartbeat()); if (connectionEpoch.isCurrent(epoch)) scheduleReconnect(url, name, credential, 1, "Connection interrupted", epoch) }
        catch (error: CancellationException) { throw error }
        catch (error: ApiException) { if (!connectionEpoch.isCurrent(epoch)) return; if (error.code == "device_credential_revoked" || error.code == "device_credential_invalid") revokeLocally(name) else emit(PlayerEvent.Disconnected(name, error.message)) }
        catch (_: Exception) { if (connectionEpoch.isCurrent(epoch)) scheduleReconnect(url, name, credential, 1, "Connection interrupted", epoch) }
    }

    private fun stopConnectionWork() {
        connectionEpoch.invalidate()
        val activeSocket = socket
        socket = null
        activeSocket?.cancel()
        reconnectJob?.cancel(); reconnectJob = null
        pairingJob?.cancel(); pairingJob = null
		pairingRequestJob?.cancel(); pairingRequestJob = null
        manifestPollJob?.cancel(); manifestPollJob = null
        configPollJob?.cancel(); configPollJob = null
        syncRetryJob?.cancel(); syncRetryJob = null
        syncJob?.cancel(); syncJob = null
        commandRetryJob?.cancel(); commandRetryJob = null
        pendingActivationJob?.cancel(); pendingActivationJob = null
    }

    // Activity restarts can overlap the creation of the replacement Activity. Close the
    // socket before launching that replacement so an in-flight OkHttp upgrade from this
    // ViewModel cannot win the server's single-screen presence slot after the new player has
    // connected. onCleared covers normal Activity/process teardown as well.
    fun shutdownForRestart() { stopConnectionWork() }

    override fun onCleared() {
        stopConnectionWork()
        super.onCleared()
    }

    private fun clearPlaybackState() {
        mutableContent.value = null
        mutableNoContentKnown.value = false
        mutableUnavailableKnown.value = false
        mutableNoContentLogoPath.value = null
        pendingContent = null
        scheduleContent = null
        scheduleJob?.cancel(); scheduleJob = null
        takeoverJob?.cancel(); takeoverJob = null
        activeTakeoverId = null
        takeoverState = null
        playbackRetryJob?.cancel(); playbackRetryJob = null
        activeManifestVersion = null
        currentScheduleId = null
        currentPlaylistId = null
        currentItemId = null
        currentAssetId = null
		playbackCheckpoint.edit().clear().apply()
		// A later pairing must not answer its first manifest request with the old
		// installation's ETag after the playback session has been discarded.
		synchronizer.invalidateActiveCacheVerification()
    }
	private suspend fun clearPlayerConfigState() { configManager.clear(); mutablePlayerConfig.value = null; activeConfigRevision = null; configurationError = null }
	private suspend fun revokeLocally(screenName: String?) { stopConnectionWork(); clearPlaybackState(); synchronizer.clear(); clearPlayerConfigState(); credentials.clear(); configuration.clearPairing(); emit(PlayerEvent.Revoked(screenName)) }
    fun reconnectAfterRevocation() { viewModelScope.launch { stopConnectionWork(); clearPlaybackState(); synchronizer.clear(); clearPlayerConfigState(); credentials.clear(); configuration.clearPairing(); selectedIdentity?.let { emit(PlayerEvent.IdentityConfirmed(selectedUrl ?: return@launch, it)) } ?: discover() } }
    fun cancelPairing() { pairingJob?.cancel(); pairingJob = null; pairingRequestJob?.cancel(); pairingRequestJob = null; viewModelScope.launch { current?.let { current = configuration.clearPairingSession(it) }; discover() } }
    fun resetServer() { viewModelScope.launch { stopConnectionWork(); clearPlaybackState(); credentials.clear(); WebsiteDataManager.clear(getApplication()){}; synchronizer.clear(); clearPlayerConfigState(); configuration.reset(); current = configuration.getOrCreate(); discover() } }

	private suspend fun reconcileManifest(url: String, credential: String) {
		if (syncJob?.isActive == true) { syncPending = true; return }
		syncRetryJob?.cancel(); syncRetryJob = null
		syncJob = viewModelScope.launch {
			do {
				syncPending = false
				val screenId = current?.screenId ?: return@launch
				try {
					// Judge success by errors reported during this pass: a 304 never invokes the
					// progress callback, so a stale error from an earlier failure must not count.
					var reportedError: String? = null
					val prepared = synchronizer.reconcile(url, credential, screenId, { syncProgress = it; reportedError = it.error }, selectedIdentity?.installationId)
					if (reportedError == null) { syncFailureCount = 0; if (syncProgress.error != null) syncProgress = syncProgress.copy(error = null); getApplication<Application>().getSharedPreferences("tilecast-reliability",Application.MODE_PRIVATE).edit().putLong("last-successful-sync-at",System.currentTimeMillis()).apply() } else scheduleSyncRetry(url, credential)
					if (prepared != null) {
						val takeoverChanged=prepared.manifest.effectiveTakeover?.id!=activeTakeoverId
						val presentationChanged=prepared.manifest.presentationOverride?.id!=mutableContent.value?.content?.manifest?.presentationOverride?.id
						// A root-Layout session never reports playlist boundaries, so waiting
						// for one would leave the new manifest pending forever.
						val boundaryless=mutableContent.value?.content?.manifest?.layout!=null
						if (presentationChanged || shouldActivateManifestImmediately(mutableContent.value != null, takeoverChanged, boundaryless, prepared.manifest.syncGroup != null)) activatePrepared(prepared, url, credential) else { pendingContent = prepared; schedulePendingActivationFallback(url, credential) }
					}
					refreshCommissioning()
				}
					catch(error:CancellationException){throw error}
					catch(error:Exception){syncProgress=SyncProgress(cacheUsedBytes=syncProgress.cacheUsedBytes,error=error.message?:"Manifest synchronization failed");scheduleSyncRetry(url,credential)}
			} while (syncPending)
		}
		syncJob?.join()
	}

	// A transiently failed sync retries with bounded backoff instead of waiting for the next
	// periodic poll; any fresh trigger (push, poll, command) cancels and supersedes the retry.
	private fun scheduleSyncRetry(url: String, credential: String) {
		syncFailureCount = (syncFailureCount + 1).coerceAtMost(5)
		syncRetryJob?.cancel()
		syncRetryJob = viewModelScope.launch { delay((15_000L shl (syncFailureCount - 1)).coerceAtMost(240_000L)); syncRetryJob = null; reconcileManifest(url, credential) }
	}

	// Boundary reports come from item transitions; if none arrives (an item wedged mid-play,
	// or a very long video), the prepared manifest is force-activated after a grace period so
	// a content update can never sit undelivered indefinitely.
	private fun schedulePendingActivationFallback(url: String, credential: String) {
		pendingActivationJob?.cancel()
		val graceMillis = pendingActivationDelayMillis(pendingContent?.manifest?.activationGraceSeconds ?: 30)
		pendingActivationJob = viewModelScope.launch { delay(graceMillis); pendingActivationJob = null; val pending = pendingContent ?: return@launch; activatePrepared(pending, url, credential) }
	}

	private suspend fun activatePrepared(prepared: PreparedContent, url: String, credential: String) {
		synchronizer.activate(prepared)
		activeManifestVersion=prepared.manifest.manifestVersion
		clockOffsetSeconds=prepared.serverClockOffsetSeconds
		pendingContent = null
		pendingActivationJob?.cancel(); pendingActivationJob = null
		activateScheduleSelection(prepared,url,credential)
		syncProgress = SyncProgress(cacheUsedBytes = syncProgress.cacheUsedBytes)
	}

	private fun activateScheduleSelection(prepared:PreparedContent,url:String,credential:String){
		scheduleContent=prepared
		mutableNoContentKnown.value=true
		mutableNoContentLogoPath.value=prepared.manifest.branding?.logoVariantId?.let { prepared.localFiles[it] }
		scheduleJob?.cancel();takeoverJob?.cancel()
		val contentNow=serverClock.now()
		val effectiveManifest=prepared.manifest.withAvailablePlaylistItems(contentNow)
		val effectivePrepared=PreparedContent(effectiveManifest,prepared.localFiles,prepared.serverClockOffsetSeconds,prepared.serverClockOffsetMillis,prepared.projectionManifest)
		val takeover=TakeoverController.evaluate(contentNow,effectiveManifest.effectiveTakeover,true)
		val quickOverride=effectiveManifest.presentationOverride.takeIf { !takeover.active }
		val selection=ScheduleEngine.resolve(contentNow,effectiveManifest.schedules,effectiveManifest.directFallbackPlaylist?.id?:effectiveManifest.playlist?.id,effectiveManifest.directFallbackLayout?.id?:effectiveManifest.layout?.id,quickOverride)
		val quickPresent=selection.source=="quick_present"
		val available=effectiveManifest.playlists+listOfNotNull(effectiveManifest.directFallbackPlaylist,effectiveManifest.playlist)
		var playlist=available.firstOrNull{it.id==(takeover.playlistId?:selection.playlistId)}
		val availableLayouts=effectiveManifest.layouts+listOfNotNull(effectiveManifest.directFallbackLayout,effectiveManifest.layout)
		var layout=if(takeover.active||selection.source=="quick_present"&&selection.playlistId!=null)null else availableLayouts.firstOrNull{it.id==selection.layoutId}
		currentScheduleId=selection.scheduleId;currentPlaylistId=selection.playlistId;assignedPlaylistId=prepared.manifest.directFallbackPlaylist?.id;selectionSource=selection.source;nextTransition=selection.nextTransition;scheduleError=selection.error
		if(takeover.active){activeTakeoverId=prepared.manifest.effectiveTakeover?.id;activePresentationOverrideId=null;takeoverState="active";currentScheduleId=null;currentPlaylistId=playlist?.id;selectionSource="takeover";nextTransition=takeover.nextTransition}else{activeTakeoverId=null;activePresentationOverrideId=if(selection.source=="quick_present")effectiveManifest.presentationOverride?.id else null;takeoverState=null}
		evaluateActiveHours()
		if(selection.source=="schedule"&&(playlist==null||playlist.items.isEmpty())&&layout==null){playlist=effectiveManifest.directFallbackPlaylist?.takeIf{it.items.isNotEmpty()};layout=effectiveManifest.directFallbackLayout;currentPlaylistId=playlist?.id;selectionSource=if(playlist!=null||layout!=null)"direct_fallback" else "none";scheduleError="Scheduled presentation is unavailable"}
		val hasAssignedPresentation = selection.playlistId != null || selection.layoutId != null || takeover.active || quickPresent || effectiveManifest.directFallbackPlaylist != null || effectiveManifest.directFallbackLayout != null
		mutableUnavailableKnown.value = (hasAssignedPresentation && playlist == null && layout == null) || (hasAssignedPresentation && playlist != null && playlist.items.isEmpty())
		val selected=effectivePrepared.copy(manifest=effectiveManifest.copy(playlist=playlist,layout=layout))
		val anchor=if(takeover.active)effectiveManifest.effectiveTakeover?.activatedAt?.let{runCatching{Instant.parse(it)}.getOrNull()} else selection.playbackAnchor?:effectiveManifest.syncGroup?.playbackEpoch?.let{runCatching{Instant.parse(it)}.getOrNull()}
		val synchronizedStart=if(effectiveManifest.syncGroup!=null&&playlist!=null&&anchor!=null)synchronizedPlaybackStart(playlist,effectiveManifest.assets,anchor,contentNow)else null
		val resumedCursor = if (synchronizedStart == null && resumeCheckpointPending) resumeCursorFor(playlist) else null
		resumeCheckpointPending = false
			mutableContent.value=if((mutablePlaybackDisabled.value||!mutableActiveHours.value||mutableSafeMode.value)&&!takeover.active&&!quickPresent)null else if(playlist?.items?.isNotEmpty()==true||layout!=null)PlaybackSession(content=selected,serverUrl=url,credential=credential,initialCursor=synchronizedStart?.cursor?:resumedCursor?:org.tilecast.player.content.PlaybackCursor(0,0),initialOffsetMs=synchronizedStart?.offsetMs?:0,playbackAnchor=anchor,playbackDefaults=mutablePlayerConfig.value?.playback,websitePolicy=mutablePlayerConfig.value?.website)else null
			getApplication<Application>().getSharedPreferences("tilecast-reliability",Application.MODE_PRIVATE).edit().putLong("last-playlist-transition-at",System.currentTimeMillis()).putBoolean("cached-fallback-available",(prepared.manifest.directFallbackPlaylist?.items?.isNotEmpty()==true||prepared.manifest.directFallbackLayout!=null)&&prepared.localFiles.isNotEmpty()).apply();refreshCommissioning()
		val contentTransition=prepared.manifest.nextAvailabilityTransition(contentNow)
		listOfNotNull(selection.nextTransition,contentTransition).minOrNull()?.let{transition->scheduleJob=viewModelScope.launch{delay(Duration.between(serverClock.now(),transition).toMillis().coerceAtLeast(0)+50);scheduleContent?.let{activateScheduleSelection(it,url,credential)}}}
		takeover.nextTransition?.let{transition->takeoverJob=viewModelScope.launch{delay(Duration.between(serverClock.now(),transition).toMillis().coerceAtLeast(0)+50);scheduleContent?.let{activateScheduleSelection(it,url,credential)}}}
	}

	private suspend fun runCommands(url:String,credential:String){
		commandRetryJob?.cancel(); commandRetryJob = null
		var pollFailed=false
		val failed:(String)->Unit={code->pollFailed=true;recordCommandPollFailure(code)}
		runCommandPollSafely(
			poll={commandCoordinator.fetchAndRun(url,credential,onOperationFailure=failed){command->
		lastCommandId=command.id;lastCommandState="running"
		val outcome=when(command.type){
			"sync_now"->{reconcileManifest(url,credential);CommandOutcome(true,"manifest_sync_started","Manifest synchronization started")}
			"reload_playback"->{val active=mutableContent.value;mutableContent.value=null;delay(100);mutableContent.value=active;CommandOutcome(true,"playback_reloaded","Playback reloaded")}
			"identify_screen"->{val seconds=command.payload["durationSeconds"]?.jsonPrimitive?.content?.toIntOrNull()?:30;val location=mutablePlayerConfig.value?.playback?.takeIf{it.identifyShowsLocation}?.screenLocation.orEmpty();mutableIdentify.value="${current?.screenName ?: "Tilecast screen"}${if(location.isNotEmpty())"\n$location" else ""}\n${current?.screenId?.takeLast(8).orEmpty()}";viewModelScope.launch{delay(seconds*1000L);mutableIdentify.value=null};CommandOutcome(true,"screen_identified","Identification overlay displayed")}
			"clear_media_cache"->{val success=synchronizer.clearUnprotectedCache();reconcileManifest(url,credential);CommandOutcome(success,if(success)"cache_cleared" else "cache_cleanup_partial",if(success)"Unprotected media cache cleared" else "Some protected content was retained")}
			"clear_website_data"->{var success=false;WebsiteDataManager.clear(getApplication()){success=it};delay(250);CommandOutcome(success,if(success)"website_data_cleared" else "website_data_clear_failed",if(success)"Website data cleared" else "Website data could not be cleared")}
			"disable_playback"->{commandCoordinator.setPlaybackDisabled(true);mutablePlaybackDisabled.value=true;scheduleContent?.let{activateScheduleSelection(it,url,credential)};CommandOutcome(true,"playback_disabled","Playback disabled")}
			"enable_playback"->{commandCoordinator.setPlaybackDisabled(false);mutablePlaybackDisabled.value=false;scheduleContent?.let{activateScheduleSelection(it,url,credential)};CommandOutcome(true,"playback_enabled","Playback enabled")}
			"install_player_update"->updateManager.prepare(url,credential,command,{activeTakeoverId!=null||!mutableActiveHours.value}){mutableUpdate.value=it}
			"retry_player_recovery"->{reliabilitySupervisor.exitSafeMode();reliabilityController.setSafeMode(false);mutableSafeMode.value=false;reconcileManifest(url,credential);CommandOutcome(true,"player_recovery_retried","Player recovery was retried")}
			"exit_safe_mode"->{reliabilitySupervisor.exitSafeMode();reliabilityController.setSafeMode(false);mutableSafeMode.value=false;scheduleContent?.let{activateScheduleSelection(it,url,credential)};CommandOutcome(true,"safe_mode_exited","Safe mode was cleared")}
			"power_assist_sleep"->{if(activeTakeoverId!=null)CommandOutcome(false,"power_assist_deferred_takeover","Power Assist sleep was delayed by takeover playback")else{val result=reliabilityController.requestSleep();CommandOutcome(true,result,"Power Assist sleep request was sent to Android")}}
				"power_assist_wake"->{val result=reliabilityController.requestWake();CommandOutcome(true,result,"Power Assist wake request was sent to Android")}
				"retry_current_item"->{retryCurrentItem();CommandOutcome(true,"current_item_retried","Current item was restarted")}
				"skip_current_item"->{skipCurrentItem();CommandOutcome(true,"current_item_skipped","Player advanced to the next item")}
				"recreate_renderer"->{recreateRenderer();CommandOutcome(true,"renderer_recreated","Playback renderer was recreated")}
				"recreate_playback_session"->{recreatePlaybackSession();CommandOutcome(true,"playback_session_recreated","Playback session was recreated")}
				"restart_activity"->{reliabilityController.restartActivity();CommandOutcome(true,"activity_restart_requested","Player activity restart was requested")}
				"restart_player_process"->{viewModelScope.launch{delay(1500);reliabilityController.restartProcess()};CommandOutcome(true,"process_restart_requested","Controlled player process restart was requested")}
				"resynchronize_player"->{reconcileManifest(url,credential);reconcilePlayerConfig(url,credential);CommandOutcome(true,"player_resynchronized","Manifest and configuration synchronization completed")}
				"run_player_self_test"->{val result=runSelfTest();CommandOutcome(result=="passed","player_self_test_$result",if(result=="passed")"Player self-test passed" else "Player self-test completed with warnings")}
			else->CommandOutcome(false,"command_unsupported","Command is not supported")}
		lastCommandState=if(outcome.success)"succeeded" else "failed";lastCommandResult=outcome.code;lastCommandCompletedAt=Instant.now().toString();outcome
		}},
			onFailure={failed(it)},
			onCredentialRejected={pollFailed=false;revokeLocally(current?.screenName)},
		)
		// A command left undelivered by a transient failure retries with bounded backoff so it
		// cannot sit until the next push or reconnect; any fresh trigger supersedes the retry.
		if(pollFailed){
			commandFailureCount=(commandFailureCount+1).coerceAtMost(5)
			commandRetryJob?.cancel()
			commandRetryJob=viewModelScope.launch{delay((15_000L shl (commandFailureCount-1)).coerceAtMost(240_000L));commandRetryJob=null;runCommands(url,credential)}
		} else commandFailureCount=0
	}
	private fun recordCommandPollFailure(code:String){lastCommandState="poll_failed";lastCommandResult=code;lastCommandCompletedAt=Instant.now().toString()}
		private suspend fun reconcilePlayerConfig(url:String,credential:String){try{configManager.reconcile(url,credential,selectedIdentity?.installationId,current?.screenId)?.let{mutablePlayerConfig.value=it;applyPlayerConfig(it)};configurationError=null}catch(error:CancellationException){throw error}catch(_:Exception){configurationError="Player configuration could not be applied"}}
	private fun applyPlayerConfig(config:PlayerConfig){activeConfigRevision=config.configRevision;synchronizer.applyPolicy(config.cache.maximumBytes,config.cache.minimumFreeBytes,config.cache.automaticThresholdBytes,config.cache.concurrentDownloads);if(WebsiteStartupClearGate.shouldClear(config.website.clearOnRestart))WebsiteDataManager.clear(getApplication()){};reliabilitySupervisor=ReliabilitySupervisor(config.reliability.maximumProcessRestarts,Duration.ofMinutes(config.reliability.restartWindowMinutes.toLong()),config.reliability.safeModeEnabled,PreferencesRecoveryStateStore(getApplication()));getApplication<Application>().getSharedPreferences("tilecast-reliability",Application.MODE_PRIVATE).edit().putBoolean("launch-after-boot",config.reliability.launchAfterBoot).putBoolean("accessibility-enabled-by-policy",config.accessibility.controlAssistEnabled).putBoolean("report-foreground-package",config.accessibility.reportForegroundPackage).putBoolean("pause-accessibility-during-updates",config.accessibility.pauseDuringUpdates).putBoolean("pause-accessibility-during-admin",config.accessibility.pauseDuringAdminSession).putInt("return-delay",config.accessibility.returnDelaySeconds).putInt("maximum-returns",config.accessibility.maximumReturns).putInt("return-window",config.accessibility.returnWindowMinutes).putStringSet("allowed-packages",config.accessibility.allowedPackages.toSet()).apply();mutableContent.value=mutableContent.value?.copy(playbackDefaults=config.playback,websitePolicy=config.website,runtimeActivation=nextRuntimeActivationIdentity());mutableSafeMode.value=reliabilitySupervisor.safeMode;evaluateActiveHours();refreshCommissioning() }
	private fun evaluateActiveHours(){val config=mutablePlayerConfig.value?:return;val rule=ActiveHoursRule(config.power.activeHoursEnabled,config.power.activeHoursTimezone,config.power.activeHoursDays.map{DayOfWeek.of(it)}.toSet(),LocalTime.parse(config.power.activeHoursStart),LocalTime.parse(config.power.activeHoursEnd));val overrideActive=activePresentationOverrideId!=null;val now=serverClock.now();val result=runCatching{ActiveHoursEngine.evaluate(now,rule,activeTakeoverId!=null||overrideActive)}.getOrNull()?:return;activeHoursNextTransition=result.nextTransition;val changed=mutableActiveHours.value!=result.active;mutableActiveHours.value=result.active;if(changed&&result.active)reliabilityController.requestWake();if(changed&&!result.active&&config.power.sleepOutsideActiveHours&&activeTakeoverId==null&&!overrideActive)reliabilityController.requestSleep();if(!result.active&&activeTakeoverId==null&&!overrideActive)mutableContent.value=null else if(changed){val url=current?.serverUrl;val credential=credentials.read();if(url!=null&&credential!=null)scheduleContent?.let{activateScheduleSelection(it,url,credential)}};powerJob?.cancel();result.nextTransition?.let{next->if(!result.active&&!overrideActive)reliabilityController.scheduleWake(next.minusSeconds(config.power.startupGraceSeconds.toLong()));powerJob=viewModelScope.launch{delay(Duration.between(serverClock.now(),next).toMillis().coerceAtLeast(0)+100);evaluateActiveHours()}}}

		fun playbackBoundary(itemId: String, assetId: String) {
			currentItemId=itemId;currentAssetId=assetId
			mutableContent.value?.content?.manifest?.playlist?.let { playlist ->
				playbackCheckpoint.edit().putString("playlist-id", playlist.id).putLong("playlist-revision", playlist.revision).putString("item-id", itemId).apply()
			}
			recordPlaybackProgress()
		val pending=pendingContent ?: return
		val url=current?.serverUrl ?: return;val credential=credentials.read() ?: return
		viewModelScope.launch { activatePrepared(pending,url,credential) }
		}
		private fun resumeCursorFor(playlist:org.tilecast.player.network.ManifestPlaylist?):org.tilecast.player.content.PlaybackCursor? {
			if (playlist == null || mutablePlayerConfig.value?.playback?.resumeAfterRestart != true) return null
			if (playbackCheckpoint.getString("playlist-id", null) != playlist.id || playbackCheckpoint.getLong("playlist-revision", -1L) != playlist.revision) return null
			val itemId = playbackCheckpoint.getString("item-id", null) ?: return null
			val index = playlist.items.indexOfFirst { it.id == itemId }
			return index.takeIf { it >= 0 }?.let { org.tilecast.player.content.PlaybackCursor(it, 0) }
		}
		fun playbackError(message:String){lastPlaybackError=message;lastWatchdogFailure=message;executeRecovery(reliabilitySupervisor.recordFailure())}
	fun websitePlaybackStatus(status:WebsitePlaybackStatus){
		websiteStatus=status
		if(status.assetId!=null&&status.state in setOf("loading","refreshing")) lastPlaybackProgressAt=Instant.now()
		if(status.state=="loaded") recordPlaybackProgress()
	}
		fun widgetPlaybackStatus(status:WidgetPlaybackStatus){widgetStatus=status}
	/** Re-advertises capabilities when the component probe passes.
	 *
	 * The first capability heartbeat leaves before the playback WebView
	 * exists, so a fresh process initially reports schema 1. A late probe
	 * pass re-sends the heartbeat with the proven schemas/capabilities
	 * and reconciles content, so a component-only assignment stops
	 * waiting for capabilities the player already has. Acts only on the
	 * false-to-true transition; renderer-death re-probes re-report the
	 * same pass without restarting playback.
	 */
	private var lastAdvertisedProbePassed=false
	fun onComponentProbeDone(passed:Boolean){
		if(!passed||passed==lastAdvertisedProbePassed)return
		lastAdvertisedProbePassed=passed
		val url=current?.serverUrl?:return;val credential=credentials.read()?:return
		viewModelScope.launch{runCatching{api.heartbeat(url,credential,heartbeat())}}
		scheduleContent?.let{activateScheduleSelection(it,url,credential)}
	}
		fun recalculateSchedule(){evaluateActiveHours();val prepared=scheduleContent?:return;val url=current?.serverUrl?:return;val credential=credentials.read()?:return;activateScheduleSelection(prepared,url,credential)}
		fun refreshCommissioning(){val cached=getApplication<Application>().getSharedPreferences("tilecast-reliability",Application.MODE_PRIVATE).getBoolean("cached-fallback-available",false);mutableCommissioning.value=commissioningController.status(current?.screenId,cached)}
		fun setCommissioningPin(pin:CharArray){commissioningController.setPin(pin);refreshCommissioning()}
		fun advanceCommissioning(){val screen=current?.screenId?:return;commissioningController.advance(screen,mutableCommissioning.value.step);refreshCommissioning()}
		fun completeCommissioning(){viewModelScope.launch{val saved=configuration.getOrCreate();current=saved;val screen=saved.screenId?:return@launch;commissioningController.complete(screen);refreshCommissioning();socket?.send(Json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(),statusMessage()));lastStatusSentAt=System.currentTimeMillis();val url=saved.serverUrl;val credential=credentials.read();if(url!=null&&credential!=null)runCatching{api.heartbeat(url,credential,heartbeat())}}}
		fun runSetupAgain(){val screen=current?.screenId?:return;commissioningController.runAgain(screen);refreshCommissioning()}
		fun runSelfTest():String {val screen=current?.screenId?:return "not_paired";val result=commissioningController.runSelfTest(screen);refreshCommissioning();return result}
		private fun recordPlaybackProgress(){val now=Instant.now();lastPlaybackProgressAt=now;val prefs=getApplication<Application>().getSharedPreferences("tilecast-reliability",Application.MODE_PRIVATE);prefs.edit().putLong("last-playback-progress-at",now.toEpochMilli()).apply();if(reliabilitySupervisor.recordHealthy(now)){recoveryCount=0;recoveryLevel=0;lastPlaybackError=null};prefs.edit().putLong("last-healthy-playback-at",now.toEpochMilli()).apply()}
		fun playbackProgress() = recordPlaybackProgress()
		private fun retryCurrentItem(){val active=mutableContent.value?:return;playbackRetryJob?.cancel();playbackRetryJob=viewModelScope.launch{mutableContent.value=null;delay(100);if(mutableContent.value==null&&mutableActiveHours.value&&!mutablePlaybackDisabled.value&&!mutableSafeMode.value)mutableContent.value=active};recordPlaybackProgress()}
		private fun skipCurrentItem(){val active=mutableContent.value?:return;val playlist=active.content.manifest.playlist?:return;if(playlist.items.isEmpty())return;val index=playlist.items.indexOfFirst{it.id==currentItemId}.takeIf{it>=0}?:0;val next=(index+1)%playlist.items.size;val items=playlist.items.drop(next)+playlist.items.take(next);mutableContent.value=active.copy(content=active.content.copy(manifest=active.content.manifest.copy(playlist=playlist.copy(items=items))),runtimeActivation=nextRuntimeActivationIdentity());recordPlaybackProgress()}
		private fun recreateRenderer()=retryCurrentItem()
		private fun recreatePlaybackSession(){val prepared=scheduleContent?:return;val url=current?.serverUrl?:return;val credential=credentials.read()?:return;activateScheduleSelection(prepared,url,credential);recordPlaybackProgress()}
		private fun executeRecovery(decision:RecoveryDecision){recoveryLevel=decision.level.ordinal+1;recoveryCount=decision.recoveryCount;lastWatchdogRecoveryAt=Instant.now();when(decision.level){RecoveryLevel.RETRY->retryCurrentItem();RecoveryLevel.SKIP_ITEM->skipCurrentItem();RecoveryLevel.RECREATE_RENDERER->recreateRenderer();RecoveryLevel.RECREATE_CONTROLLER->recreatePlaybackSession();RecoveryLevel.RESTART_ACTIVITY->reliabilityController.restartActivity();RecoveryLevel.RESTART_PROCESS->viewModelScope.launch{delay(500);reliabilityController.restartProcess()};RecoveryLevel.SAFE_MODE->{mutableSafeMode.value=true;reliabilityController.setSafeMode(true);mutableContent.value=null}}}
	private fun startWatchdog(){watchdogJob?.cancel();watchdogJob=viewModelScope.launch{while(true){delay(10_000);val config=mutablePlayerConfig.value?.reliability?:continue;if(!config.foregroundWatchdogEnabled||mutableContent.value==null||mutableSafeMode.value)continue;if(widgetStatus.widgetId!=null)continue;val websitePending=websiteStatus.assetId!=null&&websiteStatus.state in setOf("loading","refreshing");val last=lastPlaybackProgressAt?:Instant.now().also{lastPlaybackProgressAt=it};val threshold=org.tilecast.player.content.watchdogThresholdSeconds(config,websitePending);if(Duration.between(last,Instant.now()).seconds>threshold){lastPlaybackProgressAt=Instant.now();playbackError(if(websitePending)"webview_stalled" else "playback_stalled")}}}}
		fun openUpdatePermission(){updateManager.openPermissionSettings()}
	fun refreshUpdatePermission(){mutableUpdate.value?.let{state->val changed=updateManager.installerFailure(state)?:updateManager.permissionGranted(state);changed?.let{updated->mutableUpdate.value=updated;val url=current?.serverUrl;val credential=credentials.read();if(updated.state=="failed"&&url!=null&&credential!=null)scheduleContent?.let{activateScheduleSelection(it,url,credential)};if(url!=null&&credential!=null)viewModelScope.launch{runCatching{api.updateStatus(url,credential,updated.deploymentId,updated.state,updated.downloadedBytes,if(updated.permissionRequired)"required" else "granted",error=if(updated.state=="failed")updated.errorCode?:"installer_failed" else "")}}}}}
	fun resumeUpdateSchedule(){val state=mutableUpdate.value?:return;val url=current?.serverUrl?:return;val credential=credentials.read()?:return;updateManager.resumeMaintenance(url,credential,state,{activeTakeoverId!=null}){mutableUpdate.value=it}}
	fun installUpdate(){mutableUpdate.value?.let{state->if(updateManager.install(state)){mutableContent.value=null;val installing=state.copy(state="installing",message="Complete installation in the Android prompt");mutableUpdate.value=installing;val url=current?.serverUrl;val credential=credentials.read();if(url!=null&&credential!=null)viewModelScope.launch{runCatching{api.updateStatus(url,credential,state.deploymentId,"installing",state.downloadedBytes,"granted","system_installer_started")}}}}}

    private fun deviceMetadata(playerId: String): DeviceMetadata { val metrics = getApplication<Application>().resources.displayMetrics; return DeviceMetadata(playerId, if (Build.MANUFACTURER.equals("Amazon", true)) "fire-tv" else "android-tv", Build.MANUFACTURER ?: "Unknown", Build.MODEL ?: "Unknown", Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString(), BuildConfig.VERSION_NAME, metrics.widthPixels, metrics.heightPixels, metrics.density, Locale.getDefault().toLanguageTag(), TimeZone.getDefault().id) }
	private fun heartbeat(): HeartbeatRequest { val app = getApplication<Application>(); val metrics = app.resources.displayMetrics;val update=mutableUpdate.value;val prefs=app.getSharedPreferences("tilecast-reliability",Application.MODE_PRIVATE);val configured=mutablePlayerConfig.value?.reliability?.mode?:"standard";val effective=prefs.getString("effective-mode","standard");val maintenance=reliabilityController.maintenanceUntil();val commissioning=mutableCommissioning.value;val boot=BootRecovery.status(app);val storedInstant:(String)->String?={key->prefs.getLong(key,0).takeIf{it>0}?.let{Instant.ofEpochMilli(it).toString()}}; val runtimeSupport=org.tilecast.player.runtime.RuntimeSupportAssessment.assess(componentProbePassed=org.tilecast.player.runtime.RuntimeComponentProbe.passed); val supportSchemas=org.tilecast.player.runtime.RuntimeSupportAssessment.schemasFor(runtimeSupport); val supportNative=org.tilecast.player.runtime.RuntimeSupportAssessment.nativeCapabilitiesFor(runtimeSupport); return HeartbeatRequest(metrics.widthPixels, metrics.heightPixels, app.filesDir.usableSpace, SystemClock.elapsedRealtime() / 1000, BuildConfig.VERSION_NAME,playerVersionCode=BuildConfig.VERSION_CODE.toLong(),androidSdk=Build.VERSION.SDK_INT,installerSource=if(Build.VERSION.SDK_INT>=30)app.packageManager.getInstallSourceInfo(app.packageName).installingPackageName else null,installPermissionStatus=if(Build.VERSION.SDK_INT<26||app.packageManager.canRequestPackageInstalls())"granted" else "required",presentationSchemaVersions=supportSchemas,nativePresentationCapabilities=supportNative,activeManifestVersion=activeManifestVersion,pendingManifestVersion=pendingContent?.manifest?.manifestVersion,assignedPlaylistId=assignedPlaylistId,currentItemId=currentItemId,currentAssetId=currentAssetId,playbackState=if(mutableContent.value!=null)"playing" else if(mutableSafeMode.value)"safe_mode" else if(!mutableActiveHours.value)"off_hours" else if(mutablePlaybackDisabled.value)"disabled" else "idle",downloadQueueCount=syncProgress.queueCount,downloadedBytes=syncProgress.downloadedBytes,requiredBytes=syncProgress.requiredBytes,cacheUsedBytes=syncProgress.cacheUsedBytes,cacheLimitBytes=mutablePlayerConfig.value?.cache?.maximumBytes?:BuildConfig.MEDIA_CACHE_BYTES,lastSynchronizationError=syncProgress.error,lastPlaybackError=lastPlaybackError,currentScheduleId=currentScheduleId,currentPlaylistId=currentPlaylistId,selectionSource=selectionSource,nextTransitionAt=nextTransition?.toString(),deviceClockOffsetSeconds=clockOffsetSeconds,scheduleEvaluationError=scheduleError,scheduleManifestVersion=activeManifestVersion,currentWebsiteAssetId=websiteStatus.assetId,websiteState=websiteStatus.state,websiteLoadStartedAt=websiteStatus.loadStartedAt,websiteLoadCompletedAt=websiteStatus.loadCompletedAt,websiteFailureCategory=websiteStatus.failureCategory,websiteBlockedNavigationCount=websiteStatus.blockedNavigationCount,websiteCurrentHost=websiteStatus.currentHost,websiteFallbackShown=websiteStatus.fallbackShown,websiteRendererRecoveryCount=websiteStatus.rendererRecoveryCount,currentWidgetId=widgetStatus.widgetId,widgetProvider=widgetStatus.provider,widgetState=widgetStatus.state,widgetError=widgetStatus.error,activeTakeoverId=activeTakeoverId,takeoverState=takeoverState,takeoverPreparationProgress=if(takeoverState=="active")100 else null,playbackDisabled=mutablePlaybackDisabled.value,lastCommandId=lastCommandId,lastCommandState=lastCommandState,lastCommandResult=lastCommandResult,lastCommandCompletedAt=lastCommandCompletedAt,activeConfigRevision=activeConfigRevision,configurationError=configurationError,currentUpdateDeploymentId=update?.deploymentId,updateState=update?.state,updateDownloadedBytes=update?.downloadedBytes,updateExpectedBytes=update?.expectedBytes,configuredReliabilityMode=configured,effectiveReliabilityMode=effective,foregroundState=if(prefs.getBoolean("foreground",false))"foreground" else "background",bootRecoveryResult=boot.result,lastSuccessfulColdBootAt=prefs.getLong("last-cold-boot",0).takeIf{it>0}?.let{Instant.ofEpochMilli(it).toString()},immersiveModeActive=prefs.getBoolean("immersive",false),keepScreenOn=prefs.getBoolean("keep-screen-on",false),managedKioskCapability=reliabilityController.kioskCapability().name.lowercase(),deviceOwnerState=if(reliabilityController.kioskCapability() in listOf(org.tilecast.player.reliability.ManagedKioskCapability.PROVISIONED,org.tilecast.player.reliability.ManagedKioskCapability.LOCK_TASK_ALLOWED,org.tilecast.player.reliability.ManagedKioskCapability.LOCK_TASK_ACTIVE))"provisioned" else "not_provisioned",lockTaskState=if(effective=="managed_kiosk")"active" else "inactive",accessibilityServiceState=if(reliabilityController.accessibilityEnabled())"enabled" else "disabled",activeHoursState=if(mutableActiveHours.value)"active" else "off_hours",sleepCapability=if(reliabilityController.accessibilityEnabled())"accessibility_assisted" else "black_screen_only",lastSleepRequestResult=prefs.getString("last-sleep-result",null),lastWakeResult=prefs.getString("last-wake-result",null),recoveryLevel=recoveryLevel,recoveryCount=recoveryCount,safeMode=mutableSafeMode.value,lastWatchdogFailure=lastWatchdogFailure,lastWatchdogRecoveryAt=lastWatchdogRecoveryAt?.toString(),maintenanceSessionExpiresAt=maintenance?.toString(),commissioningState=if(commissioning.required)"in_progress" else if(commissioning.completedAt!=null)"complete" else "not_started",commissioningStep=commissioning.step.wireValue,commissioningCompletedAt=commissioning.completedAt?.toString(),cachedFallbackAvailable=commissioning.cachedFallbackAvailable,lastHealthyPlaybackAt=storedInstant("last-healthy-playback-at"),lastPlaylistTransitionAt=storedInstant("last-playlist-transition-at"),lastSuccessfulSyncAt=storedInstant("last-successful-sync-at"),lastServerConnectionAt=storedInstant("last-server-connection-at"),bootAttemptCount=boot.attemptCount,bootLastAttemptAt=boot.lastAttemptAt?.toString(),bootLaunchVerified=boot.launchVerified,updateReadiness=if(commissioning.installPermissionGranted&&app.filesDir.usableSpace>(update?.expectedBytes?:0))"ready" else "needs_attention",selfTestResult=commissioning.selfTestResult,selfTestCompletedAt=commissioning.selfTestCompletedAt?.toString()) }
    private fun statusMessage() = kotlinx.serialization.json.buildJsonObject {
		put("type", "player.status")
		put("payload", kotlinx.serialization.json.buildJsonObject {
			val h = heartbeat(); put("screenWidth", h.screenWidth); put("screenHeight", h.screenHeight)
			put("availableStorageBytes", h.availableStorageBytes ?: 0); put("uptimeSeconds", h.uptimeSeconds ?: 0); put("playerVersion", h.playerVersion)
			h.playerVersionCode?.let{put("playerVersionCode",it)};h.androidSdk?.let{put("androidSdk",it)};h.installerSource?.let{put("installerSource",it)};h.installPermissionStatus?.let{put("installPermissionStatus",it)}
			activeManifestVersion?.let { put("activeManifestVersion", it) }; assignedPlaylistId?.let { put("assignedPlaylistId", it) }
			pendingContent?.let { put("pendingManifestVersion", it.manifest.manifestVersion) }; currentItemId?.let { put("currentItemId", it) }; currentAssetId?.let { put("currentAssetId", it) }
			put("playbackState", if (mutableContent.value != null) "playing" else "idle"); put("downloadQueueCount", syncProgress.queueCount); put("downloadedBytes", syncProgress.downloadedBytes); put("requiredBytes", syncProgress.requiredBytes)
			put("cacheUsedBytes", syncProgress.cacheUsedBytes); put("cacheLimitBytes", mutablePlayerConfig.value?.cache?.maximumBytes ?: BuildConfig.MEDIA_CACHE_BYTES); syncProgress.error?.let { put("lastSynchronizationError", it) }; lastPlaybackError?.let { put("lastPlaybackError", it) }
			currentScheduleId?.let{put("currentScheduleId",it)};currentPlaylistId?.let{put("currentPlaylistId",it)};put("selectionSource",selectionSource);nextTransition?.let{put("nextTransitionAt",it.toString())};clockOffsetSeconds?.let{put("deviceClockOffsetSeconds",it)};scheduleError?.let{put("scheduleEvaluationError",it)};activeManifestVersion?.let{put("scheduleManifestVersion",it)}
			websiteStatus.assetId?.let{put("currentWebsiteAssetId",it)};put("websiteState",websiteStatus.state);websiteStatus.loadStartedAt?.let{put("websiteLoadStartedAt",it)};websiteStatus.loadCompletedAt?.let{put("websiteLoadCompletedAt",it)};websiteStatus.failureCategory?.let{put("websiteFailureCategory",it)};put("websiteBlockedNavigationCount",websiteStatus.blockedNavigationCount);websiteStatus.currentHost?.let{put("websiteCurrentHost",it)};put("websiteFallbackShown",websiteStatus.fallbackShown);put("websiteRendererRecoveryCount",websiteStatus.rendererRecoveryCount)
			widgetStatus.widgetId?.let{put("currentWidgetId",it)};widgetStatus.provider?.let{put("widgetProvider",it)};put("widgetState",widgetStatus.state);widgetStatus.error?.let{put("widgetError",it)}
			activeTakeoverId?.let{put("activeTakeoverId",it)};takeoverState?.let{put("takeoverState",it)};if(takeoverState=="active")put("takeoverPreparationProgress",100);put("playbackDisabled",mutablePlaybackDisabled.value);lastCommandId?.let{put("lastCommandId",it)};lastCommandState?.let{put("lastCommandState",it)};lastCommandResult?.let{put("lastCommandResult",it)};lastCommandCompletedAt?.let{put("lastCommandCompletedAt",it)}
			activeConfigRevision?.let{put("activeConfigRevision",it)};configurationError?.let{put("configurationError",it)}
			h.currentUpdateDeploymentId?.let{put("currentUpdateDeploymentId",it)};h.updateState?.let{put("updateState",it)};h.updateDownloadedBytes?.let{put("updateDownloadedBytes",it)};h.updateExpectedBytes?.let{put("updateExpectedBytes",it)};h.updateError?.let{put("updateError",it)}
			h.configuredReliabilityMode?.let{put("configuredReliabilityMode",it)};h.effectiveReliabilityMode?.let{put("effectiveReliabilityMode",it)};h.foregroundState?.let{put("foregroundState",it)};h.bootRecoveryResult?.let{put("bootRecoveryResult",it)};h.lastSuccessfulColdBootAt?.let{put("lastSuccessfulColdBootAt",it)};h.immersiveModeActive?.let{put("immersiveModeActive",it)};h.keepScreenOn?.let{put("keepScreenOn",it)};h.managedKioskCapability?.let{put("managedKioskCapability",it)};h.deviceOwnerState?.let{put("deviceOwnerState",it)};h.lockTaskState?.let{put("lockTaskState",it)};h.accessibilityServiceState?.let{put("accessibilityServiceState",it)};h.activeHoursState?.let{put("activeHoursState",it)};h.sleepCapability?.let{put("sleepCapability",it)};h.lastSleepRequestResult?.let{put("lastSleepRequestResult",it)};h.lastWakeResult?.let{put("lastWakeResult",it)};h.recoveryLevel?.let{put("recoveryLevel",it)};h.recoveryCount?.let{put("recoveryCount",it)};h.safeMode?.let{put("safeMode",it)};h.lastWatchdogFailure?.let{put("lastWatchdogFailure",it)};h.lastWatchdogRecoveryAt?.let{put("lastWatchdogRecoveryAt",it)};h.maintenanceSessionExpiresAt?.let{put("maintenanceSessionExpiresAt",it)}
			// Commissioning, boot and playback-health fields, sent over the socket for
			// the same reason they are sent over HTTP: the HTTP heartbeat runs once per
			// connection, every heartbeat after it is this message, and the server
			// settles a finished self-update from lastHealthyPlaybackAt. Leaving them
			// out left updated screens reading "Installing" forever.
			h.commissioningState?.let{put("commissioningState",it)};h.commissioningStep?.let{put("commissioningStep",it)};h.commissioningCompletedAt?.let{put("commissioningCompletedAt",it)};h.cachedFallbackAvailable?.let{put("cachedFallbackAvailable",it)}
			h.lastHealthyPlaybackAt?.let{put("lastHealthyPlaybackAt",it)};h.lastPlaylistTransitionAt?.let{put("lastPlaylistTransitionAt",it)};h.lastSuccessfulSyncAt?.let{put("lastSuccessfulSyncAt",it)};h.lastServerConnectionAt?.let{put("lastServerConnectionAt",it)}
			h.bootAttemptCount?.let{put("bootAttemptCount",it)};h.bootLastAttemptAt?.let{put("bootLastAttemptAt",it)};h.bootLaunchVerified?.let{put("bootLaunchVerified",it)};h.updateReadiness?.let{put("updateReadiness",it)};h.selfTestResult?.let{put("selfTestResult",it)};h.selfTestCompletedAt?.let{put("selfTestCompletedAt",it)}
			getApplication<Application>().getSharedPreferences("tilecast-reliability",Application.MODE_PRIVATE).getLong("admin-pin-changed-at",0).takeIf{it>0}?.let{put("adminPinChangedAt",Instant.ofEpochMilli(it).toString())}
			val reliabilityPrefs=getApplication<Application>().getSharedPreferences("tilecast-reliability",Application.MODE_PRIVATE);reliabilityPrefs.getLong("last-foreground-exit",0).takeIf{it>0}?.let{put("lastForegroundExitAt",Instant.ofEpochMilli(it).toString())};reliabilityPrefs.getString("last-foreground-package",null)?.let{put("lastForegroundPackage",it)};put("accessibilityReturnAttempts",reliabilityPrefs.getInt("accessibility-return-attempts",0));reliabilityPrefs.getString("accessibility-return-state",null)?.let{put("accessibilityReturnState",it)}
			if(mutablePlayerConfig.value?.accessibility?.controlAssistEnabled==true&&!reliabilityController.accessibilityEnabled())put("accessibilityServiceState","policy_enabled_service_disabled")
			val shutdownPrepare=mutablePlayerConfig.value?.power?.shutdownPrepareSeconds?:0;if(mutableActiveHours.value&&activeHoursNextTransition?.let{Duration.between(serverClock.now(),it).seconds in 0..shutdownPrepare.toLong()}==true)put("activeHoursState","shutdown_preparing")
		})
	}
}
