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

    @Test
    fun zeroDurationIsUnsetNotAOneMillisecondSlot() {
        val image = ManifestItem(
            id = "item",
            assetId = "asset",
            assetType = "image",
            durationMs = 0,
            fitMode = "contain",
            transition = "none",
            audioEnabled = false,
            volume = 0f,
            deliveryPolicy = "download",
        )
        // A one-millisecond slot rolls a synchronized cycle over every
        // millisecond. Linux and Edge read zero as unset, and so must this.
        assertEquals(10_000, effectiveDurationMs(image, emptyList()))
        assertEquals(10_000, effectiveDurationMs(image.copy(durationMs = -5), emptyList()))
    }

    @Test
    fun activityExpectsNoDurationForIndefiniteOrZeroDurationItems() {
        val item = ManifestItem(
            id = "item",
            assetId = "asset",
            assetType = "image",
            durationMs = 0,
            fitMode = "contain",
            transition = "none",
            audioEnabled = false,
            volume = 0f,
            deliveryPolicy = "download",
        )
        assertEquals(null, item.expectedDurationForActivity())
        assertEquals(null, item.copy(durationMs = Long.MAX_VALUE).expectedDurationForActivity())
        assertEquals(null, item.copy(durationMs = null).expectedDurationForActivity())
        assertEquals(12_000L, item.copy(durationMs = 12_000).expectedDurationForActivity())
    }
}
