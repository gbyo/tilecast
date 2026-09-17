package org.tilecast.player.content

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.tilecast.player.network.ManifestPlugin
import org.tilecast.player.network.ManifestPluginConfig
import java.time.Instant

class CountdownBarTargetTimeTest {
    private fun weekly(targetTime: String) =
        ManifestPlugin(
            id = "bar-seconds",
            type = "countdown_bar",
            version = 1,
            config =
                ManifestPluginConfig(
                    name = "Lunch",
                    message = "Lunch ends in",
                    scheduleType = "weekly",
                    targetTime = targetTime,
                    daysOfWeek = listOf(1),
                    timezone = "America/New_York",
                    leadTimeSeconds = 900,
                    completionText = "Lunch is over",
                    displayMode = "overlay",
                    heightPx = 72,
                    priority = 10,
                ),
        )

    @Test
    fun `preserves seconds from PostgreSQL-style target times`() {
        val active =
            resolveCountdownBar(
                listOf(weekly("12:00:45")),
                Instant.parse("2026-07-27T15:50:00Z"),
            )

        assertEquals(Instant.parse("2026-07-27T16:00:45Z"), active?.targetAt)
        assertEquals("10m 45s", active?.value)
    }

    @Test
    fun `rejects trailing text instead of treating it as a valid time`() {
        assertNull(
            resolveCountdownBar(
                listOf(weekly("12:00oops")),
                Instant.parse("2026-07-27T15:50:00Z"),
            ),
        )
    }
}
