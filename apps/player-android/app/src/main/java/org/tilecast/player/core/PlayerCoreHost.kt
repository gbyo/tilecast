package org.tilecast.player.core

import android.app.Application
import android.content.Context
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.tilecast.player.BuildConfig
import org.tilecast.player.content.PlayerUpdateManager
import org.tilecast.player.network.TilecastApi
import org.tilecast.player.reliability.ReliabilityController
import org.tilecast.player.security.MigratingCredentialStore

/** Renderer snapshot shared by the native host (bridge contract v3). */
data class CoreRendererStatus(
    val state: String?,
    val connected: Boolean,
    val ready: Boolean,
    val generation: Long?,
    val accepted: Boolean,
    val evidence: Boolean,
    val playing: Boolean,
    val safeMode: Boolean,
    val incompatibleReason: String?,
    val lastError: String?,
    val currentItemId: String?,
) {
    companion object {
        fun parse(root: JsonObject?): CoreRendererStatus? {
            root ?: return null
            return try {
                CoreRendererStatus(
                    state = root.stringOrNull("state"),
                    connected = root["connected"]?.jsonPrimitive?.booleanOrNull == true,
                    ready = root["ready"]?.jsonPrimitive?.booleanOrNull == true,
                    generation = root["generation"]?.jsonPrimitive?.longOrNull,
                    accepted = root["accepted"]?.jsonPrimitive?.booleanOrNull == true,
                    evidence = root["evidence"]?.jsonPrimitive?.booleanOrNull == true,
                    playing = root["playing"]?.jsonPrimitive?.booleanOrNull == true,
                    safeMode = root["safeMode"]?.jsonPrimitive?.booleanOrNull == true,
                    incompatibleReason = root.stringOrNull("incompatibleReason"),
                    lastError = root.stringOrNull("lastError"),
                    currentItemId = root.stringOrNull("currentItemId"),
                )
            } catch (_: Exception) {
                null
            }
        }
    }
}

/**
 * Status snapshot shared by the native host (bridge contract v3). Lenient by
 * design: anything unparseable becomes a failed status, never an exception.
 */
data class CoreHostStatus(
    val ok: Boolean,
    val bridge: Int,
    val stateDb: String?,
    val casDir: String?,
    val paired: Boolean,
    val code: String?,
    val configRevision: Long? = null,
    val linkState: String? = null,
    val linkReason: String? = null,
    val linkExpected: String? = null,
    val linkActual: String? = null,
    val lastServerContactAt: String? = null,
    val renderer: CoreRendererStatus? = null,
    val serverUrl: String? = null,
    val installationId: String? = null,
    val organizationName: String? = null,
    val screenId: String? = null,
    val screenName: String? = null,
    val activeHoursState: String? = null,
    val takeoverActive: Boolean = false,
    val cachedFallbackAvailable: Boolean = false,
    val nextTransitionAt: String? = null,
) {
    companion object {
        fun parse(payload: String?): CoreHostStatus {
            if (payload == null) return CoreHostStatus(false, 0, null, null, false, "null_status")
            return try {
                val root = Json.parseToJsonElement(payload).jsonObject
                CoreHostStatus(
                    ok = root["ok"]?.jsonPrimitive?.booleanOrNull == true,
                    bridge = root["bridge"]?.jsonPrimitive?.intOrNull ?: 0,
                    stateDb = root.stringOrNull("stateDb"),
                    casDir = root.stringOrNull("casDir"),
                    paired = root["paired"]?.jsonPrimitive?.booleanOrNull == true,
                    code = root.stringOrNull("code"),
                    configRevision = root["configRevision"]?.jsonPrimitive?.longOrNull,
                    linkState = root.stringOrNull("linkState"),
                    linkReason = root.stringOrNull("linkReason"),
                    linkExpected = root.stringOrNull("linkExpected"),
                    linkActual = root.stringOrNull("linkActual"),
                    lastServerContactAt = root.stringOrNull("lastServerContactAt"),
                    serverUrl = root.stringOrNull("serverUrl"),
                    installationId = root.stringOrNull("installationId"),
                    organizationName = root.stringOrNull("organizationName"),
                    screenId = root.stringOrNull("screenId"),
                    screenName = root.stringOrNull("screenName"),
                    activeHoursState = root.stringOrNull("activeHoursState"),
                    takeoverActive = root["takeoverActive"]?.jsonPrimitive?.booleanOrNull == true,
                    cachedFallbackAvailable = root["cachedFallbackAvailable"]?.jsonPrimitive?.booleanOrNull == true,
                    nextTransitionAt = root.stringOrNull("nextTransitionAt"),
                    renderer = CoreRendererStatus.parse(
                        try {
                            root["renderer"]?.jsonObject
                        } catch (_: Exception) {
                            null
                        },
                    ),
                )
            } catch (_: Exception) {
                CoreHostStatus(false, 0, null, null, false, "status_unparseable")
            }
        }
    }
}

