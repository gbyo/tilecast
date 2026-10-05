package org.tilecast.player.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.tilecast.player.content.PlayerUpdateManager
import org.tilecast.player.content.UpdateUiState
import org.tilecast.player.network.PlayerCommand
import org.tilecast.player.reliability.ReliabilityController
import org.tilecast.player.security.CredentialStore

/**
 * The OS effects behind the platform executor, as one seam so JVM
 * tests substitute a fake. Production delegates to the reliability
 * controller and the update installer; see [AndroidPlatformEffects].
 */
interface PlatformEffects {
    fun powerSleep(): String
    fun powerWake(): String
    fun restartActivity()
    fun restartProcess()
    suspend fun installUpdate(
        command: PlayerCommand,
        server: String,
        credential: String,
        takeoverActive: () -> Boolean,
        onState: (UpdateUiState) -> Unit,
    ): org.tilecast.player.content.CommandOutcome
}

/** Production [PlatformEffects]: the reliability controller and update installer. */
class AndroidPlatformEffects(
    private val reliability: ReliabilityController,
    private val updates: PlayerUpdateManager,
) : PlatformEffects {
    override fun powerSleep(): String = reliability.requestSleep()
    override fun powerWake(): String = reliability.requestWake()
    override fun restartActivity() = reliability.restartActivity()
    override fun restartProcess() = reliability.restartProcess()
    override suspend fun installUpdate(
        command: PlayerCommand,
        server: String,
        credential: String,
        takeoverActive: () -> Boolean,
        onState: (UpdateUiState) -> Unit,
    ): org.tilecast.player.content.CommandOutcome =
        updates.prepare(server, credential, command, takeoverActive, onState)
}

/**
 * The production platform executor: the OS effects Core routes to
 * Kotlin. Renderer commands (retry, skip, reload, recreate, identify,
 * website-data clearing, recovery) run natively against the engine;
 * only power, update installation, and restarts cross here.
 *
 * Called on Core worker threads: blocking is allowed, but this must
 * never call back into the native host (that would deadlock the
 * runtime) and never wait on the UI thread. Server facts come from
 * the cached status providers, refreshed on enrollment and by the UI.
 */
class CorePlatformCommands(
    private val effects: PlatformEffects,
    private val credentials: CredentialStore,
    private val serverUrl: () -> String?,
    private val takeoverActive: () -> Boolean,
    var onUpdateState: (UpdateUiState) -> Unit = {},
) : PlatformCommandExecutor {
    override fun execute(requestJson: String): String =
        runCatching { executeOrThrow(requestJson) }
            .getOrElse { PlatformCommandExecutor.result(false, "platform_failed") }

    private fun executeOrThrow(requestJson: String): String {
        val root = runCatching { Json.parseToJsonElement(requestJson).jsonObject }.getOrNull()
            ?: return PlatformCommandExecutor.result(false, "command_unsupported", "Command is not readable.")
        val type = root["type"]?.jsonPrimitive?.contentOrNull
            ?: return PlatformCommandExecutor.result(false, "command_unsupported", "Command has no type.")
        val payload = runCatching { root["payload"]?.jsonObject }.getOrNull() ?: buildJsonObject {}
        return when (type) {
            "power_assist_sleep" -> {
                val result = effects.powerSleep()
                PlatformCommandExecutor.result(true, result, "Power Assist sleep request was sent to Android")
            }
            "power_assist_wake" -> {
                val result = effects.powerWake()
                PlatformCommandExecutor.result(true, result, "Power Assist wake request was sent to Android")
            }
            "restart_activity" -> {
                effects.restartActivity()
                PlatformCommandExecutor.result(
                    true,
                    "activity_restart_requested",
                    "Player activity restart was requested.",
                )
            }
            "restart_player_process" -> {
                // Fire-and-forget: Core recorded the result before the
                // disruption. The grace lets the report leave first, as
                // the legacy player waited before restarting.
                Thread.sleep(1500)
                effects.restartProcess()
                PlatformCommandExecutor.result(
                    true,
                    "process_restart_requested",
                    "Controlled player process restart was requested.",
                )
            }
            "install_player_update" -> installUpdate(root, payload)
            else -> PlatformCommandExecutor.result(false, "command_unsupported", "Command is not supported.")
        }
    }

    private fun installUpdate(
        root: kotlinx.serialization.json.JsonObject,
        payload: kotlinx.serialization.json.JsonObject,
    ): String {
        val server = serverUrl()
        val credential = runCatching { credentials.read() }.getOrNull()
        if (server == null || credential == null) {
            return PlatformCommandExecutor.result(false, "update_not_paired", "The player is not paired.")
        }
        val command = PlayerCommand(
            id = root["id"]?.jsonPrimitive?.contentOrNull ?: "",
            type = "install_player_update",
            payload = payload,
            idempotencyKey = "",
            state = "",
            createdAt = "",
            expiresAt = "",
        )
        val outcome = runBlocking { effects.installUpdate(command, server, credential, takeoverActive, onUpdateState) }
        return PlatformCommandExecutor.result(outcome.success, outcome.code, outcome.message)
    }
}
