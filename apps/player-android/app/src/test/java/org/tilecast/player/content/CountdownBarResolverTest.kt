package org.tilecast.player.content

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.network.ManifestPluginConfig
import org.tilecast.player.network.ManifestPlugin
import java.time.Instant

/**
 * These mirror the Linux renderer's countdown-bar-resolver tests case for case,
 * so a divergence between the two players shows up as a failure here.
 */
class CountdownBarResolverTest {
    private fun weekly(
        priority: Int = 10,
        message: String = "Lunch ends in",
        displayMode: String = "overlay",
        progressFill: String = "none",
        contentPadding: Int = 4,
        textScale: Int = 100,
        urgencyEnabled: Boolean = false,
        targetTime: String = "12:00",
        id: String = "bar-1",
    ) = ManifestPlugin(
        id = id,
        type = "countdown_bar",
        version = 1,
        config = ManifestPluginConfig(
            name = "Lunch",
            message = message,
            scheduleType = "weekly",
            targetTime = targetTime,
            daysOfWeek = listOf(1),
            timezone = "America/New_York",
            leadTimeSeconds = 900,
            completionText = "Lunch is over",
            displayMode = displayMode,
            heightPx = 72,
            progressFill = progressFill,
            contentPadding = contentPadding,
            textScale = textScale,
            urgencyEnabled = urgencyEnabled,
            priority = priority,
        ),
    )

    private fun oneTime(
        progressFill: String = "none",
        completionText: String = "Lunch is over",
        showConfetti: Boolean = false,
    ) = ManifestPlugin(
        id = "bar-1",
        type = "countdown_bar",
        version = 1,
        config = weekly(progressFill = progressFill).config.copy(
            scheduleType = "one_time",
            targetTime = null,
            daysOfWeek = emptyList(),
            oneTimeAt = "2026-07-27T16:00:00Z",
            completionText = completionText,
            showConfetti = showConfetti,
        ),
    )

    @Test
    fun `evaluates weekly wall time in the configured timezone`() {
        val active = resolveCountdownBar(listOf(weekly()), Instant.parse("2026-07-27T15:50:00Z"))
        assertEquals("Lunch ends in", active?.message)
        assertEquals("10m 0s", active?.value)
        assertEquals(Instant.parse("2026-07-27T16:00:00Z"), active?.targetAt)
    }

    @Test
    fun `preserves seconds from PostgreSQL-style weekly target times`() {
        val active =
            resolveCountdownBar(
                listOf(weekly(targetTime = "12:00:45")),
                Instant.parse("2026-07-27T15:50:00Z"),
            )
        assertEquals(Instant.parse("2026-07-27T16:00:45Z"), active?.targetAt)
        assertEquals("10m 45s", active?.value)
    }

    @Test
    fun `rejects malformed and out of range weekly target times`() {
        for (targetTime in listOf("12:00oops", "12:00:60", "24:00", "12:60")) {
            assertNull(
                resolveCountdownBar(
                    listOf(weekly(targetTime = targetTime)),
                    Instant.parse("2026-07-27T15:50:00Z"),
                ),
            )
        }
    }

    @Test
    fun `hides outside the lead window`() {
        assertNull(resolveCountdownBar(listOf(weekly()), Instant.parse("2026-07-27T15:30:00Z")))
    }

    @Test
    fun `shows completion text for one minute and then hides`() {
        val completed =
            resolveCountdownBar(listOf(oneTime()), Instant.parse("2026-07-27T16:00:30Z"))
        assertEquals("", completed?.message)
        assertEquals("Lunch is over", completed?.value)
        assertNull(resolveCountdownBar(listOf(oneTime()), Instant.parse("2026-07-27T16:01:01Z")))
    }

    @Test
    fun `shows confetti briefly at zero without keeping an empty bar visible`() {
        val plugin = oneTime(completionText = "", showConfetti = true)
        val celebrating =
            resolveCountdownBar(listOf(plugin), Instant.parse("2026-07-27T16:00:04Z"))
        assertEquals(true, celebrating?.completed)
        assertEquals(false, celebrating?.showBar)
        assertEquals(true, celebrating?.showConfetti)
        assertEquals(
            true,
            resolveCountdownBar(listOf(plugin), Instant.parse("2026-07-27T16:00:09Z"))?.showConfetti,
        )
        assertNull(resolveCountdownBar(listOf(plugin), Instant.parse("2026-07-27T16:00:13Z")))
    }

    @Test
    fun `selects the highest priority active instance`() {
        val low = weekly(priority = 1, message = "Low")
        val high = weekly(priority = 50, message = "High", displayMode = "push", id = "bar-2")
        val active = resolveCountdownBar(listOf(low, high), Instant.parse("2026-07-27T15:50:00Z"))
        assertEquals("bar-2", active?.id)
        assertEquals("High", active?.message)
        assertEquals("push", active?.displayMode)
    }

    @Test
    fun `applies the persisted server clock offset`() {
        val active = resolveCountdownBar(
            listOf(weekly()),
            Instant.parse("2026-07-27T15:45:00Z"),
            clockOffsetSeconds = 5 * 60,
        )
        assertEquals("10m 0s", active?.value)
    }