/** Core pairing surface, projected from the native status JSON. */
sealed interface CorePairingState {
    data object Unknown : CorePairingState
    data object Paired : CorePairingState
    data object Enrolled : CorePairingState
    data object Setup : CorePairingState
    data object AddressRejected : CorePairingState
    data object Reset : CorePairingState
    data class Waiting(
        val code: String,
        val approvalUrl: String,
        val organizationName: String?,
        val expiresAt: String?,
        val serverTime: String?,
    ) : CorePairingState
    data class Renewing(val reason: String) : CorePairingState

    companion object {
        fun parse(payload: String?): CorePairingState {
            if (payload == null) return Unknown
            return try {
                val root = Json.parseToJsonElement(payload).jsonObject
                when (root.stringOrNull("state")) {
                    "paired" -> Paired
                    "enrolled" -> Enrolled
                    "setup" -> Setup
                    "addressRejected" -> AddressRejected
                    "reset" -> Reset
                    "waiting" -> Waiting(
                        code = root.stringOrNull("code") ?: return Unknown,
                        approvalUrl = root.stringOrNull("approvalUrl") ?: return Unknown,
                        organizationName = root.stringOrNull("organizationName"),
                        expiresAt = root.stringOrNull("expiresAt"),
                        serverTime = root.stringOrNull("serverTime"),
                    )
                    "renewing" -> Renewing(reason = root.stringOrNull("reason") ?: return Unknown)
                    else -> Unknown
                }
            } catch (_: Exception) {
                Unknown
            }
        }
    }
}

/** A server's public installation identity, fetched without a credential. */
data class CoreIdentity(
    val ok: Boolean,
    val product: String?,
    val installationId: String?,
    val organizationName: String?,
    val apiVersion: String?,
    val pairingEnabled: Boolean,
    val code: String? = null,
) {
    companion object {
        fun parse(payload: String?): CoreIdentity {
            if (payload == null) return CoreIdentity(false, null, null, null, null, false, "null_result")
            return try {
                val root = Json.parseToJsonElement(payload).jsonObject
                CoreIdentity(
                    ok = root["ok"]?.jsonPrimitive?.booleanOrNull == true,
                    product = root.stringOrNull("product"),
                    installationId = root.stringOrNull("installationId"),
                    organizationName = root.stringOrNull("organizationName"),
                    apiVersion = root.stringOrNull("apiVersion"),
                    pairingEnabled = root["pairingEnabled"]?.jsonPrimitive?.booleanOrNull == true,
                    code = root.stringOrNull("code"),
                )
            } catch (_: Exception) {
                CoreIdentity(false, null, null, null, null, false, "result_unparseable")
            }
        }
    }
}

/** One background liveness ping: accepted, revoked, mismatch, or a retryable code. */
data class CoreLivenessResult(val ok: Boolean, val outcome: String?, val code: String?) {
    companion object {
        fun parse(payload: String?): CoreLivenessResult {
            if (payload == null) return CoreLivenessResult(false, null, "null_result")
            return try {
                val root = Json.parseToJsonElement(payload).jsonObject
                CoreLivenessResult(
                    ok = root["ok"]?.jsonPrimitive?.booleanOrNull == true,
                    outcome = root.stringOrNull("outcome"),
                    code = root.stringOrNull("code"),
                )
            } catch (_: Exception) {
                CoreLivenessResult(false, null, "result_unparseable")
            }
        }
    }
}

