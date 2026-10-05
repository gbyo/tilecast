package org.tilecast.player.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.content.CommandOutcome
import org.tilecast.player.content.UpdateUiState
import org.tilecast.player.network.PlayerCommand
import org.tilecast.player.security.CredentialStore

class CorePlatformCommandsTest {
    private class FakeEffects(
        var sleepResult: String = "device_policy_requested",
        var wakeResult: String = "device_wake_requested",
        var updateOutcome: CommandOutcome = CommandOutcome(true, "update_already_current", "current"),
        var throwOnSleep: Boolean = false,
    ) : PlatformEffects {
        val calls = mutableListOf<String>()
        var updateCommand: PlayerCommand? = null
        var updateServer: String? = null
        var updateCredential: String? = null
        override fun powerSleep(): String {
            calls += "sleep"
            if (throwOnSleep) throw RuntimeException("boom")
            return sleepResult
        }
        override fun powerWake(): String {
            calls += "wake"
            return wakeResult
        }
        override fun restartActivity() {
            calls += "restart_activity"
        }
        override fun restartProcess() {
            calls += "restart_process"
        }
        override suspend fun installUpdate(
            command: PlayerCommand,
            server: String,
            credential: String,
            takeoverActive: () -> Boolean,
            onState: (UpdateUiState) -> Unit,
        ): CommandOutcome {
            calls += "install"
            updateCommand = command
            updateServer = server
            updateCredential = credential
            return updateOutcome
        }
    }

    private class FakeCredentials(var value: String? = "device-secret") : CredentialStore {
        override fun read(): String? = value
        override fun save(credential: String) {
            value = credential
        }
        override fun clear() {
            value = null
        }
    }

    private fun answer(json: String) = Json.parseToJsonElement(json).jsonObject

    @Test fun powerCommandsReturnEffectResults() {
        val effects = FakeEffects()
        val executor = CorePlatformCommands(effects, FakeCredentials(), { "http://server" }, { false })
        val sleep = answer(executor.execute("""{"id":"1","type":"power_assist_sleep","payload":{}}"""))
        assertEquals(true, sleep["ok"]?.jsonPrimitive?.booleanOrNull)
        assertEquals("device_policy_requested", sleep["code"]?.jsonPrimitive?.contentOrNull)
        val wake = answer(executor.execute("""{"id":"2","type":"power_assist_wake","payload":{}}"""))
        assertEquals(true, wake["ok"]?.jsonPrimitive?.booleanOrNull)
        assertEquals("device_wake_requested", wake["code"]?.jsonPrimitive?.contentOrNull)
        assertEquals(listOf("sleep", "wake"), effects.calls)
    }

    @Test fun restartActivityCrosses() {
        val effects = FakeEffects()
        val executor = CorePlatformCommands(effects, FakeCredentials(), { "http://server" }, { false })
        val result = answer(executor.execute("""{"id":"3","type":"restart_activity","payload":{}}"""))
        assertEquals(true, result["ok"]?.jsonPrimitive?.booleanOrNull)
        assertEquals("activity_restart_requested", result["code"]?.jsonPrimitive?.contentOrNull)
        assertEquals(listOf("restart_activity"), effects.calls)
    }

    @Test fun installPassesServerCredentialAndPayload() {
        val effects = FakeEffects()
        val states = mutableListOf<UpdateUiState>()
        val executor = CorePlatformCommands(effects, FakeCredentials("cred-9"), { "http://s" }, { true })
        executor.onUpdateState = { states += it }
        val result = answer(
            executor.execute(
                """{"id":"cmd-4","type":"install_player_update","payload":{"deploymentId":"d1"}}""",
            ),
        )
        assertEquals(true, result["ok"]?.jsonPrimitive?.booleanOrNull)
        assertEquals("update_already_current", result["code"]?.jsonPrimitive?.contentOrNull)
        assertEquals("cmd-4", effects.updateCommand?.id)
        assertEquals("d1", effects.updateCommand?.payload?.get("deploymentId")?.jsonPrimitive?.contentOrNull)
        assertEquals("http://s", effects.updateServer)
        assertEquals("cred-9", effects.updateCredential)
    }

    @Test fun installWithoutPairingFails() {
        val effects = FakeEffects()
        val executor = CorePlatformCommands(effects, FakeCredentials(null), { null }, { false })
        val result = answer(executor.execute("""{"id":"5","type":"install_player_update","payload":{}}"""))
        assertEquals(false, result["ok"]?.jsonPrimitive?.booleanOrNull)
        assertEquals("update_not_paired", result["code"]?.jsonPrimitive?.contentOrNull)
        assertTrue(effects.calls.isEmpty())
    }

    @Test fun unknownCommandsFailClosed() {
        val effects = FakeEffects()
        val executor = CorePlatformCommands(effects, FakeCredentials(), { "http://server" }, { false })
        val unknown = answer(executor.execute("""{"id":"6","type":"launch_missiles","payload":{}}"""))
        assertEquals(false, unknown["ok"]?.jsonPrimitive?.booleanOrNull)
        assertEquals("command_unsupported", unknown["code"]?.jsonPrimitive?.contentOrNull)
        val malformed = answer(executor.execute("not json"))
        assertEquals(false, malformed["ok"]?.jsonPrimitive?.booleanOrNull)
        assertTrue(effects.calls.isEmpty())
    }

    @Test fun effectExceptionsFailClosed() {
        val effects = FakeEffects(throwOnSleep = true)
        val executor = CorePlatformCommands(effects, FakeCredentials(), { "http://server" }, { false })
        val result = answer(executor.execute("""{"id":"7","type":"power_assist_sleep","payload":{}}"""))
        assertFalse(result["ok"]?.jsonPrimitive?.booleanOrNull == true)
        assertEquals("platform_failed", result["code"]?.jsonPrimitive?.contentOrNull)
    }
}
