package org.tilecast.player.core

import android.content.Context
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.tilecast.player.BuildConfig
import org.tilecast.player.security.MigratingCredentialStore

/**
 * Status snapshot shared by the native host (bridge contract v2). Lenient by
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
    data class Waiting(val code: String, val approvalUrl: String, val organizationName: String?) : CorePairingState
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

private fun JsonObject.stringOrNull(key: String): String? {
    val primitive = try {
        get(key)?.jsonPrimitive
    } catch (_: Exception) {
        null
    } ?: return null
    return if (primitive.isString) primitive.content else null
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
    fun syncConfig(handle: Long): String?
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
    override fun syncConfig(handle: Long): String? = PlayerCoreNative.nativeSyncConfig(handle)
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
 * Production still runs the Kotlin Player. The Core-only test mode starts
 * the host plus its drivers ([startCoreOnly]) and drives pairing through
 * Core ([beginPairing]); the device test and internal builds use it while
 * the Kotlin Player keeps serving production traffic.
 */
class PlayerCoreHost private constructor(
    private val filesDir: File,
    private val userAgent: String,
    private val bridge: CoreBridge,
    private val tlsInit: () -> Int,
    handlerFactory: CoreHandlerFactory,
) {
    private val mutex = Mutex()
    private var handle: Long = 0L
    private val handler: CoreBridgeHandler = handlerFactory.create { json ->
        _pairingState.value = CorePairingState.parse(json)
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
     * Starts the host plus its Core drivers: the Core-only test mode. The
     * drivers reconcile pairing and (as they land) every other Core behavior.
     */
    suspend fun startCoreOnly() {
        start()
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val ready = _state.value as? CoreHostState.Ready ?: return@withContext
                if (ready.coreRunning) return@withContext
                val code = runCatching { bridge.startCore(handle) }.getOrDefault(1)
                if (code == 0) {
                    val status = CoreHostStatus.parse(runCatching { bridge.statusJson(handle) }.getOrNull())
                    _state.value = ready.copy(status = status.takeIf { it.ok } ?: ready.status, coreRunning = true)
                }
            }
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

    private fun refreshStatusLocked(ready: CoreHostState.Ready) {
        val status = CoreHostStatus.parse(runCatching { bridge.statusJson(handle) }.getOrNull())
        if (status.ok) _state.value = ready.copy(status = status)
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
            return PlayerCoreHost(app.filesDir, userAgent(), bridge, { bridge.initTls(app) }) { sink ->
                CoreBridgeHandler(
                    credentials,
                    File(coreDir, "pairing.json"),
                    DeviceFacts.collect(app),
                    sink,
                )
            }
        }

        /** Test-only: builds an isolated host that never touches the singleton. */
        fun forTesting(
            filesDir: File,
            bridge: CoreBridge,
            handlerFactory: CoreHandlerFactory,
            tlsInit: () -> Int = { TLS_OK },
            userAgent: String = "Tilecast-Player-Android/test",
        ): PlayerCoreHost = PlayerCoreHost(filesDir, userAgent, bridge, tlsInit, handlerFactory)
    }
}