/** Result of a pairing begin call: success or a stable machine code. */
data class CoreBeginResult(val ok: Boolean, val code: String?) {
    companion object {
        fun parse(payload: String?): CoreBeginResult {
            if (payload == null) return CoreBeginResult(false, "null_result")
            return try {
                val root = Json.parseToJsonElement(payload).jsonObject
                CoreBeginResult(
                    ok = root["ok"]?.jsonPrimitive?.booleanOrNull == true,
                    code = root.stringOrNull("code"),
                )
            } catch (_: Exception) {
                CoreBeginResult(false, "result_unparseable")
            }
        }
    }
}

/** Result of one configuration sync: the Core outcome plus the revision in force. */
data class CoreSyncResult(
    val ok: Boolean,
    val outcome: String?,
    val revision: Long?,
    val reason: String? = null,
    val code: String? = null,
) {
    companion object {
        fun parse(payload: String?): CoreSyncResult {
            if (payload == null) return CoreSyncResult(false, null, null, code = "null_result")
            return try {
                val root = Json.parseToJsonElement(payload).jsonObject
                CoreSyncResult(
                    ok = root["ok"]?.jsonPrimitive?.booleanOrNull == true,
                    outcome = root.stringOrNull("outcome"),
                    revision = root["revision"]?.jsonPrimitive?.longOrNull,
                    reason = root.stringOrNull("reason"),
                    code = root.stringOrNull("code"),
                )
            } catch (_: Exception) {
                CoreSyncResult(false, null, null, code = "result_unparseable")
            }
        }
    }
}

data class CoreManifestResult(
    val ok: Boolean,
    val outcome: String?,
    val version: Long?,
    val reason: String? = null,
    val code: String? = null,
) {
    companion object {
        fun parse(payload: String?): CoreManifestResult {
            if (payload == null) return CoreManifestResult(false, null, null, code = "null_result")
            return try {
                val root = Json.parseToJsonElement(payload).jsonObject
                CoreManifestResult(
                    ok = root["ok"]?.jsonPrimitive?.booleanOrNull == true,
                    outcome = root.stringOrNull("outcome"),
                    version = root["version"]?.jsonPrimitive?.longOrNull,
                    reason = root.stringOrNull("reason"),
                    code = root.stringOrNull("code"),
                )
            } catch (_: Exception) {
                CoreManifestResult(false, null, null, code = "result_unparseable")
            }
        }
    }
}

data class CoreImportResult(
    val ok: Boolean,
    val status: String?,
    val roomVersion: Long?,
    val identityImported: Boolean,
    val bindingImported: Boolean,
    val configRevision: Long?,
    val manifestVersion: Long?,
    val mediaImported: Int,
    val mediaSkipped: Int,
    val notes: List<String>,
    val code: String? = null,
) {
    companion object {
        fun parse(payload: String?): CoreImportResult {
            fun empty(code: String) = CoreImportResult(false, null, null, false, false, null, null, 0, 0, emptyList(), code)
            if (payload == null) return empty("null_result")
            return try {
                val root = Json.parseToJsonElement(payload).jsonObject
                val code = root.stringOrNull("code")
                if (code != null) return empty(code)
                val status = root.stringOrNull("status")
                CoreImportResult(
                    ok = status == "complete" || status == "skipped_core_owned" || status == "nothing_to_import",
                    status = status,
                    roomVersion = root["roomVersion"]?.jsonPrimitive?.longOrNull,
                    identityImported = root["identityImported"]?.jsonPrimitive?.booleanOrNull == true,
                    bindingImported = root["bindingImported"]?.jsonPrimitive?.booleanOrNull == true,
                    configRevision = root["configRevision"]?.jsonPrimitive?.longOrNull,
                    manifestVersion = root["manifestVersion"]?.jsonPrimitive?.longOrNull,
                    mediaImported = root["mediaImported"]?.jsonPrimitive?.intOrNull ?: 0,
                    mediaSkipped = root["mediaSkipped"]?.jsonPrimitive?.intOrNull ?: 0,
                    notes = root["notes"]?.jsonArray?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList(),
                )
            } catch (_: Exception) {
                empty("result_unparseable")
            }
        }
    }
}