    @Test
    fun `reports no fill fraction unless the instance opts in`() {
        val active = resolveCountdownBar(listOf(weekly()), Instant.parse("2026-07-27T15:50:00Z"))
        assertNull(active?.remainingFraction)
    }

    @Test
    fun `drains the fill across the lead window`() {
        val plugin = weekly(progressFill = "drain")
        fun at(iso: String) =
            resolveCountdownBar(listOf(plugin), Instant.parse(iso))?.remainingFraction
        assertEquals(1f, at("2026-07-27T15:45:00Z")!!, 0.001f)
        assertEquals(2f / 3f, at("2026-07-27T15:50:00Z")!!, 0.001f)
        assertEquals(0.5f, at("2026-07-27T15:52:30Z")!!, 0.001f)
        assertEquals(1f / 900f, at("2026-07-27T15:59:59Z")!!, 0.001f)
    }

    @Test
    fun `holds the fill at empty while completion text shows`() {
        val active =
            resolveCountdownBar(listOf(oneTime(progressFill = "drain")), Instant.parse("2026-07-27T16:00:30Z"))
        assertEquals("Lunch is over", active?.value)
        assertEquals(0f, active?.remainingFraction!!, 0.001f)
    }

    @Test
    fun `keeps the target at local noon across a daylight saving change`() {
        // 2026-11-01 is the US fall-back Sunday; the following Monday is standard time.
        val plugin = weekly()
        val summer = resolveCountdownBar(listOf(plugin), Instant.parse("2026-10-26T15:50:00Z"))
        val winter = resolveCountdownBar(listOf(plugin), Instant.parse("2026-11-02T16:50:00Z"))
        assertEquals(Instant.parse("2026-10-26T16:00:00Z"), summer?.targetAt)
        assertEquals(Instant.parse("2026-11-02T17:00:00Z"), winter?.targetAt)
    }

    @Test
    fun `ignores plugins of another type or version`() {
        val other = weekly().copy(type = "something_else")
        val future = weekly().copy(version = 2)
        assertNull(resolveCountdownBar(listOf(other, future), Instant.parse("2026-07-27T15:50:00Z")))
    }

    @Test
    fun `defaults padding and type size to the original appearance`() {
        val active = resolveCountdownBar(listOf(weekly()), Instant.parse("2026-07-27T15:50:00Z"))
        // 72 height * 0.42 = 30.24, inside the 22..72 clamp, at 100 percent.
        assertEquals(4, active?.contentPadding)
        assertEquals(30.24f, active!!.fontSizeSp, 0.01f)
    }

    @Test
    fun `applies a custom padding and text scale`() {
        val active = resolveCountdownBar(
            listOf(weekly(contentPadding = 0, textScale = 200)),
            Instant.parse("2026-07-27T15:50:00Z"),
        )
        assertEquals(0, active?.contentPadding)
        assertEquals(60.48f, active!!.fontSizeSp, 0.01f)
    }

    @Test
    fun `advances through urgency stages and recompacts completion text`() {
        val plugin = weekly(urgencyEnabled = true)
        assertEquals(
            "normal",
            resolveCountdownBar(listOf(plugin), Instant.parse("2026-07-27T15:54:59Z"))?.urgencyStage,
        )
        assertEquals(
            "starting_soon",
            resolveCountdownBar(listOf(plugin), Instant.parse("2026-07-27T15:55:00Z"))?.urgencyStage,
        )
        assertEquals(
            "urgent",
            resolveCountdownBar(listOf(plugin), Instant.parse("2026-07-27T15:59:00Z"))?.urgencyStage,
        )
        val final = resolveCountdownBar(listOf(plugin), Instant.parse("2026-07-27T15:59:50Z"))
        assertEquals("final", final?.urgencyStage)
        assertEquals(true, final?.pulse)
        assertEquals(90, final?.heightPx)
        val completed = resolveCountdownBar(listOf(plugin), Instant.parse("2026-07-27T16:00:10Z"))
        assertEquals("normal", completed?.urgencyStage)
        assertEquals(false, completed?.pulse)
        assertEquals(72, completed?.heightPx)
    }

    @Test
    fun `lets a scaled bar exceed the unscaled type ceiling`() {
        val tall = weekly(textScale = 300).let { it.copy(config = it.config.copy(heightPx = 320)) }
        val active = resolveCountdownBar(listOf(tall), Instant.parse("2026-07-27T15:50:00Z"))
        // The height-derived size clamps at 72, then the scale multiplies it.
        assertEquals(216f, active!!.fontSizeSp, 0.01f)
    }

    @Test
    fun `clamps padding and scale that arrive out of range`() {
        val active = resolveCountdownBar(
            listOf(weekly(contentPadding = 99, textScale = 5_000)),
            Instant.parse("2026-07-27T15:50:00Z"),
        )
        assertEquals(40, active?.contentPadding)
        assertEquals(30.24f * 5, active!!.fontSizeSp, 0.1f)
    }

    @Test
    fun `clamps an out of range height`() {
        val tall = weekly().let { it.copy(config = it.config.copy(heightPx = 999)) }
        val active = resolveCountdownBar(listOf(tall), Instant.parse("2026-07-27T15:50:00Z"))
        assertTrue(active!!.heightPx == 320)
    }
}
