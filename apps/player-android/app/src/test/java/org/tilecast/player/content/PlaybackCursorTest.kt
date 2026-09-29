package org.tilecast.player.content

import org.junit.Assert.assertEquals
import org.junit.Test
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestPlaylist
import java.time.Instant

class PlaybackCursorTest {
    @Test
    fun lateJoiningSyncGroupMemberUsesSharedItemAndOffset() {
        val item = { id: String, duration: Long ->
            ManifestItem(id, id, assetType = "image", durationMs = duration, fitMode = "contain", transition = "none", audioEnabled = false, volume = 0f, deliveryPolicy = "download")
        }
        val playlist = ManifestPlaylist("playlist", 1, "Synced", listOf(item("first", 10_000), item("second", 20_000)))
        val anchor = Instant.parse("2026-07-14T12:00:00Z")
        assertEquals(SynchronizedPlaybackStart(PlaybackCursor(1, 0), 15_000), synchronizedPlaybackStart(playlist, emptyList(), anchor, anchor.plusSeconds(25)))
        assertEquals(SynchronizedPlaybackStart(PlaybackCursor(0, 0), 5_000), synchronizedPlaybackStart(playlist, emptyList(), anchor, anchor.plusSeconds(35)))
    }

    @Test
    fun layoutItemUsesItsConfiguredDuration() {
        val item = ManifestItem(
            id = "item",
            assetId = "layout",
            assetType = "layout",
            durationMs = 45_000,
            fitMode = "contain",
            transition = "fade",
            audioEnabled = false,
            volume = 0f,
            deliveryPolicy = "stream",
            layoutId = "layout",
        )
        assertEquals(45_000, effectiveDurationMs(item, emptyList()))
    }
}