private fun JsonObject.stringOrNull(key: String): String? {
    val primitive = try {
        get(key)?.jsonPrimitive
    } catch (_: Exception) {
        null
    } ?: return null
    return if (primitive.isString) primitive.content else null
}

/** Result of an activation call: the issued reference or a machine reason. */
data class CoreActivateResult(
    val ok: Boolean,
    val activationId: String?,
    val generation: Long?,
    val queued: Boolean,
    val incompatibleReason: String?,
    val outcome: String? = null,
    val reason: String? = null,
    val code: String? = null,
) {
    companion object {
        fun parse(payload: String?): CoreActivateResult {
            if (payload == null) return CoreActivateResult(false, null, null, false, null, code = "null_result")
            return try {
                val root = Json.parseToJsonElement(payload).jsonObject
                CoreActivateResult(
                    ok = root["ok"]?.jsonPrimitive?.booleanOrNull == true,
                    activationId = root.stringOrNull("activationId"),
                    generation = root["generation"]?.jsonPrimitive?.longOrNull,
                    queued = root["queued"]?.jsonPrimitive?.booleanOrNull == true,
                    incompatibleReason = root.stringOrNull("incompatibleReason"),
                    outcome = root.stringOrNull("outcome"),
                    reason = root.stringOrNull("reason"),
                    code = root.stringOrNull("code"),
                )
            } catch (_: Exception) {
                CoreActivateResult(false, null, null, false, null, code = "result_unparseable")
            }
        }
    }
}

/** Result of a recovery control call: the action taken or a machine reason. */
data class CoreRecoveryResult(
    val ok: Boolean,
    val action: String?,
    val wasActive: Boolean?,
    val outcome: String? = null,
    val reason: String? = null,
    val code: String? = null,
) {
    companion object {
        fun parse(payload: String?): CoreRecoveryResult {
            if (payload == null) return CoreRecoveryResult(false, null, null, code = "null_result")
            return try {
                val root = Json.parseToJsonElement(payload).jsonObject
                CoreRecoveryResult(
                    ok = root["ok"]?.jsonPrimitive?.booleanOrNull == true,
                    action = root.stringOrNull("action"),
                    wasActive = root["wasActive"]?.jsonPrimitive?.booleanOrNull,
                    outcome = root.stringOrNull("outcome"),
                    reason = root.stringOrNull("reason"),
                    code = root.stringOrNull("code"),
                )
            } catch (_: Exception) {
                CoreRecoveryResult(false, null, null, code = "result_unparseable")
            }
        }
    }
}

/** Answer codes for renderer reports, shared with the native host. */
object CoreReportCode {
    const val APPLIED = 0
    const val IGNORED = 1
    const val MALFORMED = 2
    const val BAD_HANDLE = 3
}

/** Observable state of the process-level native host. */
sealed interface CoreHostState {
    data object Idle : CoreHostState
    data object Starting : CoreHostState
    data class Ready(val version: String, val status: CoreHostStatus, val coreRunning: Boolean) : CoreHostState
    data class Failed(val code: String) : CoreHostState
}

/**
 * The seam between [PlayerCoreHost] and the native library. Production uses
 * [JniCoreBridge]; JVM tests substitute a fake so no `.so` is ever loaded
 * off-device. Deliberately free of Android types so JVM tests need no Context.
 */
interface CoreBridge {
    fun version(): String?
    fun open(filesDir: String, userAgent: String, handler: CoreBridgeHandler): Long
    fun statusJson(handle: Long): String?
    fun startCore(handle: Long): Int
    fun beginPairing(handle: Long, url: String): String?
    fun resetPairing(handle: Long): Int
    fun resetServer(handle: Long): Int
    fun syncConfig(handle: Long): String?
    fun syncManifest(handle: Long): String?
    fun importLegacy(handle: Long): String?
    fun activatePresentation(handle: Long, json: String): String?
    fun rendererReport(handle: Long, json: String): Int
    fun rendererRecovery(handle: Long, json: String): String?
    fun reportObservations(handle: Long, json: String): Int
    fun configJson(handle: Long): String?
    fun fetchIdentity(handle: Long, url: String): String?
    fun backgroundLiveness(handle: Long): String?
    fun close(handle: Long): Int
}

internal class JniCoreBridge : CoreBridge {
    override fun version(): String? = PlayerCoreNative.nativeVersion()
    override fun open(filesDir: String, userAgent: String, handler: CoreBridgeHandler): Long =
        PlayerCoreNative.nativeOpen(filesDir, userAgent, handler)
    override fun statusJson(handle: Long): String? = PlayerCoreNative.nativeStatus(handle)
    override fun startCore(handle: Long): Int = PlayerCoreNative.nativeStartCore(handle)
    override fun beginPairing(handle: Long, url: String): String? =
        PlayerCoreNative.nativeBeginPairing(handle, url)
    override fun resetPairing(handle: Long): Int = PlayerCoreNative.nativeResetPairing(handle)
    override fun resetServer(handle: Long): Int = PlayerCoreNative.nativeResetServer(handle)
    override fun syncConfig(handle: Long): String? = PlayerCoreNative.nativeSyncConfig(handle)
    override fun syncManifest(handle: Long): String? = PlayerCoreNative.nativeSyncManifest(handle)
    override fun importLegacy(handle: Long): String? = PlayerCoreNative.nativeImportLegacy(handle)
    override fun activatePresentation(handle: Long, json: String): String? =
        PlayerCoreNative.nativeActivatePresentation(handle, json)
    override fun rendererReport(handle: Long, json: String): Int =
        PlayerCoreNative.nativeRendererReport(handle, json)
    override fun rendererRecovery(handle: Long, json: String): String? =
        PlayerCoreNative.nativeRendererRecovery(handle, json)
    override fun reportObservations(handle: Long, json: String): Int =
        PlayerCoreNative.nativeReportObservations(handle, json)
    override fun configJson(handle: Long): String? = PlayerCoreNative.nativeConfigJson(handle)
    override fun fetchIdentity(handle: Long, url: String): String? = PlayerCoreNative.nativeFetchIdentity(handle, url)
    override fun backgroundLiveness(handle: Long): String? = PlayerCoreNative.nativeBackgroundLiveness(handle)
    override fun close(handle: Long): Int = PlayerCoreNative.nativeClose(handle)
    fun initTls(context: Context): Int = PlayerCoreNative.nativeInitTls(context)
}

/** Builds the Kotlin handler Core calls back into. Production binds the real stores. */
fun interface CoreHandlerFactory {
    fun create(sink: (String) -> Unit): CoreBridgeHandler
}

/**
 * Application/process-level owner of the Rust Core lifetime. Activities and
 * ViewModels observe [state] and [pairingState]; they never own the host, so
 * Activity recreation cannot restart the Player daemon.
 *
 * Production starts the host plus its drivers ([startDrivers]) and drives
 * pairing, content, and presence through Core. The Kotlin Player it
 * replaced is gone; this host is the production brain.
 */
class PlayerCoreHost private constructor(
    private val filesDir: File,
    private val userAgent: String,
    private val bridge: CoreBridge,
    private val tlsInit: () -> Int,
    handlerFactory: CoreHandlerFactory,
    /**
     * The single app-scoped update manager: the command executor prepares
     * deployments through it and the ViewModel shows its states. Null in
     * tests that never build production effects.
     */
    val updateManager: PlayerUpdateManager?,
) {
    private val mutex = Mutex()
    private var handle: Long = 0L
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val handler: CoreBridgeHandler = handlerFactory.create { json ->
        val parsed = CorePairingState.parse(json)
        _pairingState.value = parsed
        // Enrollment binds the server URL and screen: refresh the cached
        // status so the platform executor's providers see it. The sink
        // runs on a Core worker thread; the refresh hops to IO first.
        if (parsed is CorePairingState.Paired || parsed is CorePairingState.Enrolled) {
            scope.launch { refreshStatus() }
        }
    }
    private val _state = MutableStateFlow<CoreHostState>(CoreHostState.Idle)
    val state: StateFlow<CoreHostState> = _state.asStateFlow()
    private val _pairingState = MutableStateFlow<CorePairingState>(CorePairingState.Unknown)
    val pairingState: StateFlow<CorePairingState> = _pairingState.asStateFlow()

    /** Starts the host. Safe to call twice; the second call is a no-op. */
    suspend fun start() {
        withContext(Dispatchers.IO) {
            mutex.withLock {
                when (_state.value) {
                    is CoreHostState.Ready, is CoreHostState.Starting -> return@withContext
                    else -> Unit
                }
                _state.value = CoreHostState.Starting
                // JNI entry points throw LinkageError (not Exception) when
                // the native library is missing; map that to Failed too.
                // CancellationException is deliberately not caught.
                val tls = try {
                    tlsInit()
                } catch (_: LinkageError) {
                    TLS_FAILED
                } catch (_: Exception) {
                    TLS_FAILED
                }
                if (tls != TLS_OK) {
                    handle = 0L
                    _state.value = CoreHostState.Failed(if (tls == TLS_UNSUPPORTED) "tls_init_unsupported" else "tls_init_failed")
                    return@withContext
                }
                val opened = try {
                    bridge.open(filesDir.absolutePath, userAgent, handler)
                } catch (_: LinkageError) {
                    0L
                } catch (_: Exception) {
                    0L
                }
                if (opened == 0L) {
                    handle = 0L
                    _state.value = CoreHostState.Failed("open_failed")
                    return@withContext
                }
                handle = opened
                val status = CoreHostStatus.parse(runCatching { bridge.statusJson(opened) }.getOrNull())
                if (!status.ok) {
                    runCatching { bridge.close(opened) }
                    handle = 0L
                    _state.value = CoreHostState.Failed(status.code ?: "status_failed")
                    return@withContext
                }
                val version = runCatching { bridge.version() }.getOrNull()
                if (version.isNullOrEmpty()) {
                    runCatching { bridge.close(opened) }
                    handle = 0L
                    _state.value = CoreHostState.Failed("version_missing")
                    return@withContext
                }
                _pairingState.value = CorePairingState.Unknown
                _state.value = CoreHostState.Ready(version, status, coreRunning = false)
            }
        }
    }

    /**
     * Starts the host plus its Core drivers: legacy state is imported,
     * then the drivers reconcile pairing, content, and presence. This is
     * the production start path; qualification tests use it too.
     */
    suspend fun startDrivers() {
        start()
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val ready = _state.value as? CoreHostState.Ready ?: return@withContext
                if (ready.coreRunning) return@withContext
                // Legacy state crosses before the drivers start, so the
                // first reconciliation already sees the imported binding.
                runCatching { bridge.importLegacy(handle) }
                refreshStatusLocked(ready)
                val code = runCatching { bridge.startCore(handle) }.getOrDefault(1)
                if (code == 0) {
                    val status = CoreHostStatus.parse(runCatching { bridge.statusJson(handle) }.getOrNull())
                    _state.value = ready.copy(status = status.takeIf { it.ok } ?: ready.status, coreRunning = true)
                }
            }
        }
    }

    /** Reads a server's public identity without sending any credential. */
    suspend fun fetchIdentity(url: String): CoreIdentity =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                if (_state.value !is CoreHostState.Ready) return@withLock CoreIdentity(false, null, null, null, null, false, "host_not_ready")
                CoreIdentity.parse(runCatching { bridge.fetchIdentity(handle, url) }.getOrNull())
            }
        }

    /** Pings background liveness against the bound server. */
    suspend fun backgroundLiveness(): CoreLivenessResult =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                if (_state.value !is CoreHostState.Ready) return@withLock CoreLivenessResult(false, null, "host_not_ready")
                CoreLivenessResult.parse(runCatching { bridge.backgroundLiveness(handle) }.getOrNull())
            }
        }

    /** Begins a Core pairing session against the server URL. */
    suspend fun beginPairing(url: String): CoreBeginResult =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val ready = _state.value as? CoreHostState.Ready
                    ?: return@withLock CoreBeginResult(false, "host_not_ready")
                CoreBeginResult.parse(runCatching { bridge.beginPairing(handle, url) }.getOrNull())
                    .also { result ->
                        if (result.ok) refreshStatusLocked(ready)
                    }
            }
        }

    /** Runs one Core configuration sync against the bound server. */
    suspend fun syncConfig(): CoreSyncResult =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val ready = _state.value as? CoreHostState.Ready
                    ?: return@withLock CoreSyncResult(false, null, null, code = "host_not_ready")
                CoreSyncResult.parse(runCatching { bridge.syncConfig(handle) }.getOrNull())
                    .also { result ->
                        if (result.ok) refreshStatusLocked(ready)
                    }
            }
        }

    /** Runs one Core manifest sync against the bound server. */
    suspend fun syncManifest(): CoreManifestResult =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val ready = _state.value as? CoreHostState.Ready
                    ?: return@withLock CoreManifestResult(false, null, null, code = "host_not_ready")
                CoreManifestResult.parse(runCatching { bridge.syncManifest(handle) }.getOrNull())
                    .also { result ->
                        if (result.ok) refreshStatusLocked(ready)
                    }
            }
        }

    /** Runs one legacy Room/cache import into Core state. Idempotent. */
    suspend fun importLegacy(): CoreImportResult =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val ready = _state.value as? CoreHostState.Ready
                    ?: return@withLock CoreImportResult.parse(null).copy(code = "host_not_ready")
                CoreImportResult.parse(runCatching { bridge.importLegacy(handle) }.getOrNull())
                    .also { result ->
                        if (result.ok) refreshStatusLocked(ready)
                    }
            }
        }

    /** Issues a Core presentation activation from a projected host message. */
    suspend fun activatePresentation(json: String): CoreActivateResult =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val ready = _state.value as? CoreHostState.Ready
                    ?: return@withLock CoreActivateResult(false, null, null, false, null, code = "host_not_ready")
                CoreActivateResult.parse(runCatching { bridge.activatePresentation(handle, json) }.getOrNull())
                    .also { result ->
                        if (result.ok) refreshStatusLocked(ready)
                    }
            }
        }

    /** Sends one renderer report: connection, readiness, evidence, errors, captures. */
    suspend fun rendererReport(json: String): Int =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                if (_state.value !is CoreHostState.Ready) return@withLock CoreReportCode.BAD_HANDLE
                runCatching { bridge.rendererReport(handle, json) }.getOrDefault(CoreReportCode.MALFORMED)
            }
        }

    /** Runs one renderer recovery control: retry, clear_safe_mode, or clear. */
    suspend fun rendererRecovery(json: String): CoreRecoveryResult =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val ready = _state.value as? CoreHostState.Ready
                    ?: return@withLock CoreRecoveryResult(false, null, null, code = "host_not_ready")
                CoreRecoveryResult.parse(runCatching { bridge.rendererRecovery(handle, json) }.getOrNull())
                    .also { result ->
                        if (result.ok) refreshStatusLocked(ready)
                    }
            }
        }

    /**
     * Records platform observations for the heartbeat projection.
     * Returns how many fields Core stored; unknown or out-of-range
     * fields are dropped, never sent. Negative means the call failed.
     */
    suspend fun reportObservations(json: String): Int =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                if (_state.value !is CoreHostState.Ready) return@withLock -1
                runCatching { bridge.reportObservations(handle, json) }.getOrDefault(-1)
            }
        }

    /** Reads the accepted configuration split by its behavioral owner. */
    suspend fun effectiveConfig(): CorePlayerConfig =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                if (_state.value !is CoreHostState.Ready) return@withLock CorePlayerConfig(null)
                CorePlayerConfig.parse(runCatching { bridge.configJson(handle) }.getOrNull())
            }
        }

    /** Resets Core pairing state. Best effort; always safe to call. */
    suspend fun resetPairing(): Boolean =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val ready = _state.value as? CoreHostState.Ready ?: return@withLock false
                val ok = runCatching { bridge.resetPairing(handle) }.getOrDefault(1) == 0
                if (ok) {
                    _pairingState.value = CorePairingState.Unknown
                    refreshStatusLocked(ready)
                }
                ok
            }
        }

    /** Forgets the server connection entirely. Best effort; always safe to call. */
    suspend fun resetServer(): Boolean =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val ready = _state.value as? CoreHostState.Ready ?: return@withLock false
                val ok = runCatching { bridge.resetServer(handle) }.getOrDefault(1) == 0
                if (ok) {
                    _pairingState.value = CorePairingState.Unknown
                    refreshStatusLocked(ready)
                }
                ok
            }
        }

    private fun refreshStatusLocked(ready: CoreHostState.Ready) {
        val status = CoreHostStatus.parse(runCatching { bridge.statusJson(handle) }.getOrNull())
        if (status.ok) _state.value = ready.copy(status = status)
    }

    /** Test-only: swaps the platform command executor on the live handler. */
    fun setPlatformExecutorForTesting(executor: PlatformCommandExecutor) {
        handler.executor = executor
    }

    /** Attaches the renderer adapter that serves Core's renderer requests. */
    fun attachRendererAdapter(adapter: CoreRendererAdapter) {
        handler.rendererAdapter = adapter
    }

    /** Re-reads the native status snapshot. The server link updates link
     * state, contact time, and revisions continuously; Kotlin pulls. */
    suspend fun refreshStatus() {
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val ready = _state.value as? CoreHostState.Ready ?: return@withLock
                refreshStatusLocked(ready)
            }
        }
    }

    /** Stops the host. Safe to call when idle or after a failed start. */
    suspend fun stop() {
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val live = handle
                handle = 0L
                if (live != 0L) runCatching { bridge.close(live) }
                _pairingState.value = CorePairingState.Unknown
                _state.value = CoreHostState.Idle
            }
        }
    }

    companion object {
        const val TLS_OK = 0
        const val TLS_FAILED = 1
        const val TLS_UNSUPPORTED = 2

        /** Matches the legacy Player's server-visible agent shape. */
        fun userAgent(): String = "Tilecast-Player-Android/${BuildConfig.VERSION_NAME}"

        @Volatile
        private var instance: PlayerCoreHost? = null

        /** The single process-level host. Always bound to the application context. */
        fun get(context: Context): PlayerCoreHost =
            instance ?: synchronized(this) {
                instance ?: build(context).also { instance = it }
            }

        private fun build(context: Context): PlayerCoreHost {
            val app = context.applicationContext
            val bridge = JniCoreBridge()
            val coreDir = File(app.filesDir, "player-core")
            val credentials = MigratingCredentialStore.forProduction(app)
            val updates = PlayerUpdateManager(app as Application, TilecastApi())
            lateinit var host: PlayerCoreHost
            val executor = CorePlatformCommands(
                AndroidPlatformEffects(
                    ReliabilityController(app),
                    updates,
                ),
                credentials,
                serverUrl = { (host.state.value as? CoreHostState.Ready)?.status?.serverUrl },
                takeoverActive = {
                    (host.state.value as? CoreHostState.Ready)?.status?.takeoverActive == true
                },
            )
            host = PlayerCoreHost(app.filesDir, userAgent(), bridge, { bridge.initTls(app) }, { sink ->
                CoreBridgeHandler(
                    credentials,
                    File(coreDir, "pairing.json"),
                    DeviceFacts.collect(app),
                    sink,
                    executor = executor,
                )
            }, updates)
            return host
        }

        /** Test-only: builds an isolated host that never touches the singleton. */
        fun forTesting(
            filesDir: File,
            bridge: CoreBridge,
            handlerFactory: CoreHandlerFactory,
            tlsInit: () -> Int = { TLS_OK },
            userAgent: String = "Tilecast-Player-Android/test",
        ): PlayerCoreHost = PlayerCoreHost(filesDir, userAgent, bridge, tlsInit, handlerFactory, null)
    }
}
